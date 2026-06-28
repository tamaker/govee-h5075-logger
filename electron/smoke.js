// smoke.js — headless Electron check: confirm noble's native module loads under
// Electron's ABI and that store/govee require cleanly. Exits non-zero on failure.
// Run: npx electron smoke.js   (no window is shown)
'use strict';

const { app } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const out = { ok: true, checks: {} };
  try {
    const NODE_DIR = path.join(__dirname, '..', 'node');
    const { decodeH5075 } = require(path.join(NODE_DIR, 'govee'));
    const store = require(path.join(NODE_DIR, 'store'));
    out.checks.govee = typeof decodeH5075 === 'function';
    out.checks.store = typeof store.buildReading === 'function';

    let noble;
    try {
      noble = require(path.join(NODE_DIR, 'node_modules', '@abandonware', 'noble'));
    } catch {
      noble = require('@abandonware/noble');
    }
    out.checks.nobleLoaded = !!noble;
    out.checks.nobleState = noble.state;
    out.electron = process.versions.electron;
    out.node = process.versions.node;
  } catch (e) {
    out.ok = false;
    out.error = e.message;
  }
  console.log('SMOKE_RESULT ' + JSON.stringify(out));
  app.exit(out.ok ? 0 : 1);
});
