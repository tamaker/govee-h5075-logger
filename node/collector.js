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

// Discovered on this Mac (2026-06-25). Add a friendly label to each, e.g. 'Living Room'.
const LABELS = {
  'GVH5075_1098': 'GVH5075_1098', // strong signal (~-53..-86 dBm)
  'GVH5075_A7A8': 'GVH5075_A7A8', // strong signal (~-62..-74 dBm)
  'GVH5075_C375': 'GVH5075_C375', // weakest / most distant (~-63..-90 dBm)
};

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
    label: LABELS[name] || name,
    temp_c: Number(decoded.tempC.toFixed(2)),
    temp_f: Number(decoded.tempF.toFixed(2)),
    humidity_pct: Number(decoded.humidity.toFixed(1)),
    battery_pct: decoded.battery,
    rssi: peripheral.rssi,
  };

  appendReading(reading);
  console.log(
    `${reading.timestamp_local}  ${reading.label.padEnd(16)} ` +
    `${reading.temp_c.toFixed(1)}°C / ${reading.temp_f.toFixed(1)}°F` +
    `  ${reading.humidity_pct.toFixed(1)}%  batt ${reading.battery_pct}%  rssi ${reading.rssi}`
  );
});
