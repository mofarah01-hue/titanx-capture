"""Comparison of HR lanes without a true HR: for each pair, on a 1 s grid, the mean absolute difference,
the share of seconds within 5 bpm, and coverage (seconds where both answer), split by motion level.

Motion level of a second = standard deviation of |acc| (g) over that second:
low < lo <= mid < hi <= high. Defaults 0.05 and 0.2 g: still or slow head movement, steady
activity, hard movement. Both thresholds are settable from the GUI.
"""
import math

import numpy as np

LEVELS = ('all', 'low', 'mid', 'high')


def on_seconds(answer, grid, tol=0.75):
    """Each grid second's estimate (nearest within tol s), NaN where the lane gave no answer."""
    out = np.full(len(grid), np.nan)
    if not answer:
        return out
    t = np.array([a['t'] for a in answer], float)
    b = np.array([np.nan if a['bpm'] is None else a['bpm'] for a in answer], float)
    o = np.argsort(t)
    t, b = t[o], b[o]
    i = np.clip(np.searchsorted(t, grid), 1, len(t) - 1) if len(t) > 1 else np.zeros(len(grid), int)
    if len(t) > 1:
        left = np.abs(grid - t[i - 1]) <= np.abs(t[i] - grid)
        i = np.where(left, i - 1, i)
    ok = np.abs(t[i] - grid) <= tol
    out[ok] = b[i[ok]]
    return out


def motion_levels(acc, grid, lo=0.05, hi=0.2):
    """'low' | 'mid' | 'high' | None (no ACC) per grid second."""
    lv = np.array([None] * len(grid), object)
    if acc is None or len(acc[0]) < 2:
        return lv
    t, v = np.asarray(acc[0], float), np.asarray(acc[1], float)
    g = np.sqrt((v[:, :3] ** 2).sum(1)) / 1000.0
    k = np.searchsorted(t, grid - 0.5), np.searchsorted(t, grid + 0.5)
    for j in range(len(grid)):
        seg = g[k[0][j]:k[1][j]]
        if len(seg) >= 3:
            s = seg.std()
            lv[j] = 'low' if s < lo else 'mid' if s < hi else 'high'
    return lv


def table(lanes, acc, span, lo=0.05, hi=0.2):
    """lanes: {name: [{t, bpm}]}. Returns {pairs: [...], lanes: [...], seconds: {level: n}}."""
    if not span or span[1] - span[0] < 1:
        return {'pairs': [], 'lanes': [], 'seconds': {}}
    grid = np.arange(math.ceil(span[0]), math.floor(span[1]) + 1, 1.0)
    lv = motion_levels(acc, grid, lo, hi)
    masks = {'all': np.ones(len(grid), bool), **{L: lv == L for L in ('low', 'mid', 'high')}}
    vals = {n: on_seconds(a, grid) for n, a in lanes.items()}
    names = list(lanes)
    out_l, out_p = [], []
    for n in names:
        for L in LEVELS:
            m = masks[L]
            tot = int(m.sum())
            out_l.append({'lane': n, 'level': L, 'seconds': tot, 'coverage': float(np.isfinite(vals[n][m]).mean()) if tot else None})
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            for L in LEVELS:
                m = masks[L]
                tot = int(m.sum())
                both = m & np.isfinite(vals[a]) & np.isfinite(vals[b])
                d = np.abs(vals[a][both] - vals[b][both])
                out_p.append({'a': a, 'b': b, 'level': L, 'seconds': tot, 'both': int(both.sum()),
                              'mad': float(d.mean()) if len(d) else None, 'within5': float((d <= 5).mean()) if len(d) else None,
                              'coverage': float(both.sum() / tot) if tot else None})
    return {'pairs': out_p, 'lanes': out_l, 'seconds': {L: int(masks[L].sum()) for L in LEVELS}}
