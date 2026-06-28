// preload.js — safe IPC bridge between main and renderer.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('govee', {
  // push events from main → renderer
  onInit: (cb) => ipcRenderer.on('init', (_e, d) => cb(d)),
  onReading: (cb) => ipcRenderer.on('reading', (_e, d) => cb(d)),
  onBleState: (cb) => ipcRenderer.on('ble-state', (_e, d) => cb(d)),
  onLogged: (cb) => ipcRenderer.on('logged', (_e, d) => cb(d)),
  onLogError: (cb) => ipcRenderer.on('log-error', (_e, d) => cb(d)),

  // request/response calls renderer → main
  getNames: () => ipcRenderer.invoke('names:get'),
  setName: (device, name) => ipcRenderer.invoke('names:set', { device, name }),
  exportEnv: () => ipcRenderer.invoke('names:exportEnv'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openLogs: () => ipcRenderer.invoke('logs:open'),
  saveExport: (defaultName, content) => ipcRenderer.invoke('export:save', { defaultName, content }),
});
