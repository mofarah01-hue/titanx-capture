# Titan X HR workbench

Desktop tool for comparing heart rate pipelines and models on Polar Verity Sense recordings. Local
only: the server listens on 127.0.0.1 and refuses requests whose Host or Origin names anything else.

## Start

```
python workbench\server.py
```

Then open http://127.0.0.1:8795/ in a browser on this PC (through remote desktop).

| Setting | Flag | Env | Default |
|---|---|---|---|
| Port | `--port` | `TITANX_WB_PORT` | 8795 |
| Live sessions | `--live-dir` | `TITANX_LIVE_DIR` | `C:\TitanX-data\live` |
| Finished sessions (zips or folders), repeatable | `--rec-dir` | `TITANX_REC_DIRS` (`;` list) | `%USERPROFILE%\Documents\TitanX-recordings` |
| Database | `--db` | `TITANX_WB_DB` | `C:\TitanX-data\workbench.db` |

Needs Python 3.12 with numpy and scipy (`requirements.txt`) and Node 24 (for the iPad engine).
Models are optional, each in its own venv (below); the page works without them.

To try it on synthetic data only:

```
python workbench\make_synthetic.py workbench\.synthetic
python workbench\server.py --live-dir workbench\.synthetic\live --rec-dir workbench\.synthetic --db workbench\.synthetic\workbench-dev.db
python workbench\make_synthetic.py workbench\.synthetic\live --live --speed 2     (a session that grows, shown as LIVE)
```

## What the page shows

- **Sessions**: live folders first (LIVE while there is no `_ended.json`), then zips and folders from the
  recordings folders. Live CSVs are tailed by byte offset, whole lines only; the page polls every 1.5 to 2 s,
  follows the end, and re-runs the lanes every 10 s while live (those re-runs are not saved).
- **HR lanes** (cards): pipeline variants with a method per stage (diode fusion, band-pass, motion
  removal, HR method, notch, beat screening, tracker, gate, impact freeze, Viterbi, plus any setting as
  JSON), the iPad engine (`core/algo/motionhr.js` unchanged, through `run_engine.mjs`), and models.
  Polar's own HR (hr.csv) and, for synthetic sessions, the true HR are added by themselves.
  Defaults: "Pipeline (defaults)", "Pipeline, motion removal off", "iPad engine".
- **Signal lanes** on one time axis (wheel zooms, drag pans, double click shows all): all HR lanes with
  zone bands, raw diodes, the chosen variant's fused / band-passed / after NLMS / after notch signals with
  its beats, ACC and GYRO magnitude, then one lane per HR source. Annotations are dashed yellow lines.
- **Comparison**: every pair of HR lanes on a 1 s grid: mean absolute difference, % of seconds within
  5 bpm, coverage; split by motion level (std of |a| per second: low < 0.05 g <= mid < 0.2 g <= high, settable).
- **Zones**: max HR from age (Tanaka 208 - 0.7 x age) or typed in; zones 1 to 5 at 50/60/70/80/90 %.

## Files

| File | What |
|---|---|
| `server.py` | HTTP server and JSON API (`/api/sessions`, `/api/session`, `/api/signals`, `/api/run`, `/api/trace`, `/api/compare`, `/api/runs`, `/api/estimates`) |
| `sessions.py` | Finds and reads sessions; `CsvTail` reads growing CSVs by byte offset |
| `pipeline.py` | Python port of motionhr.js with selectable methods; defaults equal `defaultConfig()` |
| `engines.py`, `run_engine.mjs` | Runs the iPad engine in Node on the same parsed streams (float32 values, as the app does) |
| `models/` | Model plugins: one interface (`run` / `push` giving `{t, bpm, conf}`), each a subprocess in its own venv |
| `compare.py` | The comparison table |
| `db.py` | SQLite: `sessions`, `runs`, `estimates`, `scores` (empty; see the TODO there) |
| `make_synthetic.py` | Synthetic sessions in the app's exact file format, with a known HR |
| `test_e2e.py` | The end to end check |
| `shot.mjs` | Playwright screenshot of the page (`screenshot.png`) |
| `static/` | The page; canvas plots written here, nothing loaded from a CDN |

