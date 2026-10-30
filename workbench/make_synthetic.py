"""Synthetic Polar Verity Sense session with a known heart rate, in the exact files the capture app
writes (core/capture-worker.js): manifest.json, annotations.jsonl, <dev>_ppg.csv, _acc, _gyro, _mag,
_hr, _frames. Plus synthetic_truth.csv (t_session_s, hr_bpm), which the real app never writes, so
the workbench can score against the known answer.

The motion is running-like head movement, so each motion reference matters:
  ACC   vertical bounce at the step cadence (2.8 to 3.0 Hz) plus a second harmonic
  GYRO  head yaw at the stride rate (half the cadence, about 1.45 Hz); pure rotation, so ACC does not see it
  MAG   the earth field turned by that yaw angle
The PPG artifact is a delayed, weighted copy of the bounce and the yaw, about 4 times the pulse, so
plain spectral HR locks onto the cadence or the stride unless motion is removed. Two head hits
(8 g for 30 ms) test the impact freeze.

Usage:
  python make_synthetic.py OUT_DIR [--mode polar|max] [--dur 300] [--name NAME] [--zip]
  python make_synthetic.py OUT_DIR --live [--speed 10]     writes the session over time, like a live copy
A folder or zip that already exists is never overwritten.
"""
import argparse
import json
import math
import os
import sys
import time
import zipfile
from datetime import datetime, timezone

import numpy as np

DEV = 'SYNTH001'
BASE = f'{DEV}_synthetic'
RATES = {  # Hz, as the Verity Sense delivers them
    'polar': {'ppg': 55, 'acc': 52, 'gyro': 52, 'mag': 20},
    'max': {'ppg': 176, 'acc': 416, 'gyro': 416, 'mag': 100},
}
COLS = {
    'ppg': ['ppg0', 'ppg1', 'ppg2', 'ambient'],
    'acc': ['x_mg', 'y_mg', 'z_mg'],
    'gyro': ['x_dps', 'y_dps', 'z_dps'],
    'mag': ['x_gauss', 'y_gauss', 'z_gauss'],
}
DIGITS = {'ppg': 0, 'acc': 0, 'gyro': 4, 'mag': 5}
SENSOR_T0_NS = 815_000_000_000_000_000  # sensor clock: ns since 2000-01-01 (about 2025-10)
RUN_START, RUN_FULL = 45.0, 55.0         # running starts, reaches full motion
IMPACTS = (150.0, 200.0)


def hr_true(t):
    """70 bpm at rest, a smooth rise to 160 between 60 and 240 s, then 160."""
    t = np.asarray(t, float)
    x = np.clip((t - 60) / 180, 0, 1)
    return 70 + 90 * (0.5 - 0.5 * np.cos(np.pi * x))


def _phase(freq, t, dt=0.001):
    """Phase (cycles) of a signal whose frequency changes over time, on any time points."""
    tt = np.arange(0, t.max() + 1, dt)
    ph = np.concatenate([[0], np.cumsum(freq(tt[:-1]) * dt)])
    return np.interp(t, tt, ph)


def _motion_amount(t):
    return np.clip((t - RUN_START) / (RUN_FULL - RUN_START), 0, 1)


def signals(t, kind, rng):
    """Values (n, ch) of one stream at times t."""
    cad = lambda x: 2.9 + 0.1 * np.sin(x / 23)            # steps per second
    pc = _phase(cad, t)                                     # step phase
    m = _motion_amount(t)
    bounce = m * (900 * np.sin(2 * np.pi * pc) + 250 * np.sin(4 * np.pi * pc + 1))    # mG, vertical
    yaw_rate = m * 110 * np.sin(np.pi * pc + 0.6)                                    # dps, stride = cadence / 2
    n = len(t)
    if kind == 'acc':
        hit = np.zeros(n)
        for ti in IMPACTS:
            hit[(t >= ti) & (t < ti + 0.03)] = 8000
        return np.stack([0.3 * bounce + 15 * rng.standard_normal(n) + hit,
                         15 * rng.standard_normal(n),
                         1000 + bounce + 15 * rng.standard_normal(n)], 1)
    if kind == 'gyro':
        return np.stack([3 * rng.standard_normal(n), 3 * rng.standard_normal(n), yaw_rate + 3 * rng.standard_normal(n)], 1)
    if kind == 'mag':
        # yaw angle is the integral of the yaw rate: amplitude 110 / (2 pi 1.45) deg, about 12 deg
        stride = lambda x: cad(x) / 2
        yaw = np.radians(m * 110 / (2 * np.pi * stride(t)) * -np.cos(np.pi * pc + 0.6))
        return np.stack([0.25 * np.cos(yaw), 0.25 * np.sin(yaw), np.full(n, -0.40)], 1) + 0.002 * rng.standard_normal((n, 3))
    if kind == 'ppg':
        pb = _phase(lambda x: hr_true(x) / 60, t) % 1
        pulse = np.exp(-((pb - 0.2) ** 2) / 0.006) + 0.35 * np.exp(-((pb - 0.5) ** 2) / 0.015)
        # artifact: the bounce 40 ms late and the yaw rate 20 ms late, together about 4x the 1000 count pulse
        tb = t - 0.04
        bounce_l = _motion_amount(tb) * (900 * np.sin(2 * np.pi * _phase(cad, np.maximum(tb, 0))) + 250 * np.sin(4 * np.pi * _phase(cad, np.maximum(tb, 0)) + 1))
        ty = t - 0.02
        yaw_l = _motion_amount(ty) * 110 * np.sin(np.pi * _phase(cad, np.maximum(ty, 0)) + 0.6)
        art = 4000 * (0.6 * bounce_l / 900 + 0.5 * yaw_l / 110)
        amb = 9000 + 800 * np.sin(t / 7)
        out = np.empty((n, 4))
        for c in range(3):
            k = 1 - 0.1 * c
            out[:, c] = 260000 * k - 1000 * k * pulse + art * (1 + 0.2 * c) + 0.3 * amb + 30 * rng.standard_normal(n)
        out[:, 3] = amb
        return out
    raise ValueError(kind)


