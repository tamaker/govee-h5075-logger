// demo.js — Proof-of-concept: can this MacBook read all 3 Govee H5075 sensors?
//
// Runs a live BLE advertisement scan, decodes every GVH5075_* it hears, and
// prints a per-device live table. Declares SUCCESS once 3 distinct sensors have
// reported, then keeps streaming until you Ctrl-C (or it auto-exits after a
// timeout if fewer than 3 were found).
//
//   npm install        # once
//   npm run demo       # or: node demo.js
//
// Expecting a different number of sensors? Pass it:  node demo.js 2
'use strict';

const noble = require('@abandonware/noble');
const { decodeH5075 } = require('./govee');

const EXPECTED = parseInt(process.argv[2], 10) || 3;
const FIND_TIMEOUT_MS = 90_000; // give up the "find all N" goal after this long

const seen = new Map(); // name -> latest reading {tempC,tempF,humidity,battery,rssi,count,lastIso}
let announcedSuccess = false;
const startedAt = Date.now();

function fmtAge(ms) {
  const s = Math.round(ms / 1000);
  return s < 1 ? 'now' : `${s}s ago`;
}

function render() {
  const names = [...seen.keys()].sort();
  // Clear screen + home cursor for a stable live table.
  process.stdout.write('\x1b[2J\x1b[H');
  console.log('Govee H5075 BLE read demo — proving sensor reads on this Mac\n');
  console.log(
    `Scanning… ${names.length}/${EXPECTED} sensor(s) found` +
    `   (elapsed ${fmtAge(Date.now() - startedAt)})\n`
  );

  if (names.length === 0) {
    console.log('  (no GVH5075_* advertisements heard yet)');
  } else {
    console.log(
      '  ' +
      'DEVICE'.padEnd(16) +
      'TEMP'.padEnd(18) +
      'HUMIDITY'.padEnd(11) +
      'BATTERY'.padEnd(9) +
      'RSSI'.padEnd(8) +
      'SAMPLES'.padEnd(9) +
      'LAST'
    );
    for (const name of names) {
      const r = seen.get(name);
      console.log(
        '  ' +
        name.padEnd(16) +
        `${r.tempC.toFixed(1)}°C / ${r.tempF.toFixed(1)}°F`.padEnd(18) +
        `${r.humidity.toFixed(1)}%`.padEnd(11) +
        `${r.battery}%`.padEnd(9) +
        `${r.rssi}`.padEnd(8) +
        `${r.count}`.padEnd(9) +
        fmtAge(Date.now() - r.lastMs)
      );
    }
  }

  if (announcedSuccess) {
    console.log(`\n✅ SUCCESS — read all ${EXPECTED} sensors. Streaming live; Ctrl-C to stop.`);
  } else {
    console.log('\n  Ctrl-C to stop.');
  }
}

noble.on('stateChange', async (state) => {
  if (state === 'poweredOn') {
    console.log('BLE powered on — starting scan (duplicates allowed)…');
    await noble.startScanningAsync([], true); // [] = all services, true = allow duplicate advs
  } else {
    console.log(`\nBLE state: ${state}.`);
    if (state === 'unauthorized') {
      console.log(
        'Bluetooth permission denied. Grant your terminal app Bluetooth access:\n' +
        '  System Settings → Privacy & Security → Bluetooth → enable Terminal/iTerm2/VS Code,\n' +
        'then re-run.  (See SPEC §8.)'
      );
    }
    await noble.stopScanningAsync().catch(() => {});
    process.exit(state === 'unauthorized' ? 1 : 0);
  }
});

noble.on('discover', (peripheral) => {
  const name = peripheral.advertisement.localName;
  if (!name || !name.startsWith('GVH507')) return;

  const decoded = decodeH5075(peripheral.advertisement.manufacturerData);
  if (!decoded) return;

  const prev = seen.get(name);
  seen.set(name, {
    ...decoded,
    rssi: peripheral.rssi,
    count: (prev ? prev.count : 0) + 1,
    lastMs: Date.now(),
    lastIso: new Date().toISOString(),
  });

  if (!announcedSuccess && seen.size >= EXPECTED) {
    announcedSuccess = true;
  }
  render();
});

// Re-render periodically so the "age" / elapsed columns stay fresh between advs.
const ticker = setInterval(render, 1000);

// If we never reach EXPECTED sensors, report what we did find and exit.
const giveUp = setTimeout(() => {
  if (!announcedSuccess) {
    clearInterval(ticker);
    render();
    console.log(
      `\n⚠️  Found ${seen.size}/${EXPECTED} sensor(s) within ${FIND_TIMEOUT_MS / 1000}s.\n` +
      (seen.size === 0
        ? '   Heard nothing. Check: sensors powered & in range, and that this terminal\n' +
          '   has Bluetooth permission (SPEC §8).'
        : '   The ones above read fine. If a sensor is missing, move it closer or check power.')
    );
    noble.stopScanningAsync().catch(() => {});
    process.exit(seen.size === EXPECTED ? 0 : 2);
  }
}, FIND_TIMEOUT_MS);
giveUp.unref();

process.on('SIGINT', async () => {
  clearInterval(ticker);
  console.log('\n\nStopping scan…');
  await noble.stopScanningAsync().catch(() => {});
  const names = [...seen.keys()].sort();
  console.log(`Heard ${names.length} sensor(s): ${names.join(', ') || '(none)'}`);
  process.exit(0);
});
