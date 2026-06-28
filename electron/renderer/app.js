// app.js — renderer logic for the Govee H5075 dashboard.
'use strict';

var api = window.govee;
var devices = {};          // device_name -> { latest, history:[], el, alertState:{} }
var names = {};
var settings = {};
var allReadings = [];      // session log for CSV/JSON export
var STALE_MS = 30000;      // mark a card offline if no advert in this long
var MAX_HISTORY = 80;

var grid = document.getElementById('grid');
var emptyEl = document.getElementById('empty');

// ---------- helpers ----------
function tempDisplay(r) {
  return settings.unit === 'F' ? r.temp_f : r.temp_c;
}
function unitSym() { return settings.unit === 'F' ? '°F' : '°C'; }

function fmtAge(ms) {
  var s = Math.round(ms / 1000);
  if (s < 2) return 'now';
  if (s < 60) return s + 's ago';
  var m = Math.round(s / 60);
  return m + 'm ago';
}

function rssiBars(rssi) {
  // -50+ = 4 bars, down to <=-90 = 0/1
  if (rssi >= -55) return 4;
  if (rssi >= -67) return 3;
  if (rssi >= -78) return 2;
  if (rssi >= -88) return 1;
  return 0;
}

// ---------- card construction ----------
function makeCard(dev) {
  var card = document.createElement('div');
  card.className = 'card';
  card.innerHTML =
    '<div class="card-head">' +
      '<span class="online"></span>' +
      '<div class="name-wrap">' +
        '<div class="cust-name" contenteditable="true" spellcheck="false"></div>' +
        '<div class="dev-name"></div>' +
      '</div>' +
      '<div class="rssi"><i></i><i></i><i></i><i></i></div>' +
    '</div>' +
    '<div class="metrics">' +
      '<div><span class="temp-val">--</span><span class="temp-unit"></span></div>' +
      '<div class="hum-val">--<small>%RH</small></div>' +
    '</div>' +
    '<canvas class="spark"></canvas>' +
    '<div class="footer">' +
      '<span class="batt"><span class="batt-bar"><span class="batt-fill"></span></span><span class="batt-txt">--%</span></span>' +
      '<span class="sep"></span>' +
      '<span class="seen">—</span>' +
      '<span class="tag samples">0</span>' +
    '</div>';

  var nameEl = card.querySelector('.cust-name');
  nameEl.textContent = names[dev] || dev;
  card.querySelector('.dev-name').textContent = dev;

  // inline rename: commit on Enter or blur
  nameEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { nameEl.textContent = names[dev] || dev; nameEl.blur(); }
  });
  nameEl.addEventListener('blur', function () {
    var val = nameEl.textContent.trim();
    if (!val) val = dev;
    nameEl.textContent = val;
    if (val !== (names[dev] || dev)) {
      api.setName(dev, val === dev ? '' : val).then(function (n) {
        names = n;
        toast('ok', 'Renamed', dev + ' → ' + val);
      });
    }
  });

  grid.appendChild(card);
  return card;
}

