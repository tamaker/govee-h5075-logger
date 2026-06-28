// collector.js — Govee H5075 BLE advertisement logger (macOS primary)
// Long-running: appends one throttled reading per device to a per-day JSON file.
// Output: ../logs/readings-YYYY-MM-DD.json  (local date), one JSON array per day.
// Run the demo first (node demo.js) to discover your device names, then label them in .env.
'use strict';

const noble = require('@abandonware/noble');
const path = require('path');
const { decodeH5075 } = require('./govee');
const { loadEnvNames, appendReading, buildReading } = require('./store');

const SAMPLE_INTERVAL_MS = 60_000; // min ms between logged samples per device
const LOG_DIR = path.join(__dirname, '..', 'logs');
const ENV_PATH = path.join(__dirname, '..', '.env');

// Custom names come from an optional root .env file (KEY=VALUE). Any device not
// listed falls back to its raw advertised name. See .env.example.
const CUSTOM_NAMES = loadEnvNames(ENV_PATH);

const lastLogged = new Map();

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

  const reading = buildReading(now, name, CUSTOM_NAMES[name], decoded, peripheral.rssi);
  appendReading(LOG_DIR, reading);
  console.log(
    `${reading.timestamp_local}  ${reading.custom_name.padEnd(16)} ` +
    `${reading.temp_c.toFixed(1)}°C / ${reading.temp_f.toFixed(1)}°F` +
    `  ${reading.humidity_pct.toFixed(1)}%  batt ${reading.battery_pct}%  rssi ${reading.rssi}`
  );
});
