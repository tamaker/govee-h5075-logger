# SPEC.md — Govee H5075 Hygrometer Logger (macOS / Apple Silicon)

**Goal:** Continuously read temperature, humidity, and battery from **3× Govee H5075** sensors on a **MacBook Pro M4**, by passively sniffing their BLE advertisement broadcasts (no pairing, no battery drain on the sensors).

**Primary stack:** Node.js (`@abandonware/noble`). **Backup stack:** Python (`bleak`) — which is exactly what the reference repo (`SomeInterestingUserName/temp-humidity-logger`) already implements.

---

## 1. Feasibility verdict

Yes, this works on an M4. Both paths talk to Apple's **CoreBluetooth** framework under the hood:

- **Python / `bleak`** — first-class Apple Silicon support. The reference repo was literally written for this use case (the author's write-up is *"Logging Sensor Data to the Cloud with an Old MacBook"*). Its `scan_ble.py` will run on your M4 as-is.
- **Node / `@abandonware/noble`** — also works on Apple Silicon via CoreBluetooth, but native-module builds are occasionally fragile on the newest macOS + Node combos. This is the one honest reason `bleak` is the more reliable path on a Mac specifically. We build the Node version as requested and keep Python as the proven fallback.

Two macOS realities drive the whole design — read these before anything else:

1. **macOS hides MAC addresses.** CoreBluetooth gives you a per-Mac random UUID, *not* the real `A4:C1:38:…` address. So you **cannot** identify your sensors by MAC on a Mac — you must identify them by their **advertised name** (`GVH5075_XXXX`).
   - ⚠️ This means the reference repo's `log_sensors.py` (which filters on `device.address.startswith("A4:C1:38")`) will silently log **nothing** on macOS. Its `scan_ble.py` (which filters by name) works fine. The corrected Python collector in §7 fixes this.
2. **Bluetooth permission is per-host-app.** Your terminal app (Terminal / iTerm2 / VS Code) must be granted Bluetooth access (§8), or scans return zero devices with no error.

---

## 2. How the H5075 broadcast works (verified decode)

The sensor periodically (~every 2 s) emits a BLE advertisement containing manufacturer-specific data under **company ID `0xEC88` (60552)**.

Payload layout (the bytes *after* the 2-byte company ID):

| Offset | Bytes | Meaning |
|--------|-------|---------|
| 0      | 1     | flags (ignored) |
| 1–3    | 3     | 24-bit big-endian value encoding **temp + humidity** |
| 4      | 1     | battery percentage (uint8) |

Decode algorithm (taken from the working reference implementation, credited to `Thrilleratplay/GoveeWatcher`):

```
temphum     = int(payload[1:4], big-endian)      # 24-bit
isNegative  = (temphum & 0x800000) != 0          # top bit = sign
temphum    &= ~0x800000                           # strip the sign bit
hum10       = temphum % 1000
humidity    = hum10 / 10                           # %RH
temp_c      = (temphum - hum10) / 10000            # °C
if isNegative: temp_c = -temp_c
battery     = payload[4]
temp_f      = temp_c * 9/5 + 32
```

### ⚠️ Critical byte-offset difference between the two libraries

The decode *math* is identical, but the two libraries hand you the buffer differently:

- **`bleak`** — `adv.manufacturer_data` is a `dict` keyed by company ID. `adv.manufacturer_data[0xEC88]` returns the payload **with the company ID already stripped**. So use indices `[1:4]` (temp/hum) and `[4]` (battery) exactly as above.
- **`noble`** — `peripheral.advertisement.manufacturerData` is a single `Buffer` that **includes** the 2-byte company ID at the front (little-endian: `0x88 0xEC`). Everything shifts by **+2**: company ID at `[0:2]`, temp/hum at `[3:6]`, **battery at `[6]`**.

Both are handled correctly in the code skeletons below.

---

## 3. Identifying your three units

Each H5075 advertises a local name of the form **`GVH5075_XXXX`**, where `XXXX` is the last two bytes of its MAC in hex. Your three sensors therefore broadcast three distinct names (e.g. `GVH5075_A1B2`, `GVH5075_C3D4`, `GVH5075_E5F6`).

Strategy: run a discovery scan once, note the three suffixes, then map each to a friendly label in a `LABELS` table. This is the one identification scheme that works on **both** macOS and Linux, so the code is portable to a Raspberry Pi / Linux always-on host later without changes.

---

## 4. Architecture

```
 ┌──────────────┐   BLE adv (~2s)   ┌──────────────────────────┐
 │ 3× H5075     │ ────────────────► │  Collector (long-running) │
 │ broadcasters │                   │  • scan, duplicates ON    │
 └──────────────┘                   │  • filter GVH507*         │
                                    │  • decode (§2)            │
                                    │  • throttle 1/device/N s  │
                                    │  • append sink            │
                                    └─────────────┬─────────────┘
                                                  │
                                   ┌──────────────┴──────────────┐
                                   ▼                              ▼
                            readings.csv                  (optional) SQLite
                                                          / HTTP JSON / Grafana
```

Design notes:
- **Scan with duplicates allowed.** By default CoreBluetooth reports each device once; you must opt into duplicate advertisements to get continuous readings (`noble.startScanningAsync([], true)` / `bleak` reports every adv via its callback).
- **Throttle per device** to one logged sample per `SAMPLE_INTERVAL` (default 60 s) so you don't write a row every 2 seconds.
- **Tolerate gaps.** BLE adv packets get missed; the throttle window should comfortably exceed the ~2 s adv interval so an occasional miss is invisible.
- Core scope is **CSV append**. SQLite, an HTTP endpoint, and a dashboard are optional add-ons (§12).

---

## 5. Project layout

```
govee-h5075-logger/
├── SPEC.md
├── node/
│   ├── collector.js
│   └── package.json
├── python/
│   ├── collector.py
│   └── requirements.txt
└── readings.csv          # generated at runtime
```

---

## 6. Node.js implementation (primary)

`node/package.json`:

```json
{
  "name": "govee-h5075-logger",
  "version": "1.0.0",
  "type": "commonjs",
  "engines": { "node": ">=18" },
  "dependencies": {
    "@abandonware/noble": "^1.9.2-26"
  }
}
```

> If the native build fails on the newest macOS/Node, two escape hatches: try the actively-maintained `@stoprocent/noble` fork (same API), or just run the Python collector in §7 — it's the proven path on macOS.

`node/collector.js`:

```js
// collector.js — Govee H5075 BLE advertisement logger (macOS primary)
const noble = require('@abandonware/noble');
const fs = require('fs');
const path = require('path');

const GOVEE_COMPANY_ID = 0xEC88;          // 60552
const SAMPLE_INTERVAL_MS = 60_000;        // min ms between logged samples per device
const CSV_PATH = path.join(__dirname, '..', 'readings.csv');

// Fill in after your first discovery run (unknown names are printed automatically).
const LABELS = {
  // 'GVH5075_A1B2': 'Server Closet',
  // 'GVH5075_C3D4': 'Living Room',
  // 'GVH5075_E5F6': 'Basement',
};

const lastLogged = new Map();

function ensureCsvHeader() {
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH,
      'ts_iso,epoch,device_name,label,temp_c,temp_f,humidity_pct,battery_pct,rssi\n');
  }
}

function decodeH5075(md) {
  // md = full manufacturer-data Buffer, INCLUDING 2-byte company id (little-endian)
  if (!md || md.length < 7) return null;
  if (md.readUInt16LE(0) !== GOVEE_COMPANY_ID) return null;
  let temphum = (md[3] << 16) | (md[4] << 8) | md[5];   // note +2 offset vs bleak
  const isNegative = (temphum & 0x800000) !== 0;
  temphum &= ~0x800000;
  const hum10 = temphum % 1000;
  const humidity = hum10 / 10;
  let tempC = (temphum - hum10) / 10000;
  if (isNegative) tempC = -tempC;
  const battery = md[6];
  return { tempC, humidity, battery };
}

noble.on('stateChange', async (state) => {
  if (state === 'poweredOn') {
    ensureCsvHeader();
    console.log('BLE powered on — scanning (duplicates allowed)…');
    await noble.startScanningAsync([], true);   // [] = all services, true = allowDuplicates
  } else {
    console.log(`BLE state: ${state} — stopping scan.`);
    await noble.stopScanningAsync();
  }
});

noble.on('discover', (peripheral) => {
  const name = peripheral.advertisement.localName;
  if (!name || !name.startsWith('GVH507')) return;          // name filter (macOS-safe)

  const decoded = decodeH5075(peripheral.advertisement.manufacturerData);
  if (!decoded) return;

  const now = Date.now();
  if (now - (lastLogged.get(name) || 0) < SAMPLE_INTERVAL_MS) return;  // per-device throttle
  lastLogged.set(name, now);

  const tempF = decoded.tempC * 9 / 5 + 32;
  const label = LABELS[name] || name;
  const iso = new Date(now).toISOString();

  const row = [
    iso, Math.floor(now / 1000), name, label,
    decoded.tempC.toFixed(2), tempF.toFixed(2),
    decoded.humidity.toFixed(1), decoded.battery, peripheral.rssi,
  ].join(',') + '\n';

  fs.appendFileSync(CSV_PATH, row);
  console.log(
    `${iso}  ${label.padEnd(16)} ${decoded.tempC.toFixed(1)}°C / ${tempF.toFixed(1)}°F` +
    `  ${decoded.humidity.toFixed(1)}%  batt ${decoded.battery}%  rssi ${peripheral.rssi}`
  );
});
```

Run:
```bash
cd node && npm install
node collector.js          # first run prints unknown GVH5075_* names → fill in LABELS
```

Keep it running:
- **pm2** (your existing tooling): `pm2 start collector.js --name govee-logger`
- Prevent the Mac from sleeping while it logs: `caffeinate -is node collector.js` (BLE scanning stops when the laptop sleeps — see §11).

---

## 7. Python backup (`bleak`) — corrected & extended

The reference repo gets you 90% there; this version fixes the two macOS issues (MAC-OUI filter → name filter; 20 s one-shot → persistent scan) and adds per-device throttling plus a richer CSV.

`python/requirements.txt`:
```
bleak>=0.21
```

`python/collector.py`:

```python
# collector.py — Govee H5075 BLE advertisement logger (bleak; macOS-safe)
import asyncio, csv, os, time
from datetime import datetime, timezone
from bleak import BleakScanner

GOVEE_COMPANY_ID = 0xEC88               # 60552
SAMPLE_INTERVAL = 60                    # min seconds between logged samples per device
CSV_PATH = os.path.join(os.path.dirname(__file__), "..", "readings.csv")

# Fill in after your first discovery run.
LABELS = {
    # "GVH5075_A1B2": "Server Closet",
    # "GVH5075_C3D4": "Living Room",
    # "GVH5075_E5F6": "Basement",
}

last_logged = {}

def ensure_header():
    if not os.path.exists(CSV_PATH):
        with open(CSV_PATH, "w", newline="") as f:
            csv.writer(f).writerow(
                ["ts_iso", "epoch", "device_name", "label",
                 "temp_c", "temp_f", "humidity_pct", "battery_pct", "rssi"])

def decode_h5075(mfg: dict):
    payload = mfg.get(GOVEE_COMPANY_ID)         # company id already stripped by bleak
    if not payload or len(payload) < 5:
        return None
    temphum = int.from_bytes(payload[1:4], "big")
    is_negative = (temphum & 0x800000) != 0
    temphum &= ~0x800000
    hum10 = temphum % 1000
    humidity = hum10 / 10
    temp_c = (temphum - hum10) / 10000
    if is_negative:
        temp_c = -temp_c
    return temp_c, humidity, payload[4]

def detection_callback(device, adv):
    name = adv.local_name
    if not name or "GVH507" not in name:        # name filter (macOS-safe)
        return
    decoded = decode_h5075(adv.manufacturer_data)
    if not decoded:
        return
    now = time.time()
    if now - last_logged.get(name, 0) < SAMPLE_INTERVAL:   # per-device throttle
        return
    last_logged[name] = now

    temp_c, humidity, battery = decoded
    temp_f = temp_c * 9 / 5 + 32
    label = LABELS.get(name, name)
    iso = datetime.now(timezone.utc).isoformat()

    with open(CSV_PATH, "a", newline="") as f:
        csv.writer(f).writerow(
            [iso, int(now), name, label,
             f"{temp_c:.2f}", f"{temp_f:.2f}", f"{humidity:.1f}", battery, adv.rssi])
    print(f"{iso}  {label:<16} {temp_c:.1f}°C / {temp_f:.1f}°F  "
          f"{humidity:.1f}%  batt {battery}%  rssi {adv.rssi}")

async def main():
    ensure_header()
    scanner = BleakScanner(detection_callback)
    await scanner.start()
    print("Scanning… Ctrl-C to stop.")
    try:
        while True:
            await asyncio.sleep(3600)
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        await scanner.stop()

if __name__ == "__main__":
    asyncio.run(main())
```

Run:
```bash
cd python
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python collector.py
```

> Want to confirm hardware/permissions first with zero risk? Just run the repo's `scan_ble.py` — it's a clean 20-second discovery scan that prints any H5075 it hears.

---

## 8. macOS setup & permissions (do this once)

1. **Grant Bluetooth to your terminal:** System Settings → Privacy & Security → **Bluetooth** → enable Terminal / iTerm2 / VS Code (whichever you launch the script from). The first scan may trigger the prompt; if devices never appear and there's no error, this is almost always the cause.
2. **Node prereqs:** Xcode Command Line Tools (`xcode-select --install`), then `npm install`.
3. **Python prereqs:** Python 3.10+, `pip install bleak` in a venv.
4. **Discovery scan:** run either collector with `LABELS` empty (or the repo's `scan_ble.py`). Confirm all **3** `GVH5075_*` names appear and record their suffixes → populate `LABELS`.

---

## 9. Data model (CSV output)

| Column        | Example                     | Notes |
|---------------|-----------------------------|-------|
| `ts_iso`      | `2026-06-24T17:03:22.481Z`  | UTC ISO-8601 |
| `epoch`       | `1782759802`                | unix seconds |
| `device_name` | `GVH5075_A1B2`              | advertised name |
| `label`       | `Server Closet`             | from `LABELS` |
| `temp_c`      | `22.41`                     | °C |
| `temp_f`      | `72.34`                     | °F |
| `humidity_pct`| `48.6`                      | %RH |
| `battery_pct` | `87`                        | % |
| `rssi`        | `-67`                       | dBm signal |

---

## 10. Acceptance criteria

- [ ] All **3** sensors discovered by name within 60 s of starting a scan.
- [ ] Decoded temp/humidity match each unit's on-screen LCD within ~±0.5 °C / ±3 %RH.
- [ ] Exactly one row per device per `SAMPLE_INTERVAL` under steady state.
- [ ] Collector runs continuously for ≥ 12 h without crashing or losing a sensor.
- [ ] (If any sensor lives in a fridge/freezer) negative-temperature path verified.

---

## 11. Risks & gotchas

| Risk | Mitigation |
|------|------------|
| macOS hides MAC → can't filter by address | Filter by `GVH5075_*` name (built in). |
| No Bluetooth permission → silent zero results | Grant terminal app BT access (§8). |
| `@abandonware/noble` native build fails on newest macOS/Node | Use `@stoprocent/noble`, or run the Python path. |
| macOS sleeps → BLE scanning halts | `caffeinate -is …`, or disable sleep / run clamshell-on-power. For a permanent logger, the repo author's "old MacBook as always-on box" pattern works well. |
| Missed adv packets / weak signal | Throttle window (60 s) ≫ adv interval (~2 s); keep host within range. |
| A device doesn't decode (firmware variant) | Temporarily log the raw `manufacturer_data` bytes and confirm the `0xEC88` key + layout. |

---

## 12. Optional enhancements (later phases)

- **SQLite sink** (`better-sqlite3` / `sqlite3`) for queryable history instead of/alongside CSV.
- **Live dashboard** — a small Express + EJS app (your usual stack) reading the latest row per device; SSE for push updates.
- **Metrics pipeline** — Prometheus exporter → Grafana, or InfluxDB, for long-term trend charts and alerting (e.g. humidity threshold).
- **Linux/Pi migration** — the name-based identification means `collector.py` runs unchanged on a Raspberry Pi gateway for a 24/7 logger off your laptop.
- **Historical GATT pull** — the H5075 also stores history retrievable via an *active* GATT connection. It's more complex and costs sensor battery (it opens a connection), so advertisement scanning remains the default; treat GATT history as a separate, opt-in phase only if you need backfill.

---

## Appendix — credits

- BLE manufacturer-data format: `Thrilleratplay/GoveeWatcher` (via the reference repo).
- Reference implementation & macOS-as-logger pattern: `SomeInterestingUserName/temp-humidity-logger`.
- BLE libraries: `bleak` (Python), `@abandonware/noble` (Node).
