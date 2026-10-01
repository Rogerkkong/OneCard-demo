import { LabError } from '../../shared/errors.js';
import { createConsole, MAX_INPUT } from '../../lab/console.js';

// The lab console's API (docs/DESIGN.md §7, Lab row; §8). These routes operate the virtual
// hardware and the virtual cloud server, so they need no session (auth 'none') and stay up
// while the cloud server is switched off: they are the lab, not the product. The live event
// stream (GET /api/lab/events) belongs to server.js.

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The JSON body as an object; a missing body is {} (every field is checked by the lab). */
function bodyOf(req) {
  if (req.body === undefined || req.body === null || req.body === '') return {};
  if (!isPlainObject(req.body)) throw new LabError('BODY_INVALID', 'the request body must be a JSON object', 400);
  return req.body;
}

/** A file name for the downloaded USB export: school, machine and lab time, safe characters only. */
function exportFileName(file) {
  const stamp = String(file.exportedAt ?? '').replace(/[^0-9]/g, '').slice(0, 12);
  return `${file.school}-${file.device}-journal-${stamp || 'export'}.json`.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * @param {{ lab: object }} deps  `lab` from createLab()
 * @returns {Array<{ method: string, path: string, auth: 'none', handler: Function }>}
 */
export function routes({ lab }) {
  const shell = createConsole(lab);
  const route = (method, path, handler) => ({ method, path, auth: 'none', handler });

  return [
    route('GET', '/api/lab/state', () => lab.state()),

    // tap a card: { schoolCode, deviceCode, uid, items? (canteen), ml? (water), fault? (kiosk), cardSchoolCode? }
    route('POST', '/api/lab/tap', (req) => lab.tap(bodyOf(req))),

    // plug or pull a machine's network cable: { schoolCode, deviceCode, plugged }
    route('POST', '/api/lab/cable', (req) => lab.setCable(bodyOf(req))),

    // the admin card: { schoolCode, deviceCode? } (load and upload at the school's kiosk; tap on a machine)
    route('POST', '/api/lab/admin-card/load', (req) => lab.adminCardLoad(bodyOf(req))),
    route('POST', '/api/lab/admin-card/tap', (req) => lab.adminCardTap(bodyOf(req))),
    route('POST', '/api/lab/admin-card/upload', (req) => lab.adminCardUpload(bodyOf(req))),

    // the machine's journal file, as the browser downloads it: { schoolCode, deviceCode }
    route('POST', '/api/lab/usb/export', (req) => {
      const file = lab.exportUsb(bodyOf(req));
      return { status: 200, body: file, headers: { 'content-disposition': `attachment; filename="${exportFileName(file)}"` } };
    }),

    // { type, ...that fault's fields } (DESIGN §8 "Faults")
    route('POST', '/api/lab/fault', (req) => lab.fault(bodyOf(req))),

    // { ms }
    route('POST', '/api/lab/clock/advance', (req) => lab.advanceClock(bodyOf(req).ms)),

    // the scheduled jobs, now (the lab clock panel's "run jobs now")
    route('POST', '/api/lab/jobs/run', () => lab.runJobs()),

    // a fresh demo, without restarting the process
    route('POST', '/api/lab/reset', () => lab.reset()),

    // the virtual cloud server: { up }
    route('POST', '/api/lab/server', (req) => lab.setServer({ up: bodyOf(req).up })),
    route('POST', '/api/lab/broker/restart', () => lab.restartBroker()),

    // the web Console tab: { line, target } -> { output, target, prompt } (the page keeps the target)
    route('POST', '/api/lab/console', async (req) => {
      const { line, target = null } = bodyOf(req);
      if (typeof line !== 'string' || line.length > MAX_INPUT) {
        throw new LabError('INPUT_INVALID', `line must be text of at most ${MAX_INPUT} characters`, 400);
      }
      if (target !== null && (typeof target !== 'string' || target.length > 100)) {
        throw new LabError('INPUT_INVALID', "target must be null, 'server' or '<school>/<DEVICE>'", 400);
      }
      const session = { target };
      const answer = await shell.run(session, line);
      const out = { output: answer.output, target: session.target, prompt: answer.prompt };
      if (answer.exit) out.exit = true;
      return out;
    }),
  ];
}
