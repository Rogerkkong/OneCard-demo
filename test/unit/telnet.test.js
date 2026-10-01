import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createLineReader, startConsoleServer, MAX_LINE_BYTES } from '../../src/lab/telnet.js';
import { createLab } from '../../src/lab/lab.js';
import { waitFor } from '../helpers.js';

// The console server for PuTTY / telnet / nc (DESIGN §8), spoken to with raw sockets.
// Telnet bytes: IAC 255, DONT 254, DO 253, WONT 252, WILL 251, SB 250, SE 240;
// options: ECHO 1, SUPPRESS-GO-AHEAD 3, TERMINAL-TYPE 24, NAWS 31.

const NET = { timeout: 30_000 };
const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
const ECHO = 1;
const SGA = 3;
const TTYPE = 24;
const NAWS = 31;

/** A reader that records what it hands on. */
function reader() {
  const got = { lines: [], replies: [], interrupts: 0, eofs: 0, tooLong: 0 };
  const r = createLineReader({
    line: (t) => got.lines.push(t),
    reply: (b) => got.replies.push([...b]),
    interrupt: () => (got.interrupts += 1),
    eof: () => (got.eofs += 1),
    tooLong: () => (got.tooLong += 1),
  });
  const push = (...parts) => {
    for (const p of parts) r.push(typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p));
  };
  return { got, push };
}

describe('the line reader', () => {
  test('CR, LF, CRLF and CR NUL each end one line, also when split across chunks', () => {
    const { got, push } = reader();
    push('one\r', 'two\n', 'three\r\n', 'four\r\0', 'five\r');
    push('\nsix\r', '\n');
    push('\n'); // a bare LF after a finished line is an empty line
    assert.deepEqual(got.lines, ['one', 'two', 'three', 'four', 'five', 'six', '']);
  });

  test('backspace and DEL remove the last character, a whole UTF-8 one too', () => {
    const { got, push } = reader();
    push('machx\x7fines\r\n', 'helq\bp\n', 'café\x7fe\n', '\x7f\x7fok\n');
    assert.deepEqual(got.lines, ['machines', 'help', 'cafe', 'ok']);
  });

  test('negotiation is taken out and every DO / WILL is declined once, never agreed to', () => {
    const { got, push } = reader();
    // what PuTTY sends on connect, split anywhere, with a subnegotiation (window size) in the middle of a word
    push([IAC, DO, ECHO, IAC, WILL, NAWS], [IAC], [WILL, SGA, IAC, DO], [SGA], 'he', [IAC, SB, NAWS, 0, 80, 0], [24, IAC, SE], 'lp\r\n');
    push([IAC, DO, ECHO, IAC, WONT, TTYPE, IAC, DONT, ECHO, IAC, SB, TTYPE, 1, IAC, IAC, IAC, SE], '?\n');
    assert.deepEqual(got.lines, ['help', '?']);
    assert.deepEqual(got.replies, [[IAC, WONT, ECHO], [IAC, DONT, NAWS], [IAC, DONT, SGA], [IAC, WONT, SGA]]);
    assert.ok(got.replies.every(([, verb]) => verb === WONT || verb === DONT), 'the server never says WILL or DO');
  });

  test('IAC IAC is a literal byte, other telnet commands carry nothing, Ctrl-C drops the line, Ctrl-D on an empty line ends', () => {
    const { got, push } = reader();
    push([0x61, IAC, IAC, 0x62, 0x0a]);
    push([IAC, 241], 'nop\n'); // IAC NOP
    push('half a com', [0x03], 'help\n');
    push('typed', [0x04], '\n'); // Ctrl-D only counts on an empty line
    push([0x04]);
    assert.deepEqual(got.lines.map((l) => Buffer.from(l, 'utf8').length), [Buffer.from('a�b', 'utf8').length, 3, 4, 5]);
    assert.deepEqual(got.lines.slice(1), ['nop', 'help', 'typed']);
    assert.equal(got.interrupts, 1);
    assert.equal(got.eofs, 1);
  });

  test('a line longer than the limit is dropped whole, and the next one is read normally', () => {
    const { got, push } = reader();
    push('x'.repeat(MAX_LINE_BYTES + 10), '\r\n', 'help\r\n');
    assert.deepEqual(got.lines, ['help']);
    assert.equal(got.tooLong, 1);
  });
});