def stream_times(hz, dur):
    return np.arange(0, dur, 1 / hz)


def csv_rows(kind, t, v, i0=0):
    d = DIGITS[kind]
    fmt = (lambda x: str(int(round(x)))) if d == 0 else (lambda x: f'{round(x, d):g}')
    lines = []
    for k in range(len(t)):
        ns = SENSOR_T0_NS + int(round(t[k] * 1e9))
        lines.append(f'{i0 + k},{t[k]:.4f},{ns},' + ','.join(fmt(x) for x in v[k]))
    return '\n'.join(lines) + ('\n' if lines else '')


def polar_hr(t):
    """Polar's own HR as the sensor would give it: once a second, about 4 s behind, whole bpm."""
    rng = np.random.default_rng(11)
    lagged = hr_true(np.maximum(t - 4, 0))
    return np.round(lagged + 1.5 * rng.standard_normal(len(t)))


def header(kind):
    return 'i,t_session_s,t_sensor_ns,' + ','.join(COLS[kind]) + '\n'


def manifest(name, mode, dur, counts, ended):
    started = datetime(2026, 10, 30, 9, 0, 0, tzinfo=timezone.utc)
    rates = RATES[mode]
    return {
        'format': 'titanx-capture/1',
        'app': {'name': 'workbench/make_synthetic.py', 'version': 'synthetic'},
        'session': {
            'name': name, 'label': 'synthetic',
            'started': started.isoformat().replace('+00:00', 'Z'), 'started_unix_ms': int(started.timestamp() * 1000),
            'ended': None if not ended else started.isoformat(), 'duration_s': dur if ended else None,
            'clock': 't_session_s: seconds since the session started.',
        },
        'synthetic': {'hr': '70 bpm, rising to 160 between 60 and 240 s (synthetic_truth.csv)', 'running_from_s': RUN_START, 'impacts_s': list(IMPACTS)},
        'devices': [{
            'device_id': DEV, 'kind': 'polar', 'ble_name': f'Polar Sense {DEV} (synthetic)', 'athlete': 'synthetic', 'athlete_id': None,
            'position': None, 'mode': mode, 'time_offset_s': 0,
            'streams': {k: {'file': f'{BASE}_{k}.csv', 'samples': counts.get(k, 0), 'measured_hz': rates[k], 'timing': 'sensor'} for k in rates},
            'hr_samples': counts.get('hr', 0) if mode == 'polar' else 0,
        }],
        'dropouts': [], 'marks': 2, 'registry': None,
    }


ANNOTATIONS = [
    {'label': 'run', 'text': 'running starts', 'target': 'all', 't_session_s': RUN_START},
    {'label': 'hit', 'text': 'head hit', 'target': 'all', 't_session_s': IMPACTS[0]},
]


def build(mode, dur, seed=5):
    """Every file's text for one finished session, as {filename: str}."""
    rng = np.random.default_rng(seed)
    files, counts = {}, {}
    for kind, hz in RATES[mode].items():
        t = stream_times(hz, dur)
        files[f'{BASE}_{kind}.csv'] = header(kind) + csv_rows(kind, t, signals(t, kind, rng))
        counts[kind] = len(t)
    frames = ['frame,stream,frame_type,rx_session_s,t_sensor_ns_last,samples,first_i,gap_missing_est']
    if mode == 'polar':
        th = np.arange(1, dur, 1.0)
        files[f'{BASE}_hr.csv'] = 'i,t_session_s,hr_bpm,sensor_contact,rr_ms\n' + ''.join(f'{i},{x:.4f},{int(v)},1,\n' for i, (x, v) in enumerate(zip(th, polar_hr(th))))
        counts['hr'] = len(th)
    files[f'{BASE}_frames.csv'] = '\n'.join(frames) + '\n'
    tt = np.arange(0, dur, 1.0)
    files['synthetic_truth.csv'] = 't_session_s,hr_bpm\n' + ''.join(f'{x:.1f},{v:.3f}\n' for x, v in zip(tt, hr_true(tt)))
    files['annotations.jsonl'] = ''.join(json.dumps(a) + '\n' for a in ANNOTATIONS)
    return files, counts


