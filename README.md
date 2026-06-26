# Govee H5075 Bluetooth Reader

Reads **temperature, humidity, and battery** from **Govee H5075** hygrometer sensors on a **MacBook Pro (Apple Silicon / M4)** by passively listening to their Bluetooth Low Energy (BLE) advertisement broadcasts. No pairing, no app, and no battery drain on the sensors.

Built with Node.js + [`@abandonware/noble`](https://github.com/abandonware/noble), which talks to Apple's CoreBluetooth under the hood. See [`SPEC.md`](SPEC.md) for the full design, decode details, and background.

## What it does

- Continuously scans for BLE advertisements (duplicates allowed) and filters for `GVH5075_*` devices by **name** (macOS hides MAC addresses, so name is the only reliable identifier).
- Decodes the Govee manufacturer payload (company ID `0xEC88`) into °C / °F, %RH, and battery %.
- Throttles to one logged reading **per device per 60 seconds** so logs stay manageable.
- Writes a **new JSON log file per day** with local timestamps.

This Mac currently sees three sensors: `GVH5075_1098`, `GVH5075_A7A8`, and `GVH5075_C375` (`C375` is the most distant / weakest signal).

## Project layout

```
5075-bt-reader/
├── README.md
├── SPEC.md                  # full design & BLE decode reference
├── node/
│   ├── demo.js              # proof-of-concept: live per-device table
│   ├── collector.js         # long-running logger → per-day JSON
│   ├── diag.js              # diagnostic scan (find a missing/weak sensor)
│   ├── govee.js             # shared H5075 decoder
│   └── package.json
└── logs/                    # generated at runtime: readings-YYYY-MM-DD.json
```

## Requirements

- macOS (Apple Silicon supported), Node.js 18+ (tested on Node 25).
- Xcode Command Line Tools (`xcode-select --install`).
- **Bluetooth turned ON.**
- **Bluetooth permission for your terminal app:** System Settings → Privacy & Security → Bluetooth → enable Terminal / iTerm2 / VS Code (whichever you launch from). Without this, scans return zero devices with no error.

## Setup

```bash
cd node
npm install
```

## Usage

### Live demo (prove it works)

Shows a live, auto-updating table of every sensor it hears and declares success once all three report:

```bash
cd node
node demo.js          # expects 3 sensors; node demo.js 2 to expect 2
```

Updates on every advertisement (~every 2 seconds per device). Press **Ctrl-C** to stop.

### Logger (continuous logging)

Appends one reading per device per 60 seconds to a daily JSON file:

```bash
cd node
node collector.js     # Ctrl-C to stop
```

Output goes to `logs/readings-<local-date>.json`, e.g. `logs/readings-2026-06-25.json`. Each entry:

```json
{
  "timestamp_local": "2026-06-25 21:10:32",
  "date": "2026-06-25",
  "time": "21:10:32",
  "epoch": 1782436232,
  "device_name": "GVH5075_C375",
  "label": "GVH5075_C375",
  "temp_c": 23.2,
  "temp_f": 73.76,
  "humidity_pct": 51.1,
  "battery_pct": 100,
  "rssi": -82
}
```

To give sensors friendly names (e.g. "Living Room"), edit the `LABELS` map at the top of `node/collector.js`. To change how often readings are logged, edit `SAMPLE_INTERVAL_MS` (default `60_000` ms).

### Diagnostics (a sensor isn't showing up?)

Casts a wider net — reports any Govee-family name and any `0xEC88` advertiser, with raw bytes and RSSI range:

```bash
cd node
node diag.js          # default 180s; node diag.js 300 for 5 min
```

## Running it persistently

Keep it running across terminal close / crashes with [pm2](https://pm2.keymetrics.io/):

```bash
cd node
pm2 start collector.js --name govee-logger
pm2 save
```

View logs / stop:

```bash
pm2 logs govee-logger
pm2 stop govee-logger
```

**Two macOS caveats for an always-on logger:**

1. **BLE scanning halts when the Mac sleeps.** Keep it awake on power, or wrap with `caffeinate`:
   ```bash
   sudo pmset -c sleep 0
   # or run under pm2 via caffeinate:
   pm2 start caffeinate --name govee-logger -- -is node collector.js
   ```
2. **Bluetooth permission is per host app.** A pm2/launchd process started at boot may not inherit your terminal's Bluetooth permission. If a boot-started logger writes nothing, start it from your already-permitted terminal instead and use `pm2 save` / `pm2 resurrect`. Confirm with `pm2 logs govee-logger`.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Zero devices, no error | Bluetooth off, or terminal lacks Bluetooth permission (see Setup). |
| Only 2 of 3 sensors appear | The missing unit is out of range / weak signal — move it closer or run `node diag.js` longer. `C375` is the far one here. |
| `DECODE FAILED` in diag | Firmware variant — check the raw bytes printed against `SPEC.md` §2. |
| Logging stops overnight | Mac went to sleep — see the persistence caveats above. |

## Notes

- A Python (`bleak`) backup implementation is described in `SPEC.md` §7 as a proven macOS fallback.
- `logs/`, `node_modules/`, and `*.tmp` are git-ignored.
