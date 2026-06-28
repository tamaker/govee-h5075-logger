// store.js — shared persistence helpers for the Govee H5075 logger.
// Used by both the CLI collector (collector.js) and the Electron app, so the
// timestamp format, per-day JSON log, and name handling stay identical.
'use strict';

const fs = require('fs');
const path = require('path');

// Local date/time parts: "2026-06-25", "14:03:22", "2026-06-25 14:03:22".
function localParts(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { date, time, datetime: `${date} ${time}` };
}

// Parse a KEY=VALUE .env file into a {device_name: custom_name} map.
// Blank lines and #comments are ignored. Missing file → {}.
function loadEnvNames(envPath) {
  const names = {};
  if (!fs.existsSync(envPath)) return names;
  try {
    for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key) names[key] = val;
    }
  } catch (e) {
    console.warn(`Could not read ${envPath} (${e.message}).`);
  }
  return names;
}

// Append one reading object to its per-day JSON file (valid array, atomic write).
function appendReading(logDir, reading) {
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, `readings-${reading.date}.json`);

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
  return file;
}

// Build a normalized reading object from a decoded advertisement.
function buildReading(now, deviceName, customName, decoded, rssi) {
  const when = localParts(new Date(now));
  return {
    timestamp_local: when.datetime,
    date: when.date,
    time: when.time,
    epoch: Math.floor(now / 1000),
    device_name: deviceName,
    custom_name: customName || deviceName,
    temp_c: Number(decoded.tempC.toFixed(2)),
    temp_f: Number(decoded.tempF.toFixed(2)),
    humidity_pct: Number(decoded.humidity.toFixed(1)),
    battery_pct: decoded.battery,
    rssi,
  };
}

// names.json — the GUI's source of truth for custom names: {device_name: custom_name}.
function loadNames(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function saveNames(file, names) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(names, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return file;
}

// Write a map of names out to a .env file the CLI collector can consume.
function exportNamesToEnv(envPath, names) {
  const lines = [
    '# Sensor names — managed by the Govee H5075 Electron app.',
    '# Format: <device_name>=<custom_name>',
    '',
  ];
  for (const [dev, name] of Object.entries(names)) {
    if (name && name !== dev) lines.push(`${dev}=${name}`);
  }
  fs.writeFileSync(envPath, lines.join('\n') + '\n');
  return envPath;
}

module.exports = {
  localParts,
  loadEnvNames,
  appendReading,
  buildReading,
  loadNames,
  saveNames,
  exportNamesToEnv,
};
