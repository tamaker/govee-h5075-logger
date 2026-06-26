// collector.js — Govee H5075 BLE advertisement logger (macOS primary)
// Long-running: appends one throttled reading per device to a per-day JSON file.
// Output: ../logs/readings-YYYY-MM-DD.json  (local date), one JSON array per day.
// Run the demo first (node demo.js) to discover your device names, then label them below.
'use strict';

const noble = require('@abandonware/noble');
const fs = require('fs');
const path = require('path');
const { decodeH5075 } = require('./govee');

const SAMPLE_INTERVAL_MS = 60_000; // min ms between logged samples per device
const LOG_DIR = path.join(__dirname, '..', 'logs');
const ENV_PATH = path.join(__dirname, '..', '.env');

// Custom names per device come from an optional root .env file, e.g.:
//   GVH5075_1098=downstairs
// Lines are KEY=VALUE; blank lines and #comments are ignored. The file is optional —
// any device not listed falls back to its raw advertised name (e.g. "GVH5075_1098").
// Run `node demo.js` to discover your own device names, then copy .env.example to .env.
function loadEnvNames() {
  const names = {};
  if (!fs.existsSync(ENV_PATH)) return names;
  try {
    for (const raw of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, ''); // strip wrapping quotes
      if (key) names[key] = val;
    }
  } catch (e) {
    console.warn(`Could not read .env (${e.message}); using default names.`);
  }
  return names;
}

const CUSTOM_NAMES = loadEnvNames();

const lastLogged = new Map();

// Local date/time parts: "2026-06-25", "14:03:22", "2026-06-25 14:03:22".
function localParts(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { date, time, datetime: `${date} ${time}` };
}

// Append one reading object to today's JSON file (valid JSON array, written atomically).
function appendReading(reading) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `readings-${reading.date}.json`);

  let arr = [];
  if (fs.existsSync(file)) {
    try {
      arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(arr)) arr = [];
    } catch {
      arr = []; // corrupt/partial file — start fresh rather than crash
    }
  }
  arr.push(reading);

  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, file); // atomic swap so a crash never leaves a half-written file
}

noble.on('stateChange', async (state) => {
  if (state === 'poweredOn') {
    console.log('BLE powered on — scanning (duplicates allowed)…');
    console.log(`Logging to ${LOG_DIR}/readings-<local-date>.json (one file per day).`);
    await noble.startScanningAsync([], true); // [] = all services, true = allow duplicates
  } else {
    console.log(`BLE state: ${state} — stopping scan.`);
    await noble.stopScanningAsync().catch(() => {});
  }
});

noble.on('discover', (peripheral) => {
  const name = peripheral.advertisement.localName;
  if (!name || !name.startsWith('GVH507')) return; // name filter (macOS-safe)

  const decoded = decodeH5075(peripheral.advertisement.manufacturerData);
  if (!decoded) return;

  const now = Date.now();
  if (now - (lastLogged.get(name) || 0) < SAMPLE_INTERVAL_MS) return; // per-device throttle
  lastLogged.set(name, now);

  const when = localParts(new Date(now));
  const reading = {
    timestamp_local: when.datetime,
    date: when.date,
    time: when.time,
    epoch: Math.floor(now / 1000),
    device_name: name,
    custom_name: CUSTOM_NAMES[name] || name,
    temp_c: Number(decoded.tempC.toFixed(2)),
    temp_f: Number(decoded.tempF.toFixed(2)),
    humidity_pct: Number(decoded.humidity.toFixed(1)),
    battery_pct: decoded.battery,
    rssi: peripheral.rssi,
  };

  appendReading(reading);
  console.log(
    `${reading.timestamp_local}  ${reading.custom_name.padEnd(16)} ` +
    `${reading.temp_c.toFixed(1)}°C / ${reading.temp_f.toFixed(1)}°F` +
    `  ${reading.humidity_pct.toFixed(1)}%  batt ${reading.battery_pct}%  rssi ${reading.rssi}`
  );
});
