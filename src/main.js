// Start the whole lab: platform, MQTT broker, virtual machines and the web apps.
//
//   npm start
//
// Settings (environment variables):
//   LAB_HTTP_PORT   web apps and APIs (default 8080)
//   LAB_MQTT_PORT   MQTT broker (default 1883)
//   LAB_HOST        address to listen on (default 127.0.0.1, this computer only)
//   LAB_CONSOLE_PORT  machine and server consoles for PuTTY/telnet (default 2323, 0 = off)
//   LAB_MQTT_TLS_CERT, LAB_MQTT_TLS_KEY, LAB_MQTT_TLS_PORT (default 8883)
//                   optional TLS listener; make lab certificates with scripts/make-lab-certs.sh
import { readFileSync } from 'node:fs';
import { createLab } from './lab/lab.js';

const env = process.env;

function port(name, fallback) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    console.error(`${name} must be a port number, got ${env[name]}`);
    process.exit(1);
  }
  return value;
}

const options = {
  httpPort: port('LAB_HTTP_PORT', 8080),
  mqttPort: port('LAB_MQTT_PORT', 1883),
  consolePort: port('LAB_CONSOLE_PORT', 2323),
  host: env.LAB_HOST || '127.0.0.1',
};

if (env.LAB_MQTT_TLS_CERT || env.LAB_MQTT_TLS_KEY) {
  if (!env.LAB_MQTT_TLS_CERT || !env.LAB_MQTT_TLS_KEY) {
    console.error('Set both LAB_MQTT_TLS_CERT and LAB_MQTT_TLS_KEY, or neither.');
    process.exit(1);
  }
  options.tls = {
    port: port('LAB_MQTT_TLS_PORT', 8883),
    cert: readFileSync(env.LAB_MQTT_TLS_CERT, 'utf8'),
    key: readFileSync(env.LAB_MQTT_TLS_KEY, 'utf8'),
  };
}

const lab = createLab(options);
const started = await lab.start();
const viewer = lab.ctx.settings.viewer;
const mqttPortShown = new URL(started.mqttUrl).port;

console.log(`
OneCard Lab is running (lab data only — nothing here is real).

  Lab console     ${started.httpUrl}/lab/
  School office   ${started.httpUrl}/admin/
  Parent app      ${started.httpUrl}/parent/

  MQTT broker     ${started.mqttUrl}${started.mqttTlsUrl ? `\n  MQTT over TLS   ${started.mqttTlsUrl}` : ''}
  Read-only login ${viewer.username} / ${viewer.password}
  Watch traffic   mosquitto_sub -h 127.0.0.1 -p ${mqttPortShown} -u ${viewer.username} -P ${viewer.password} -t 'lab/v1/#' -v
                  (or MQTT Explorer with the same login)
${started.consoleAddress ? `
  Machine consoles PuTTY (Telnet) or: telnet ${started.consoleAddress.replace(':', ' ')}
                  then: machines · connect smk-contoh/CANTEEN-01 · show status
` : ''}${options.host !== '127.0.0.1' && options.host !== 'localhost' ? `
  Note: listening on ${options.host}. Other computers on your network can reach the lab,
  and the lab has no passwords. Only do this on a network you trust.
` : ''}
Press Ctrl+C to stop.`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping the lab…');
  try {
    await lab.stop();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
