// Start the whole lab: platform, MQTT broker, virtual machines and the web apps.
//
//   npm start             this computer only
//   npm run start:lan     also reachable from phones and computers on your network (--lan)
//   npm start -- --open   and open the lab console in the web browser (the double-click
//                         launchers do this)
//   npm start -- --help   every option and setting
//
// Settings (environment variables):
//   LAB_HTTP_PORT   web apps and APIs (default 8080)
//   LAB_MQTT_PORT   MQTT broker (default 1883)
//   LAB_HOST        address to listen on (default 127.0.0.1, this computer only; --lan means 0.0.0.0)
//   LAB_CONSOLE_PORT  machine and server consoles for PuTTY/telnet (default 2323, 0 = off)
//   LAB_ALLOWED_HOSTS host names the web apps answer to besides localhost and IP addresses
//                   (comma-separated, e.g. mylaptop.local; * turns the check off)
//   LAB_MQTT_TLS_CERT, LAB_MQTT_TLS_KEY, LAB_MQTT_TLS_PORT (default 8883)
//                   optional TLS listener; make lab certificates with scripts/make-lab-certs.sh
//
// The work is in src/cli.js, which the single-file desktop app (src/app/sea-main.js) runs too.
// This file only checks the Node.js version first, in syntax that old versions still read
// (no top-level await), so they print a plain message instead of failing on a newer feature.

// Checked before anything loads node:sqlite, which older versions do not have.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`OneCard Lab needs Node.js 22.13 or newer; this computer has ${process.versions.node}.
Install the LTS version from https://nodejs.org/ and run npm start again.`);
  process.exit(1);
}

import('./cli.js').then(({ main }) => main(process.argv.slice(2), process.env));