/** A raw client: everything received, and helpers to wait for text. */
async function client(port) {
  const socket = net.connect(port, '127.0.0.1');
  const received = [];
  let ended = false;
  socket.on('data', (d) => received.push(...d));
  socket.on('error', () => {});
  socket.on('close', () => {
    ended = true;
  });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const text = () => Buffer.from(received).toString('utf8');
  return {
    socket,
    bytes: () => [...received],
    text,
    clear: () => {
      received.length = 0;
    },
    get ended() {
      return ended;
    },
    send: (data) => socket.write(typeof data === 'string' ? data : Buffer.from(data)),
    until: (what, message = JSON.stringify(what)) => waitFor(() => (typeof what === 'string' ? text().includes(what) : what.test(text())), { message }),
  };
}

/** A stand-in console: echoes the command it got, knows `exit` and `connect`. */
function fakeConsole() {
  const seen = [];
  return {
    seen,
    banner: () => 'FAKE BANNER\nsecond line\n',
    prompt: (s) => (s.target ? `${s.target}>` : 'fake>'),
    async run(s, line) {
      seen.push(line);
      if (line === 'exit') return { output: 'Bye.', prompt: 'fake>', exit: true };
      if (line.startsWith('connect ')) s.target = line.slice(8);
      if (line === 'slow') await new Promise((r) => setTimeout(r, 100));
      return { output: line === '' ? '' : `ran [${line}]\nline two`, prompt: this.prompt(s) };
    },
  };
}

describe('the console server', () => {
  test('sends the banner and prompt at once, without waiting for negotiation, in CRLF lines', NET, async (t) => {
    const shell = fakeConsole();
    const server = await startConsoleServer(null, { port: 0, console: shell });
    t.after(() => server.close());
    const c = await client(server.port);
    t.after(() => c.socket.destroy());
    await c.until('fake> ');
    assert.equal(c.text(), 'FAKE BANNER\r\nsecond line\r\n\r\nfake> ');
  });

  test('declines negotiation (never WILL ECHO or WILL SUPPRESS-GO-AHEAD) and never echoes what is typed', NET, async (t) => {
    const shell = fakeConsole();
    const server = await startConsoleServer(null, { port: 0, console: shell });
    t.after(() => server.close());
    const c = await client(server.port);
    t.after(() => c.socket.destroy());
    await c.until('fake> ');
    c.clear();
    c.send([IAC, DO, ECHO, IAC, WILL, NAWS, IAC, DO, SGA, IAC, WILL, TTYPE, IAC, SB, NAWS, 0, 120, 0, 40, IAC, SE]);
    await waitFor(() => c.bytes().length >= 12, { message: 'four answers' });
    assert.deepEqual(c.bytes(), [IAC, WONT, ECHO, IAC, DONT, NAWS, IAC, WONT, SGA, IAC, DONT, TTYPE]);
    c.clear();
    // typing, one character at a time as a terminal in character mode would: nothing comes back
    for (const ch of 'mach') c.send(ch);
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(c.bytes(), [], 'typed characters must not be echoed');
    c.send('ines\r\n');
    await c.until('fake> ');
    assert.equal(c.text(), 'ran [machines]\r\nline two\r\nfake> ');
    assert.ok(!c.bytes().some((b, i) => b === IAC && (c.bytes()[i + 1] === WILL || c.bytes()[i + 1] === DO)));
    assert.deepEqual(shell.seen, ['machines']);
  });

  test('runs lines one after another, an empty line just shows the prompt again, and each connection is its own session', NET, async (t) => {
    const shell = fakeConsole();
    const server = await startConsoleServer(null, { port: 0, console: shell });
    t.after(() => server.close());
    const a = await client(server.port);
    const b = await client(server.port);
    t.after(() => {
      a.socket.destroy();
      b.socket.destroy();
    });
    await a.until('fake> ');
    await b.until('fake> ');
    a.clear();
    b.clear();
    a.send('slow\r\nconnect smk-contoh/CANTEEN-01\r\n\r\n');
    await a.until(/(smk-contoh\/CANTEEN-01> ){2}$/);
    assert.equal(a.text(), 'ran [slow]\r\nline two\r\nfake> ran [connect smk-contoh/CANTEEN-01]\r\nline two\r\nsmk-contoh/CANTEEN-01> smk-contoh/CANTEEN-01> ');
    b.send('who\n');
    await b.until('fake> ');
    assert.equal(b.text(), 'ran [who]\r\nline two\r\nfake> ', 'the other session is still at the top');
  });

  test('exit ends the session cleanly, and close() ends every other one', NET, async (t) => {
    const shell = fakeConsole();
    const server = await startConsoleServer(null, { port: 0, console: shell });
    const a = await client(server.port);
    const b = await client(server.port);
    await a.until('fake> ');
    a.send('exit\r\n');
    await waitFor(() => a.ended, { message: 'the server to close the session' });
    assert.match(a.text(), /Bye\.\r\n$/);
    await b.until('fake> ');
    await server.close();
    await waitFor(() => b.ended, { message: 'close() to end the other session' });
    await assert.rejects(client(server.port), 'no longer listening');
  });
});

