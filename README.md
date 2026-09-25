# Titan X Capture

Research capture dashboard for Polar Verity Sense optical HR sensors worn in combat sports headgear (Sa7a Labs, Titan X). It is a web page: open it in Chrome, click Connect, and it records. No install, no accounts, no backend, no telemetry.

- Live link: `https://mofarah01-hue.github.io/titanx-capture/`. Until the Phase 1 release it is a **demo**: simulated sensors only, never a real one (`PAGES_DEMO` in `core/version.js`)
- Simulator: add `?sim=3` to the link (1 to 7 fake sensors, everything works as with real ones). Run the demo connects them all in one click
- First run again: add `?setup=reset` (clears saved settings, never recordings)

For the remote user: [QUICKSTART.md](QUICKSTART.md). For the first real session on the Mac: [MAC_FIRST_RUN.md](MAC_FIRST_RUN.md).

## What works (v0.0.1, 2026-09-25, tested in sim mode only)

| Area | State |
|---|---|
| Connect flow | Sequential steps with a visible log, 2 s settle, five tries with backoff per step, resume from the failed step on the same sensor without the chooser, automatic reconnect after a drop |
| Polar mode | Polar HR (0x2A37), PPI, raw PPG 55 Hz (3 green + ambient), ACC 52 Hz, GYRO 52 Hz, MAG 20 Hz, battery |
| Max rate mode | SDK mode, highest rates the sensor offers (PPG 176, ACC and GYRO 416, MAG 100), no Polar HR or PPI |
| Decoding | Every PMD frame type Polar's SDK decodes, tested against Polar's own SDK test vectors (84 unit tests) |
| Timing | Sensor timestamps kept; session time from one monotonic clock; lost packets detected from timestamps, logged, never filled in; measured rates shown and recorded |
| Recording | Starts on connect. Rows flushed every second to Chrome's private storage (crash safe), Drive folder gets marks and manifest at once, part files every 5 minutes, one zip at the end. Unfinished sessions are recovered on the next launch |
| Views | Athlete panels (1 to 4 sensors), tiles plus session strip (5 to 7), full monitor per sensor, session timeline, events with pins across lanes |
| Remote user | Setup wizard (8 steps, auto ticks), help drawer (10 entries, search), pre session checklist, end of session screen with Download fallback, debug bundle, Chrome gate, update banner, wake lock, hidden window warning |

## Not proven yet

- **No real sensor has been connected yet.** Everything above ran against the simulator, which speaks the real protocol through the real code. First real test: Windows Chrome with a Verity Sense, then the Mac ([MAC_FIRST_RUN.md](MAC_FIRST_RUN.md)).
- Frame types in SDK mode are not documented by Polar; the decoder handles every type the SDK knows and logs anything else with its raw bytes.
- The real concurrent sensor ceiling on macOS is unknown until measured.
- Google Drive for desktop syncing files written by Chrome is unproven on both Windows and Mac.

## Known limits

- Chrome or Edge on a Mac or Windows PC only. Safari and Firefox cannot use Web Bluetooth; the page says so.
- Chrome asks the user to pick each sensor from a popup, every time. `getDevices()` would avoid it but sits behind a flag on macOS, so the app does not rely on it.
- A web page cannot see a folder's path. The app recognises the shared Sa7a folder by the athlete list file `sa7a_registry.json` in it. Mohammad creates it once (Setup, step 6, "create the athlete list here").
- Chrome 110 or later is needed to save into Google Drive's folder on a Mac; Chrome 122 or later remembers the permission ("Allow on every visit").
- Our HR is a placeholder until the algorithm exists.

## Data out

```
Sa7a/                                   the shared Google Drive folder
  sa7a_registry.json                    athletes, sensors, head positions, max HR
  sa7a_2026-09-25_1810_practice/
    manifest.json                       session, app version, devices, requested and measured rates, dropouts
    annotations.json                    events: time, label, note, target, newest sample index per stream
    sa7a_2026-09-25_1810_practice.zip   everything, including one CSV per stream per sensor:
      <deviceId>_<athlete>_ppg.csv      i, t_session_s, t_sensor_ns, ppg0, ppg1, ppg2, ambient (raw counts)
      <deviceId>_<athlete>_acc.csv      i, t_session_s, t_sensor_ns, x_mg, y_mg, z_mg
      <deviceId>_<athlete>_gyro.csv     ..., x_dps, y_dps, z_dps
      <deviceId>_<athlete>_mag.csv      ..., x_gauss, y_gauss, z_gauss
      <deviceId>_<athlete>_hr.csv       i, t_session_s, hr_bpm, sensor_contact, rr_ms
      <deviceId>_<athlete>_ppi.csv      i, t_session_s, t_sensor_ns, hr_bpm, pp_ms, pp_error_ms, blocker, skin_contact, skin_contact_supported
      <deviceId>_<athlete>_frames.csv   one row per packet: receive time, sensor time, samples, gap estimate
    _live/                              part files while recording; removed once the zip is checked
```

`t_session_s` is seconds since the session started on the laptop's monotonic clock; `manifest.session.started_unix_ms` is the wall clock at zero. `t_sensor_ns` is the sensor's own clock. The manifest explains the mapping.

## Develop

```bash
npm install
npm run serve                  # http://localhost:8080/?sim=3
npm test                       # unit tests, then end to end tests in sim mode (installed Chrome)
```

No build step. `index.html` loads ES modules straight from `app/` and `core/`. Layout:

| Path | What |
|---|---|
| `core/pmd/` | Polar Measurement Data protocol: constants, decoder, encoder (simulator only) |
| `core/ble/` | Connect flow (`device.js`), HR and battery parsing |
| `core/capture-worker.js` | Decoding, timing, gap detection, rates, recording (one worker for all sensors) |
| `core/recorder.js`, `core/storage/` | Crash safe session store, Drive copies, zip writer, save folder, settings |
| `core/sim/` | Signal models and a fake Verity Sense behind a fake Bluetooth API |
| `app/` | Views, drawing, state |
| `strings/en.js` | Every word the user reads. Arabic goes in `strings/ar.js` |
| `tests/unit`, `tests/e2e` | Decoder vectors from Polar's SDK, zip against independent readers, full sim sessions |

## Push and release

Commits stay local. Pushing to GitHub happens once per working session, on request, and does not change the live link. The live link changes only with a release: `tools/release.ps1 -Version 0.1.0` runs the tests, bumps `version.json` and `core/version.js`, tags, and moves the `live` branch that GitHub Pages serves.
