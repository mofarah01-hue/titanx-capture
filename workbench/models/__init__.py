"""Model plugins. Each model runs as a subprocess in its own venv (workbench/.venv-<name>), so TensorFlow
and its pins never touch the server's Python, and a model that failed to install just shows as missing.

One interface for every model:
  available() -> (ok, why)
  run(streams) -> [{t, bpm, conf, std}]      whole recording (or a live session so far)
  push(streams) -> [{t, bpm, conf, std}]     live: give it everything so far; it re-runs on the last
                                             `context_s` seconds and returns only windows it had not given yet
streams is the session's {'ppg': (t, v), 'acc': (t, v), ...}; t in seconds (t_session_s).
"""
import json
import math
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import engines   # noqa: E402  (pack format)
import pipeline  # noqa: E402  (PPG segments)


def venv_python(name):
    return os.path.join(ROOT, f'.venv-{name}', 'Scripts' if os.name == 'nt' else 'bin', 'python.exe' if os.name == 'nt' else 'python')


def fused_ppg(streams):
    """Mean of the three greens minus ambient, flipped so a beat points up (the research note's input)."""
    t, v = streams['ppg']
    v = np.asarray(v, float)
    g = v[:, :3].mean(1) - v[:, 3] if v.shape[1] >= 4 else v[:, 0]
    return np.asarray(t, float), -g


def on_grid(t, x, grid):
    x = np.asarray(x, float).reshape(len(t), -1)
    return np.stack([np.interp(grid, t, x[:, c]) for c in range(x.shape[1])], 1)


class HrModel:
    name = label = licence = package = ''
    fs = 64
    min_s = 22.0         # shortest stretch worth sending
    context_s = 60.0     # live: how much history push() re-runs on
    timeout = 900

    def __init__(self):
        self.last_t = -math.inf

    def available(self):
        py = venv_python(self.name)
        if not os.path.exists(py):
            return False, f'no venv at {os.path.dirname(os.path.dirname(py))} (see README, Models)'
        site = os.path.join(ROOT, f'.venv-{self.name}', 'Lib', 'site-packages', self.package)
        if os.name == 'nt' and not os.path.isdir(site):
            return False, f'{self.package} is not installed in .venv-{self.name}'
        return True, ''

    def conf_of(self, std):
        """0..1 from the model's own spread in bpm: 1 at 0, 0.37 at 10 bpm."""
        return float(math.exp(-max(0.0, std) / 10))

    def run(self, streams):
        ok, why = self.available()
        if not ok:
            raise RuntimeError(f'{self.label} is not available: {why}')
        if 'ppg' not in streams or 'acc' not in streams:
            raise RuntimeError(f'{self.label} needs PPG and ACC')
        tp, ppg = fused_ppg(streams)
        ta, av = np.asarray(streams['acc'][0], float), np.asarray(streams['acc'][1], float)[:, :3] / 1000.0   # mG -> g
        out = []
        for (s0, s1) in pipeline.ppg_segments(tp, max(tp[0], ta[0]), min(tp[-1], ta[-1])):
            if s1 - s0 < self.min_s:
                continue
            grid = np.arange(s0, s1, 1 / self.fs)
            data = {'ppg': (grid, on_grid(tp, ppg, grid)), 'acc': (grid, on_grid(ta, av, grid))}
            p = subprocess.run([venv_python(self.name), '-I', os.path.join(HERE, f'{self.name}_worker.py')],
                               input=engines.pack(data, {'fs': self.fs}), capture_output=True, timeout=self.timeout, cwd=HERE,
                               env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
            if p.returncode:
                raise RuntimeError(f'{self.label} worker failed: {p.stderr.decode(errors="replace")[-1200:]}')
            r = json.loads(p.stdout.decode().strip().splitlines()[-1])
            for t, b, s in zip(r['t'], r['bpm'], r['std']):
                out.append({'t': s0 + t, 'bpm': float(b), 'std': float(s), 'conf': self.conf_of(float(s))})
        return out

    def push(self, streams):
        tp = streams['ppg'][0]
        cut = tp[-1] - self.context_s
        part = {k: (t[t >= cut], v[t >= cut]) for k, (t, v) in ((k, (np.asarray(a), np.asarray(b))) for k, (a, b) in streams.items())}
        new = [e for e in self.run(part) if e['t'] > self.last_t]
        if new:
            self.last_t = new[-1]['t']
        return new


class BeliefPPG(HrModel):
    name, label, licence, package = 'beliefppg', 'BeliefPPG', 'MIT', 'beliefppg'
    fs = 64


class KidPPG(HrModel):
    name, label, licence, package = 'kidppg', 'KID-PPG', 'GPL-3.0 (desktop comparison only, never shipped)', 'kid_ppg'
    fs = 32
    min_s = 12.0


MODELS = {m.name: m for m in (BeliefPPG, KidPPG)}


def status():
    out = []
    for name, cls in MODELS.items():
        ok, why = cls().available()
        out.append({'name': name, 'label': cls.label, 'licence': cls.licence, 'available': ok, 'why': why})
    return out
