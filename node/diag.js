// diag.js — Diagnostic scan to hunt down a missing Govee sensor.
//
// Casts a wider net than demo.js:
//   • Reports ANY device whose name looks Govee-ish (GV*, GVH*, H50*, Govee*).
//   • Reports ANY device advertising the Govee company id 0xEC88, regardless of name.
//   • Dumps raw manufacturer-data bytes so a firmware/format variant is visible.
//   • Tracks every distinct device's best/worst RSSI and adv count over a long run.
//
//   node diag.js            # default 180s
//   node diag.js 300        # run 5 minutes
'use strict';

const noble = require('@abandonware/noble');
const { GOVEE_COMPANY_ID, decodeH5075 } = require('./govee');

const RUN_MS = (parseInt(process.argv[2], 10) || 180) * 1000;

const goveeUnits = new Map();   // name -> {count, bestRssi, worstRssi, lastRaw, decoded}
const otherGovee = new Map();   // id (uuid/name) -> {name, count, bestRssi, raw}  (0xEC88 but unexpected name)
let totalDevices = new Set();
const startedAt = Date.now();

function looksGovee(name) {
  if (!name) return false;
  const n = name.toUpperCase();
  return n.startsWith('GVH507') || n.startsWith('GVH') || n.startsWith('GV') ||
         n.startsWith('H50') || n.includes('GOVEE');
}

noble.on('stateChange', async (state) => {
  if (state === 'poweredOn') {
    console.log(`BLE powered on — diagnostic scan for ${RUN_MS / 1000}s (duplicates allowed)…`);
    console.log('Looking for Govee-family names AND any 0xEC88 manufacturer advertisement.\n');
    await noble.startScanningAsync([], true);
  } else {
    console.log(`BLE state: ${state}.`);
    await noble.stopScanningAsync().catch(() => {});
    if (state !== 'poweredOn') process.exit(state === 'unauthorized' ? 1 : 0);
  }
});

noble.on('discover', (p) => {
  totalDevices.add(p.id);
  const name = p.advertisement.localName;
  const md = p.advertisement.manufacturerData;
  const isGoveeCompany = md && md.length >= 2 && md.readUInt16LE(0) === GOVEE_COMPANY_ID;

  // Track anything that looks like a Govee sensor by name.
  if (looksGovee(name)) {
    const u = goveeUnits.get(name) || { count: 0, bestRssi: -999, worstRssi: 0 };
    u.count++;
    u.bestRssi = Math.max(u.bestRssi, p.rssi);
    u.worstRssi = Math.min(u.worstRssi, p.rssi);
    u.lastRaw = md ? md.toString('hex') : '(none)';
    u.decoded = decodeH5075(md);
    u.isGoveeCompany = isGoveeCompany;
    goveeUnits.set(name, u);
    return;
  }

  // Track 0xEC88 advertisers that DON'T match our name filter (firmware variant / odd name).
  if (isGoveeCompany) {
    const key = name || p.id;
    const o = otherGovee.get(key) || { name: name || '(no name)', count: 0, bestRssi: -999 };
    o.count++;
    o.bestRssi = Math.max(o.bestRssi, p.rssi);
    o.raw = md.toString('hex');
    o.decoded = decodeH5075(md);
    otherGovee.set(key, o);
  }
});

function report() {
  console.log('\n' + '='.repeat(70));
  console.log(`DIAGNOSTIC SUMMARY  (ran ${Math.round((Date.now() - startedAt) / 1000)}s)`);
  console.log('='.repeat(70));
  console.log(`Total distinct BLE devices heard: ${totalDevices.size}\n`);

  console.log(`Govee-named devices: ${goveeUnits.size}`);
  for (const [name, u] of [...goveeUnits.entries()].sort()) {
    const d = u.decoded
      ? `${u.decoded.tempC.toFixed(1)}°C ${u.decoded.humidity.toFixed(1)}% batt${u.decoded.battery}%`
      : 'DECODE FAILED';
    console.log(`  • ${name.padEnd(16)} advs=${String(u.count).padStart(4)} ` +
      `rssi ${u.worstRssi}..${u.bestRssi} dBm  0xEC88=${u.isGoveeCompany ? 'Y' : 'N'}  ${d}`);
    console.log(`      raw: ${u.lastRaw}`);
  }

  if (otherGovee.size) {
    console.log(`\n⚠️  Other 0xEC88 advertisers NOT matching the name filter: ${otherGovee.size}`);
    for (const [, o] of otherGovee) {
      const d = o.decoded
        ? `${o.decoded.tempC.toFixed(1)}°C ${o.decoded.humidity.toFixed(1)}% batt${o.decoded.battery}%`
        : 'DECODE FAILED';
      console.log(`  • ${String(o.name).padEnd(20)} advs=${o.count} bestRssi=${o.bestRssi}  ${d}`);
      console.log(`      raw: ${o.raw}`);
    }
  } else {
    console.log('\nNo 0xEC88 advertisers outside the name filter.');
  }
  console.log('');
}

const giveUp = setTimeout(async () => {
  await noble.stopScanningAsync().catch(() => {});
  report();
  process.exit(0);
}, RUN_MS);
giveUp.unref();

process.on('SIGINT', async () => {
  await noble.stopScanningAsync().catch(() => {});
  report();
  process.exit(0);
});
