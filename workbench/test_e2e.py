"""End to end check of the workbench on synthetic sessions only (never on real recordings).

  python workbench/test_e2e.py

1. HR against a known answer. A synthetic Polar mode session and a Max mode session (make_synthetic.py:
   70 bpm rising to 160, running-like motion about 4x the pulse, two head hits) go through the files the
   app writes, the session reader, the Python pipeline and the real iPad engine (Node, motionhr.js).
   Bounds, after a 20 s warm up:
     - default pipeline and iPad engine: MAE under 4 bpm (the bound tests/unit/motionhr.test.mjs uses)
       and an answer in at least 60 % of seconds (the confidence gate drops the rest)
     - motion removal off (NLMS and cadence notch off): MAE at least 3x the MAE with it on
   Failure it catches: motion locking the HR (wrong references, broken NLMS), a pipeline that drifts from
   the JS engine, a reader that mis-times or mis-scales a stream.
2. Live tail. A session is written over time like tools/receive.mjs does (appends that cut the last line
   in half, manifest swapped in whole, _ended.json at the end). After every append the tailer must have
   exactly the whole lines on disk, never a row from a half line, the right last value, and live must
   flip to ended at the end.
Writes result.json next to the synthetic sessions (workbench/.synthetic/e2e-<time>/) and exits 1 on any failure.
"""
import json
import os
import sys
import time
from datetime import datetime

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import engines         # noqa: E402
import make_synthetic as ms   # noqa: E402
import sessions        # noqa: E402

MAE_MAX, COVERAGE_MIN, OFF_RATIO_MIN, WARM_S = 4.0, 0.6, 3.0, 20.0
OFF = {'nlms': {'on': False}, 'notch': {'on': False}}
fails, result = [], {}


def check(ok, what):
    print(('  ok    ' if ok else '  FAIL  ') + what)
    if not ok:
        fails.append(what)


def score(answer):
    e = [a for a in answer if a['t'] > WARM_S]
    got = [a for a in e if a['bpm'] is not None]
    mae = float(np.mean([abs(a['bpm'] - float(ms.hr_true(a['t']))) for a in got])) if got else float('inf')
    return {'mae': round(mae, 3), 'coverage': round(len(got) / max(1, len(e)), 3), 'seconds': len(e)}


def hr_check(root, mode):
    path = ms.write_session(root, f'synthetic-{mode}', mode, 300.0)
    s = sessions.Session('test', path, 'folder')
    base = s.devices()[0]['base']
    st = s.signals(base)
    rates = {k: round((len(t) - 1) / (t[-1] - t[0]), 1) for k, (t, _) in st.items() if k != 'hr'}
    print(f'\n{mode} mode session {path}\n  streams read: ' + ', '.join(f'{k} {v} Hz' for k, v in rates.items()))
    for k, hz in ms.RATES[mode].items():
        check(abs(rates[k] - hz) < 0.5, f'{k} read at {rates[k]} Hz, written at {hz} Hz')
    r = {}
    t0 = time.time(); p_on = engines.run_pipeline(st, None); r['python default'] = {**score(p_on['answer']), 'ms': int((time.time() - t0) * 1000)}
    r['python motion removal off'] = score(engines.run_pipeline(st, OFF)['answer'])
    r['python viterbi'] = score(engines.run_pipeline(st, {'viterbi': {'on': True}})['answer'])
    j_on = engines.run_ipad(st)
    r['iPad engine default'] = {**score(j_on['answer']), 'ms': j_on['ms']}
    r['iPad engine motion removal off'] = score(engines.run_ipad(st, {**OFF, 'gate': {'on': True}})['answer'])
    r['iPad engine viterbi'] = score(engines.run_ipad(st, viterbi=True)['answer'])
    # Python port against the JS engine, second by second
    js = {round(e['t'], 2): e['bpm'] for e in j_on['est']}
    both = [(e['bpm'], js[round(e['t'], 2)]) for e in p_on['est'] if round(e['t'], 2) in js and e['bpm'] is not None and js[round(e['t'], 2)] is not None]
    agree = {'seconds_both': len(both), 'mean_abs_diff_bpm': round(float(np.mean([abs(a - b) for a, b in both])), 3) if both else None,
             'seconds_matched': sum(1 for e in p_on['est'] if round(e['t'], 2) in js), 'seconds_js': len(js)}
    if 'hr' in st:
        r['Polar HR (synthetic, 4 s behind)'] = score([{'t': float(t), 'bpm': float(v)} for t, v in zip(st['hr'][0], st['hr'][1][:, 0])])
    for name, x in r.items():
        print(f'  {name:34s} MAE {x["mae"]:7.2f} bpm   answered {x["coverage"] * 100:5.1f} % of {x["seconds"]} s' + (f'   {x["ms"]} ms' if 'ms' in x else ''))
    print(f'  python vs iPad engine: {agree["mean_abs_diff_bpm"]} bpm mean difference over {agree["seconds_both"]} seconds both answered ({agree["seconds_matched"]} of {agree["seconds_js"]} ticks on the same times)')
    for k in ('python default', 'iPad engine default'):
        check(r[k]['mae'] < MAE_MAX, f'{k}: MAE {r[k]["mae"]} < {MAE_MAX} bpm')
        check(r[k]['coverage'] >= COVERAGE_MIN, f'{k}: answered {r[k]["coverage"]} >= {COVERAGE_MIN}')
    for on, off in (('python default', 'python motion removal off'), ('iPad engine default', 'iPad engine motion removal off')):
        check(r[off]['mae'] >= OFF_RATIO_MIN * r[on]['mae'], f'motion removal on beats off: {r[on]["mae"]} vs {r[off]["mae"]} bpm (needs {OFF_RATIO_MIN}x)')
    check(agree['mean_abs_diff_bpm'] is not None and agree['mean_abs_diff_bpm'] < 1.0, f'python pipeline within 1 bpm of the iPad engine on average ({agree["mean_abs_diff_bpm"]})')
    result[mode] = {'session': path, 'rates': rates, 'scores': r, 'python_vs_ipad': agree}