describe('a real lab over telnet', () => {
  test('banner, machines, connect, show status, a sale and exit, like PuTTY in Telnet mode', NET, async (t) => {
    const lab = createLab({ clockMode: 'manual', httpPort: 0, mqttPort: 0, consolePort: 0, jobsMs: 0, log: () => {} });
    const urls = await lab.start();
    t.after(() => lab.stop());
    assert.equal(urls.consoleAddress, undefined, 'consolePort 0 turns the consoles off');
    const server = await startConsoleServer(lab, { port: 0 });
    t.after(() => server.close());
    const c = await client(server.port);
    t.after(() => c.socket.destroy());
    await c.until('onecard> ');
    assert.match(c.text(), /^OneCard Lab: consoles of the virtual machines and the virtual cloud server\r\n/);
    assert.match(c.text(), /Lab data only: every school, person, card and key here is fictional\.\r\n/);
    c.clear();
    // PuTTY's opening negotiation, then a command typed in its local line editor
    c.send([IAC, WILL, NAWS, IAC, WILL, TTYPE, IAC, DO, ECHO, IAC, DO, SGA, IAC, WILL, SGA]);
    c.send('machines\r\n');
    await c.until('onecard> ');
    assert.match(c.text(), /SCHOOL {7}MACHINE {5}TYPE {5}CABLE {2}LINK {2}VERSIONS {2}UNSENT {2}LOCATION\r\n/);
    assert.match(c.text(), /smk-contoh {3}CANTEEN-01 {2}CANTEEN {2}in {5}up {4}P1 S1 B1 {2}0 {7}Canteen counter A\r\n/);
    assert.ok(!c.text().includes('machines\r\n'), 'the command itself is not echoed');
    c.clear();
    c.send('connect smk-contoh/CANTEEN-01\r\n');
    await c.until('smk-contoh/CANTEEN-01> ');
    c.clear();
    c.send('show status\r\n');
    await c.until('smk-contoh/CANTEEN-01> ');
    assert.match(c.text(), /^smk-contoh\/CANTEEN-01 {2}canteen reader {2}Canteen counter A\r\n/);
    c.clear();
    c.send('tap 04A13B5C7D2E80 NASI-LEMAK TEH-TARIK\r\n');
    await c.until('smk-contoh/CANTEEN-01> ');
    assert.match(c.text(), /^Screen: Paid RM 5\.30 · Balance RM 24\.70\r\n/);
    c.clear();
    c.send('exit\r\n');
    await c.until('onecard> ');
    c.send('exit\r\n');
    await waitFor(() => c.ended, { message: 'exit at the top to end the session' });
    assert.match(c.text(), /Bye\.\r\n$/);
  });
});
