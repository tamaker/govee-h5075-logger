// main.js — Electron main process for the Govee H5075 desktop dashboard.
// Runs the BLE scan in the Node main process and streams live readings to the
// renderer over IPC. Manages custom names (names.json) and per-day JSON logging.
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Reuse the proven decoder + persistence helpers from the CLI side.
// Dev: load straight from ../node. Packaged: electron-builder copies these into
// Resources/shared (see build.extraResources in package.json).
const NODE_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'shared')
  : path.join(__dirname, '..', 'node');
const { decodeH5075 } = require(path.join(NODE_DIR, 'govee'));
const store = require(path.join(NODE_DIR, 'store'));

// User-writable data. Dev: project root (stays in sync with the CLI). Packaged:
// the OS per-user app-data dir, since the app bundle itself is read-only.
const DATA_DIR = app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..');
const NAMES_PATH = path.join(DATA_DIR, 'names.json');
const ENV_PATH = path.join(DATA_DIR, '.env');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

let noble = null;
let nobleError = null;
let win = null;

let names = store.loadNames(NAMES_PATH);
// Seed names.json from .env on first run so GUI and CLI start in sync.
if (Object.keys(names).length === 0) {
  const fromEnv = store.loadEnvNames(ENV_PATH);
  if (Object.keys(fromEnv).length) {
    names = fromEnv;
    store.saveNames(NAMES_PATH, names);
  }
}

const DEFAULT_SETTINGS = {
  logging: false,
  sampleIntervalMs: 60000,
  unit: 'C',
  tempMinC: null,
  tempMaxC: null,
  humMin: null,
  humMax: null,
  batteryMin: 20,
};
let settings = loadSettings();

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.warn('Could not save settings:', e.message);
  }
}

const lastLogged = new Map(); // device_name -> epoch ms of last logged sample

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function startScanning() {
  if (!noble) return;
  noble.startScanningAsync([], true).catch((e) => send('ble-state', { state: 'error', message: e.message }));
}

function setupNoble() {
  try {
    noble = require(path.join(NODE_DIR, 'node_modules', '@abandonware', 'noble'));
  } catch (e1) {
    try {
      noble = require('@abandonware/noble');
    } catch (e2) {
      nobleError = e2.message;
      return;
    }
  }

  noble.on('stateChange', (state) => {
    send('ble-state', { state });
    if (state === 'poweredOn') startScanning();
    else noble.stopScanningAsync().catch(() => {});
  });

  noble.on('scanStart', () => send('ble-state', { state: 'scanning' }));

  noble.on('discover', (peripheral) => {
    const name = peripheral.advertisement.localName;
    if (!name || !name.startsWith('GVH507')) return;

    const decoded = decodeH5075(peripheral.advertisement.manufacturerData);
    if (!decoded) return;

    const now = Date.now();
    const reading = store.buildReading(now, name, names[name], decoded, peripheral.rssi);

    // Live stream every advertisement to the UI (no throttle for display).
    send('reading', reading);

    // Throttled persistence when logging is enabled.
    if (settings.logging) {
      const interval = settings.sampleIntervalMs || 60000;
      if (now - (lastLogged.get(name) || 0) >= interval) {
        lastLogged.set(name, now);
        try {
          const file = store.appendReading(LOG_DIR, reading);
          send('logged', { device_name: name, file: path.basename(file) });
        } catch (e) {
          send('log-error', { message: e.message });
        }
      }
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#0d1117',
    title: 'Govee H5075 Dashboard',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.on('did-finish-load', () => {
    send('init', { names, settings, nobleError, logDir: LOG_DIR });
    if (noble && noble.state === 'poweredOn') {
      send('ble-state', { state: 'poweredOn' });
      startScanning();
    }
  });
}

// ---- IPC: names management ----
ipcMain.handle('names:get', () => names);

ipcMain.handle('names:set', (_e, { device, name }) => {
  if (!device) return names;
  const clean = (name || '').trim();
  if (clean) names[device] = clean;
  else delete names[device];
  store.saveNames(NAMES_PATH, names);
  return names;
});

ipcMain.handle('names:exportEnv', () => {
  const file = store.exportNamesToEnv(ENV_PATH, names);
  return { ok: true, file };
});

// ---- IPC: settings ----
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => {
  settings = { ...settings, ...patch };
  saveSettings();
  return settings;
});

// ---- IPC: actions ----
ipcMain.handle('logs:open', () => {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  shell.openPath(LOG_DIR);
  return LOG_DIR;
});

ipcMain.handle('export:save', async (_e, { defaultName, content }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), defaultName),
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, content);
  return { ok: true, filePath };
});

app.whenReady().then(() => {
  setupNoble();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (noble) noble.stopScanningAsync().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});