def live_check(root):
    print('\nlive tail')
    w = ms.LiveWriter(root, 'synthetic-live', 'polar', 60.0)
    lib = sessions.Library(root, [])
    sid = 'live:synthetic-live'
    lib.scan()
    s = lib.get(sid)
    check(s.live, 'a live folder without _ended.json is live')
    base = f'{ms.BASE}'
    fn = os.path.join(w.path, f'{base}_ppg.csv')
    steps, half_seen = 0, 0
    for t_end in np.arange(1.0, 61.0, 1.7):
        w.append_until(float(t_end), cut_last=True)
        raw = open(fn, 'rb').read()
        whole = raw.count(b'\n') - 1               # minus the header
        half_seen += not raw.endswith(b'\n')
        st = s.stream(base, 'ppg')
        n = len(st[0]) if st else 0
        if n != whole:
            check(False, f'after appending to {t_end:.1f} s the tailer has {n} rows, the file has {whole} whole lines')
            break
        if n:
            last_line = raw[:raw.rfind(b'\n')].split(b'\n')[-1].decode().split(',')
            if abs(st[0][-1] - float(last_line[1])) > 1e-9 or abs(st[1][-1, 0] - float(last_line[3])) > 1e-9:
                check(False, f'last row read {st[0][-1]}, {st[1][-1, 0]} is not the last whole line {last_line[1]}, {last_line[3]}')
                break
        if steps % 10 == 0:
            w.swap_manifest(False)
            check(bool(s.manifest().get('session')), f'manifest readable after a swap at {t_end:.1f} s')
        steps += 1
    else:
        check(True, f'{steps} appends: the tailer always held exactly the whole lines; {half_seen} times the file ended in a half line, never read')
    offset_before = s.tails[f'{base}_ppg.csv'].offset
    w.finish()
    st = s.stream(base, 'ppg')
    total = len(w.lines[f'{base}_ppg.csv']) - 1
    check(len(st[0]) == total, f'after the end: {len(st[0])} rows read, {total} written')
    check(s.tails[f'{base}_ppg.csv'].offset > offset_before, 'reads continued from the byte offset')
    check(not s.live, '_ended.json turns the session from live to ended')
    result['live'] = {'session': w.path, 'appends': steps, 'half_lines_seen': half_seen, 'rows': int(len(st[0]))}


def main():
    root = os.path.join(HERE, '.synthetic', f'e2e-{datetime.now().strftime("%Y%m%d-%H%M%S")}')
    os.makedirs(root, exist_ok=False)
    hr_check(root, 'polar')
    hr_check(root, 'max')
    live_check(os.path.join(root, 'live'))
    result['bounds'] = {'mae_max_bpm': MAE_MAX, 'coverage_min': COVERAGE_MIN, 'off_ratio_min': OFF_RATIO_MIN, 'warm_up_s': WARM_S}
    result['failures'] = fails
    with open(os.path.join(root, 'result.json'), 'x', encoding='utf-8') as f:
        json.dump(result, f, indent=1)
    print(f'\n{"PASS" if not fails else f"FAIL ({len(fails)})"}  result: {os.path.join(root, "result.json")}')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
