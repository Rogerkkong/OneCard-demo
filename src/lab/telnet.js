import net from 'node:net';
import { createConsole } from './console.js';

// The consoles over TCP (docs/DESIGN.md §8), for PuTTY (connection type Telnet or Raw),
// `telnet 127.0.0.1 2323` or `nc 127.0.0.1 2323`. Each connection is one console session.
//
// Telnet negotiation is stripped from the input and every request is declined: the server
// never offers WILL ECHO or WILL SUPPRESS-GO-AHEAD, and never echoes what is typed. PuTTY
// (local echo and line editing on "Auto"), telnet and nc then echo and edit the line on the
// user's side and send whole lines; a server that echoed as well would show every character
// twice. Nothing waits for negotiation: the banner goes out at once.

const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
const IP = 244; // interrupt process (Ctrl-C in telnet's command mode)

const CR = 0x0d;
const LF = 0x0a;
const NUL = 0x00;
const BS = 0x08;
const DEL = 0x7f;
const ETX = 0x03; // Ctrl-C
const EOT = 0x04; // Ctrl-D
const TAB = 0x09;

/** Longest line a session buffers, in bytes; a longer one is dropped whole. */
export const MAX_LINE_BYTES = 1000;
/** Lines a session queues while a command runs (someone pasting a script). */
const MAX_QUEUED_LINES = 100;

/**
 * Turns the raw byte stream of one connection into command lines. Telnet commands (IAC …)
 * are taken out wherever they fall, also across chunks; DO and WILL requests are answered
 * WONT and DONT once per option. CR, LF, CRLF and CR NUL each end a line; backspace and DEL
 * remove the last character.
 * @param {{ line(text: string): void, reply(bytes: Buffer): void, interrupt(): void, eof(): void, tooLong(): void }} on
 */
export function createLineReader(on) {
  let state = 'data'; // data | iac | option | sb | sb-iac
  let verb = 0;
  let afterCR = false;
  let overflow = false;
  let bytes = [];
  const answered = new Set();

  const endLine = () => {
    const text = Buffer.from(bytes).toString('utf8');
    const dropped = overflow;
    bytes = [];
    overflow = false;
    if (dropped) on.tooLong();
    else on.line(text);
  };

  const backspace = () => {
    // remove one whole UTF-8 character: continuation bytes first, then its lead byte
    while (bytes.length > 0 && (bytes.at(-1) & 0xc0) === 0x80) bytes.pop();
    bytes.pop();
  };

  const add = (b) => {
    if (bytes.length >= MAX_LINE_BYTES) overflow = true;
    else bytes.push(b);
  };

  const decline = (requestVerb, option) => {
    const key = `${requestVerb}:${option}`;
    if (answered.has(key)) return; // answering once avoids negotiation loops (RFC 854)
    answered.add(key);
    on.reply(Buffer.from([IAC, requestVerb === DO ? WONT : DONT, option]));
  };

  function data(b) {
    if (afterCR) {
      afterCR = false;
      if (b === LF || b === NUL) return; // CRLF or CR NUL: the line already ended at CR
    }
    switch (b) {
      case IAC:
        state = 'iac';
        return;
      case CR:
        afterCR = true;
        endLine();
        return;
      case LF:
        endLine();
        return;
      case BS:
      case DEL:
        backspace();
        return;
      case ETX:
        bytes = [];
        overflow = false;
        on.interrupt();
        return;
      case EOT:
        if (bytes.length === 0) on.eof();
        return;
      case TAB:
        add(0x20);
        return;
      default:
        if (b >= 0x20) add(b); // other control bytes (escape sequences of arrow keys) are dropped
    }
  }

  function push(chunk) {
    for (const b of chunk) {
      switch (state) {
        case 'data':
          data(b);
          break;
        case 'iac':
          if (b === IAC) {
            state = 'data';
            add(IAC); // IAC IAC is a literal 255
          } else if (b >= WILL && b <= DONT) {
            verb = b;
            state = 'option';
          } else if (b === SB) {
            state = 'sb';
          } else {
            state = 'data';
            if (b === IP) {
              bytes = [];
              overflow = false;
              on.interrupt();
            }
            // NOP, GA, AYT, … carry nothing a line needs
          }
          break;
        case 'option':
          if (verb === DO || verb === WILL) decline(verb, b);
          state = 'data';
          break;
        case 'sb':
          if (b === IAC) state = 'sb-iac';
          break;
        case 'sb-iac':
          state = b === SE ? 'data' : 'sb'; // IAC IAC inside a subnegotiation is data of it
          break;
        default:
          state = 'data';
      }
    }
  }

  return { push };
}

/** Plain console text as NVT output: CRLF line ends. */
function nvt(text) {
  return Buffer.from(String(text).replace(/\r?\n/g, '\r\n'), 'utf8');
}

/**
 * Start the console server.
 * @param {object} lab  the lab (createLab)
 * @param {{ host?: string, port?: number, console?: { run: Function, prompt: Function, banner: Function } }} [options]
 *   port 0 picks a free one; `console` replaces createConsole(lab) (tests)
 * @returns {Promise<{ port: number, close(): Promise<void> }>}
 */
export async function startConsoleServer(lab, { host = '127.0.0.1', port = 2323, console: shell } = {}) {
  const cli = shell ?? createConsole(lab);
  const sockets = new Set();

  function serve(socket) {
    sockets.add(socket);
    socket.setNoDelay(true);
    const session = { target: null };
    const queue = [];
    let busy = false;
    let closed = false;

    const write = (bytes) => {
      if (!closed && socket.writable) socket.write(bytes);
    };
    const showPrompt = () => write(nvt(`${cli.prompt(session)} `));
    const close = () => {
      if (closed) return;
      closed = true;
      queue.length = 0;
      socket.end();
    };

    async function pump() {
      if (busy) return;
      busy = true;
      try {
        while (queue.length > 0 && !closed) {
          const line = queue.shift();
          let answer;
          try {
            answer = await cli.run(session, line);
          } catch (err) {
            answer = { output: `% Internal error: ${err?.message ?? err}`, prompt: cli.prompt(session) };
          }
          if (answer.output) write(nvt(`${answer.output}\n`));
          if (answer.exit) {
            close();
            break;
          }
          showPrompt();
        }
      } finally {
        busy = false;
      }
    }

    const reader = createLineReader({
      line(text) {
        if (closed) return;
        if (queue.length >= MAX_QUEUED_LINES) return; // a paste far longer than any script
        queue.push(text);
        pump();
      },
      reply: (bytes) => write(bytes),
      interrupt() {
        // Ctrl-C drops what was typed, like on a switch
        if (busy) return;
        write(nvt('^C\n'));
        showPrompt();
      },
      eof: () => {
        write(nvt('Bye.\n'));
        close();
      },
      tooLong() {
        write(nvt('% Line too long.\n'));
        if (!busy) showPrompt();
      },
    });

    socket.on('data', (chunk) => {
      if (!closed) reader.push(chunk);
    });
    socket.on('error', () => {}); // a client that vanishes mid-session is not a lab error
    socket.on('close', () => {
      closed = true;
      sockets.delete(socket);
    });
    write(nvt(`${cli.banner()}\n`));
    showPrompt();
  }

  const server = net.createServer(serve);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', (err) => {
    try {
      lab?.ctx?.log?.('error', 'console server error', { error: err?.message });
    } catch {
      // a broken logger must not break the consoles
    }
  });

  let closing = null;
  return {
    port: server.address().port,
    /** Stop listening and end every session. */
    close() {
      closing ??= new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}