function drawSpark(canvas, history) {
  var ctx = canvas.getContext('2d');
  var w = canvas.width = canvas.clientWidth * 2;
  var h = canvas.height = canvas.clientHeight * 2;
  ctx.clearRect(0, 0, w, h);
  if (history.length < 2) return;

  function line(getVal, color) {
    var vals = history.map(getVal);
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var range = (max - min) || 1;
    var pad = h * 0.15;
    ctx.beginPath();
    for (var i = 0; i < vals.length; i++) {
      var x = (i / (vals.length - 1)) * w;
      var y = h - pad - ((vals[i] - min) / range) * (h - pad * 2);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.stroke();
    // last-point dot
    var lastX = w, lastY = h - pad - ((vals[vals.length - 1] - min) / range) * (h - pad * 2);
    ctx.beginPath(); ctx.arc(lastX - 4, lastY, 4, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
  }
  line(function (r) { return tempDisplay(r); }, '#ff7a59');
  line(function (r) { return r.humidity_pct; }, '#38bdf8');
}

// ---------- alerts ----------
function checkAlerts(dev, r) {
  var s = settings, fired = [];
  if (s.tempMinC != null && r.temp_c < s.tempMinC) fired.push(['temp-low', 'danger', 'Temp low', r.temp_c.toFixed(1) + '°C']);
  if (s.tempMaxC != null && r.temp_c > s.tempMaxC) fired.push(['temp-high', 'danger', 'Temp high', r.temp_c.toFixed(1) + '°C']);
  if (s.humMin != null && r.humidity_pct < s.humMin) fired.push(['hum-low', 'warn', 'Humidity low', r.humidity_pct + '%']);
  if (s.humMax != null && r.humidity_pct > s.humMax) fired.push(['hum-high', 'warn', 'Humidity high', r.humidity_pct + '%']);
  if (s.batteryMin != null && r.battery_pct <= s.batteryMin) fired.push(['batt', 'warn', 'Low battery', r.battery_pct + '%']);

  var d = devices[dev];
  var label = names[dev] || dev;
  var activeKeys = {};
  fired.forEach(function (f) {
    activeKeys[f[0]] = true;
    if (!d.alertState[f[0]]) toast(f[1], f[2] + ' — ' + label, f[3]); // edge-triggered
  });
  d.alertState = activeKeys;
  return fired.length > 0;
}

// ---------- reading handler ----------
function onReading(r) {
  emptyEl.classList.add('hidden');
  var dev = r.device_name;
  if (!devices[dev]) {
    devices[dev] = { history: [], el: makeCard(dev), alertState: {}, count: 0 };
  }
  var d = devices[dev];
  d.latest = r;
  d.lastSeen = Date.now();
  d.count++;
  d.history.push(r);
  if (d.history.length > MAX_HISTORY) d.history.shift();
  allReadings.push(r);

  renderCard(dev);
  updateDeviceCount();
}

function renderCard(dev) {
  var d = devices[dev], r = d.latest, el = d.el;
  el.querySelector('.temp-val').textContent = tempDisplay(r).toFixed(1);
  el.querySelector('.temp-unit').textContent = unitSym();
  el.querySelector('.hum-val').innerHTML = r.humidity_pct.toFixed(1) + '<small>%RH</small>';

  var fill = el.querySelector('.batt-fill');
  fill.style.width = r.battery_pct + '%';
  fill.classList.toggle('low', settings.batteryMin != null && r.battery_pct <= settings.batteryMin);
  el.querySelector('.batt-txt').textContent = r.battery_pct + '%';

  var bars = rssiBars(r.rssi);
  var bEls = el.querySelectorAll('.rssi i');
  for (var i = 0; i < bEls.length; i++) {
    bEls[i].style.height = (6 + i * 4) + 'px';
    bEls[i].classList.toggle('on', i < bars);
  }

  el.querySelector('.samples').textContent = d.count + ' samples';
  var alerted = checkAlerts(dev, r);
  el.classList.toggle('alert', alerted);
  drawSpark(el.querySelector('.spark'), d.history);
}

function updateDeviceCount() {
  var n = Object.keys(devices).length;
  document.getElementById('deviceCount').textContent = n + (n === 1 ? ' sensor' : ' sensors');
}

// staleness + age refresh
setInterval(function () {
  var now = Date.now();
  for (var dev in devices) {
    var d = devices[dev];
    var age = now - d.lastSeen;
    d.el.classList.toggle('stale', age > STALE_MS);
    d.el.querySelector('.seen').textContent = fmtAge(age);
  }
}, 1000);

// ---------- BLE state ----------
function onBleState(s) {
  var pill = document.getElementById('bleState');
  var txt = document.getElementById('bleStateText');
  pill.className = 'pill';
  var map = {
    poweredOn: ['pill-ok', 'Bluetooth on'],
    scanning: ['pill-ok', 'Scanning'],
    poweredOff: ['pill-err', 'Bluetooth off'],
    unauthorized: ['pill-err', 'No BT permission'],
    unsupported: ['pill-err', 'BLE unsupported'],
    resetting: ['pill-warn', 'Resetting'],
    unknown: ['pill-muted', 'Starting…'],
    error: ['pill-err', 'BLE error'],
  };
  var m = map[s.state] || ['pill-muted', s.state];
  pill.classList.add(m[0]);
  txt.textContent = m[1];
  if (s.state === 'unauthorized') {
    document.getElementById('emptyHint').textContent =
      'Grant Bluetooth permission: System Settings → Privacy & Security → Bluetooth.';
  }
}

// ---------- toasts ----------
function toast(kind, title, body) {
  var t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.innerHTML = '<b>' + title + '</b>' + (body ? '<span>' + body + '</span>' : '');
  document.getElementById('toasts').appendChild(t);
  setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, 4000);
  setTimeout(function () { t.remove(); }, 4500);
}

// ---------- exports ----------
function toCSV() {
  var cols = ['timestamp_local', 'device_name', 'custom_name', 'temp_c', 'temp_f', 'humidity_pct', 'battery_pct', 'rssi'];
  var lines = [cols.join(',')];
  allReadings.forEach(function (r) {
    lines.push(cols.map(function (c) { return r[c]; }).join(','));
  });
  return lines.join('\n') + '\n';
}

function doExport(act) {
  document.getElementById('exportMenu').classList.add('hidden');
  if (act === 'csv') {
    if (!allReadings.length) return toast('warn', 'Nothing to export', 'No readings yet.');
    api.saveExport('govee-readings.csv', toCSV()).then(function (res) {
      if (res.ok) toast('ok', 'Saved CSV', res.filePath);
    });
  } else if (act === 'json') {
    if (!allReadings.length) return toast('warn', 'Nothing to export', 'No readings yet.');
    api.saveExport('govee-readings.json', JSON.stringify(allReadings, null, 2)).then(function (res) {
      if (res.ok) toast('ok', 'Saved JSON', res.filePath);
    });
  } else if (act === 'env') {
    api.exportEnv().then(function (res) {
      toast('ok', 'Synced names → .env', 'CLI collector will use these names.');
    });
  } else if (act === 'logs') {
    api.openLogs();
  }
}

// ---------- settings ----------
function applyUnitButtons() {
  document.querySelectorAll('#unitToggle .seg-btn').forEach(function (b) {
    b.classList.toggle('active', b.dataset.unit === settings.unit);
  });
}
function rerenderAll() {
  for (var dev in devices) renderCard(dev);
}

function openSettings() {
  document.getElementById('setInterval').value = Math.round((settings.sampleIntervalMs || 60000) / 1000);
  document.getElementById('setTempMin').value = settings.tempMinC == null ? '' : settings.tempMinC;
  document.getElementById('setTempMax').value = settings.tempMaxC == null ? '' : settings.tempMaxC;
  document.getElementById('setHumMin').value = settings.humMin == null ? '' : settings.humMin;
  document.getElementById('setHumMax').value = settings.humMax == null ? '' : settings.humMax;
  document.getElementById('setBatt').value = settings.batteryMin == null ? '' : settings.batteryMin;
  document.getElementById('settingsModal').classList.remove('hidden');
}
function numOrNull(id) {
  var v = document.getElementById(id).value;
  return v === '' ? null : Number(v);
}
function saveSettingsForm() {
  var patch = {
    sampleIntervalMs: Math.max(2, numOrNull('setInterval') || 60) * 1000,
    tempMinC: numOrNull('setTempMin'),
    tempMaxC: numOrNull('setTempMax'),
    humMin: numOrNull('setHumMin'),
    humMax: numOrNull('setHumMax'),
    batteryMin: numOrNull('setBatt'),
  };
  api.setSettings(patch).then(function (s) {
    settings = s;
    document.getElementById('settingsModal').classList.add('hidden');
    rerenderAll();
    toast('ok', 'Settings saved', '');
  });
}

function setLogging(on) {
  api.setSettings({ logging: on }).then(function (s) {
    settings = s;
    var btn = document.getElementById('btnLogging');
    var pill = document.getElementById('logPill');
    btn.textContent = on ? 'Stop logging' : 'Start logging';
    btn.classList.toggle('on', on);
    pill.className = 'pill ' + (on ? 'pill-ok' : 'pill-muted');
    pill.textContent = on ? 'logging on' : 'logging off';
  });
}

// ---------- wire up ----------
api.onInit(function (d) {
  names = d.names || {};
  settings = d.settings || {};
  applyUnitButtons();
  setLogging(!!settings.logging);
  if (d.nobleError) {
    onBleState({ state: 'error' });
    toast('danger', 'Bluetooth module failed to load', d.nobleError);
  }
});
api.onReading(onReading);
api.onBleState(onBleState);
api.onLogged(function (d) { /* could badge; kept quiet */ });
api.onLogError(function (d) { toast('danger', 'Log write failed', d.message); });

document.getElementById('unitToggle').addEventListener('click', function (e) {
  var b = e.target.closest('.seg-btn'); if (!b) return;
  settings.unit = b.dataset.unit;
  api.setSettings({ unit: settings.unit });
  applyUnitButtons();
  rerenderAll();
});
document.getElementById('btnLogging').addEventListener('click', function () {
  setLogging(!settings.logging);
});
document.getElementById('btnExport').addEventListener('click', function (e) {
  e.stopPropagation();
  document.getElementById('exportMenu').classList.toggle('hidden');
});
document.getElementById('exportMenu').addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (b) doExport(b.dataset.act);
});
document.addEventListener('click', function () {
  document.getElementById('exportMenu').classList.add('hidden');
});
document.getElementById('btnSettings').addEventListener('click', openSettings);
document.getElementById('closeSettings').addEventListener('click', function () {
  document.getElementById('settingsModal').classList.add('hidden');
});
document.getElementById('saveSettings').addEventListener('click', saveSettingsForm);