Saved runs: every "Run" or "Run all" stores the run (config JSON, time) and its per second estimates.
Live auto re-runs and the Polar / truth lanes are not stored. The page does not yet list past runs;
`/api/runs?id=...` and `/api/estimates?run=N` return them.

## Python pipeline vs the iPad engine

With every method at its default, `pipeline.py` follows motionhr.js step by step (same RBJ biquads with
the same priming, the same 25 Hz grid built by repeated addition, the same once-a-second estimate,
tracker, gate and Viterbi). On the synthetic sessions the two agree to 0.09 bpm (Polar mode) and
0.02 bpm (Max mode) on average over the seconds both answer; the JS engine computes spectra in float32,
so a handful of seconds near the confidence gate fall on different sides of it.
Band-pass "off" keeps a wide 0.3 to 5 Hz band, as motionhr.js does.

## Models

| Model | Status | Venv | How it was installed |
|---|---|---|---|
| BeliefPPG 0.3.1 (MIT) | works | `.venv-beliefppg` | `pip install beliefppg` (TensorFlow 2.21 CPU, tf-keras, tensorflow-probability 0.22.1; also pulls wandb, used only by its training code; the worker sets `WANDB_MODE=disabled`) |
| KID-PPG 0.0.4 (GPL-3.0, comparison only, never shipped) | works, with changes below | `.venv-kidppg` | see below |

**KID-PPG install.** `pip install kid-ppg` fails on this PC: every release requires Python exactly
3.10.8 ("Ignored the following versions that require a different python version: 0.0.1 Requires-Python
==3.10.8; 0.0.4 Requires-Python ==3.10.8") and pins TensorFlow 2.13, which has no Python 3.12 build. The
only other Python here (`~\.local\bin\python3.11.exe`, a uv shim) is broken ("uv trampoline failed to
spawn Python child process"). So it was installed as
`pip install --ignore-requires-python --no-deps kid-ppg==0.0.4` plus TensorFlow 2.21, tf-keras 2.21 and
tensorflow-probability 0.22.1 (`requirements-kidppg.txt`). The worker runs it under Keras 2 (tf-keras) by
pointing `import keras` at tf_keras. Check: `models\kidppg_worker.py --selftest` on the package's own
demo recording (PPG-DaLiA S6, stairs) gives MAE 3.4 bpm against its labels (3.0 to 3.4 between runs: the
adaptive filter starts from random weights), in line with the paper. The network needs the PPG on the
Empatica E4 BVP scale, so the worker band-passes 0.5 to 4 Hz and scales the PPG to a median 8 s window
standard deviation of 30; that scaling is this workbench's choice.

Both models see PPG (mean of the three greens minus ambient) and ACC only, as trained (wrist, ACC only).
On the synthetic sessions both lock onto the head yaw rhythm that only the gyroscope sees (MAE about 37
bpm after the run starts), which is what the research note predicts for wrist ACC-only models on head data.

To rebuild a model venv: `python -m venv workbench\.venv-beliefppg` then
`workbench\.venv-beliefppg\Scripts\python -m pip install -r workbench\requirements-beliefppg.txt`
(KID-PPG: the two commands in `requirements-kidppg.txt`).

## Verification

```
python workbench\test_e2e.py
```

Synthetic Polar mode and Max mode sessions (70 bpm rising to 160, running-like motion about 4x the
pulse, two head hits); asserts MAE < 4 bpm and >= 60 % of seconds answered for the default pipeline and
the iPad engine, motion removal off at least 3x worse, the Python pipeline within 1 bpm of the iPad
engine; then a session written over time with half lines at the end of every append, checking the
tailer only ever reads whole lines and sees the end. Results go to `workbench\.synthetic\e2e-<time>\result.json`.
Only synthetic data is used; no real recording was opened while building this.

## Not done yet

- True HR scoring (`scores` table and TODO in `db.py`): the reference device is not chosen.
- SensWear sessions: the reader finds their files, but the pipeline lanes are Polar only.
- The page does not list or reload past saved runs (the API does).
- Models run on whole recordings; `push()` (live) re-runs the last 60 s and is not wired into the page's live loop.
