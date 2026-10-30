"""Everything that turns a session into HR lanes: the Python pipeline, the iPad engine (Node subprocess),
Polar's own HR, the synthetic truth, and model plugins (models/)."""
import json
import os
import shutil
import subprocess
import time

import numpy as np

import pipeline

HERE = os.path.dirname(os.path.abspath(__file__))
NODE = shutil.which('node') or 'node'


def pack(streams, header):
    """Header line plus float64 times and float32 values per stream (the run_engine.mjs / worker format)."""
    meta, blobs = [], []
    for key, (t, v) in streams.items():
        t = np.ascontiguousarray(t, '<f8')
        v = np.ascontiguousarray(np.asarray(v).reshape(len(t), -1), '<f4')
        meta.append({'key': key, 'n': int(len(t)), 'ch': int(v.shape[1])})
        blobs += [t.tobytes(), v.tobytes()]
    return (json.dumps({**header, 'streams': meta}) + '\n').encode() + b''.join(blobs)


def run_ipad(streams, cfg=None, viterbi=False, max_hr=None, timeout=600):
    """core/algo/motionhr.js runOffline through Node. cfg None = the engine's own defaults."""
    use = {k: streams[k] for k in ('ppg', 'acc', 'gyro', 'mag') if k in streams}
    t0 = time.time()
    p = subprocess.run([NODE, os.path.join(HERE, 'run_engine.mjs')], input=pack(use, {'kind': 'polar', 'cfg': cfg}),
                       capture_output=True, timeout=timeout, cwd=HERE)
    if p.returncode:
        raise RuntimeError(f'iPad engine (node run_engine.mjs) failed: {p.stderr.decode(errors="replace")[-800:]}')
    r = json.loads(p.stdout)
    if viterbi:
        conf = {round(e['t'], 3): e['conf'] for e in r['est']}
        answer = [{'t': x['t'], 'bpm': x['bpm'], 'conf': conf.get(round(x['t'], 3), 0.0)} for x in r['post']]
    else:
        answer = [{'t': e['t'], 'bpm': e['bpm'], 'conf': e['conf']} for e in r['est']]
    for a in answer:
        a['zone'] = pipeline.zone_of(a['bpm'], max_hr)
    return {'answer': answer, 'est': r['est'], 'post': r['post'], 'ms': int((time.time() - t0) * 1000), 'node_ms': r['ms']}


def polar_hr(streams, max_hr=None):
    if 'hr' not in streams:
        return None
    t, v = streams['hr']
    return [{'t': float(a), 'bpm': float(b), 'conf': 1.0, 'zone': pipeline.zone_of(float(b), max_hr)} for a, b in zip(t, v[:, 0])]


def truth_lane(truth, max_hr=None):
    if truth is None:
        return None
    t, v = truth
    return [{'t': float(a), 'bpm': float(b), 'conf': 1.0, 'zone': pipeline.zone_of(float(b), max_hr)} for a, b in zip(t, v)]


def run_pipeline(streams, cfg):
    t0 = time.time()
    r = pipeline.run(streams, cfg)
    r['ms'] = int((time.time() - t0) * 1000)
    return r