def write_session(out_dir, name, mode='polar', dur=300.0, as_zip=False):
    """Write a finished session folder (or zip). Refuses to replace anything that exists."""
    files, counts = build(mode, dur)
    files['manifest.json'] = json.dumps(manifest(name, mode, dur, counts, True), indent=1)
    if as_zip:
        path = os.path.join(out_dir, f'{name}.zip')
        if os.path.exists(path):
            raise FileExistsError(path)
        os.makedirs(out_dir, exist_ok=True)
        with zipfile.ZipFile(path, 'x', zipfile.ZIP_DEFLATED) as z:
            for fn, text in files.items():
                z.writestr(f'{name}/{fn}', text)
        return path
    path = os.path.join(out_dir, name)
    os.makedirs(path, exist_ok=False)
    for fn, text in files.items():
        with open(os.path.join(path, fn), 'x', encoding='utf-8', newline='') as f:
            f.write(text)
    return path


class LiveWriter:
    """Writes a session the way tools/receive.mjs builds a live copy: CSVs grow by appends (the last
    line may be cut mid way), manifest.json is swapped in whole, _ended.json comes last."""

    def __init__(self, out_dir, name, mode='polar', dur=300.0, seed=5):
        self.path = os.path.join(out_dir, name)
        os.makedirs(self.path, exist_ok=False)
        self.name, self.mode, self.dur = name, mode, dur
        files, self.counts = build(mode, dur, seed)
        self.manifest_done = files.pop('manifest.json', None)
        self.files = files
        self.lines = {fn: text.splitlines(keepends=True) for fn, text in files.items() if fn.endswith('.csv')}
        self.done = {fn: 0 for fn in self.lines}     # lines written
        self.pending = {fn: '' for fn in self.lines}  # second half of a line cut in two
        self.swap_manifest(False)

    def swap_manifest(self, ended):
        tmp = os.path.join(self.path, f'.manifest.json.{os.getpid()}.tmp')
        with open(tmp, 'x', encoding='utf-8') as f:
            f.write(json.dumps(manifest(self.name, self.mode, self.dur, self.counts, ended), indent=1))
        os.replace(tmp, os.path.join(self.path, 'manifest.json'))   # whole file swapped, as receive.mjs does

    def append_until(self, t_s, cut_last=False):
        """Append every row with t_session_s < t_s. cut_last leaves the last line half written."""
        for fn, lines in self.lines.items():
            k = self.done[fn]
            chunk = self.pending[fn]
            self.pending[fn] = ''
            if k == 0:
                chunk += lines[0]
                k = 1
            while k < len(lines):
                tcol = 1 if fn != 'synthetic_truth.csv' else 0
                parts = lines[k].split(',')
                if len(parts) <= tcol or float(parts[tcol]) >= t_s:
                    break
                chunk += lines[k]
                k += 1
            if cut_last and chunk and k > 1:
                half = len(lines[k - 1]) // 2
                self.pending[fn] = chunk[-(len(lines[k - 1]) - half):]
                chunk = chunk[:-(len(lines[k - 1]) - half)]
            self.done[fn] = k
            if chunk:
                with open(os.path.join(self.path, fn), 'a', encoding='utf-8', newline='') as f:
                    f.write(chunk)

    def finish(self):
        self.append_until(self.dur + 1)
        with open(os.path.join(self.path, 'annotations.jsonl'), 'a', encoding='utf-8') as f:
            f.write(self.files['annotations.jsonl'])
        self.swap_manifest(True)
        with open(os.path.join(self.path, '_ended.json'), 'x', encoding='utf-8') as f:
            f.write(json.dumps({'ended': datetime.now(timezone.utc).isoformat()}) + '\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('out')
    ap.add_argument('--mode', choices=list(RATES), default='polar')
    ap.add_argument('--dur', type=float, default=300.0)
    ap.add_argument('--name')
    ap.add_argument('--zip', action='store_true')
    ap.add_argument('--live', action='store_true', help='write over time like a live copy')
    ap.add_argument('--speed', type=float, default=1.0, help='live: session seconds per wall second')
    a = ap.parse_args()
    name = a.name or f'synthetic-{a.mode}-{datetime.now().strftime("%Y%m%d-%H%M%S")}'
    if a.live:
        w = LiveWriter(a.out, name, a.mode, a.dur)
        print(f'live session {w.path}', flush=True)
        t = 0.0
        while t < a.dur:
            t += 1.0
            w.append_until(t, cut_last=True)
            if int(t) % 10 == 0:
                w.swap_manifest(False)
            time.sleep(1.0 / a.speed)
        w.finish()
        print('ended', flush=True)
        return
    try:
        print(write_session(a.out, name, a.mode, a.dur, a.zip))
    except FileExistsError as e:
        sys.exit(f'{e} already exists; not touched.')


if __name__ == '__main__':
    main()
