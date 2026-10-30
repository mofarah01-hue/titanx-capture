"""Heart rate pipeline for the workbench: a Python port of core/algo/motionhr.js with a choice of method
at each stage, so variants can be compared side by side on one recording.

Defaults equal motionhr.js defaultConfig(); with every method at its default this follows the JS engine
step by step (same filters, same once-a-second estimate, same tracker and gate). Added here only:
  fusion.method    'snr' (JS auto), 'mean', 'best' (single strongest channel), 'manual' (fusion.weights)
  nlms.refs        'acc', 'acc+gyro' (JS default: mag weights 0), 'acc+gyro+mag'; nlms.on false = none
  estimate.method  'blend' (JS), 'spectral', 'beats'
  viterbi.on       the run's answer is the Viterbi path (motionhr.js runOffline `post`) instead of the live one
  zones            max HR from age (Tanaka 208 - 0.7 age) unless max_hr is given

Band-pass "off" keeps a wide 0.3 to 5 Hz band, as motionhr.js does: without it the PPG's DC level
would swamp NLMS and the spectrum.
"""
import copy
import math

import numpy as np
from scipy.signal import lfilter, lfilter_zi

FS = 25
F_LO, F_HI = 0.6, 3.6
NFFT = 1024
WINDOW_S = 8
MIN_BEAT_S = 60 / 220
Q_BUTTER = math.sqrt(0.5)


def default_config():
    return {
        'resample': {'on': True},
        'ambient': {'on': True},
        'bandpass': {'on': True, 'lo': 0.5, 'hi': 4},
        'fusion': {'on': True, 'auto': True, 'weights': [1, 1, 1], 'method': 'snr'},
        'nlms': {'on': True, 'mu': 0.1, 'taps': 8, 'w': {'acc': [1, 1, 1], 'gyro': [1, 1, 1], 'mag': [0, 0, 0]}, 'refs': 'acc+gyro'},
        'notch': {'on': True, 'width': 0.1, 'minG': 0.08},
        'beats': {'on': True, 'tol': 0.3, 'minProm': 0.6},
        'estimate': {'on': True, 'spectral': 0.7, 'peaks': 0.3, 'method': 'blend'},
        'tracker': {'on': True, 'maxStep': 10, 'hold': 5},
        'gate': {'on': True, 'min': 0.45},
        'impact': {'on': True, 'g': 6, 'freeze': 0.5},
        'viterbi': {'on': False},
        'zones': {'age': 30, 'max_hr': None},
    }


def merge_config(c):
    """A saved or partial config over the defaults (as motionhr.js mergeConfig)."""
    d = default_config()
    if not isinstance(c, dict):
        return d
    for k, v in c.items():
        if k in d and isinstance(v, dict):
            d[k] = {**d[k], **v}
            if k == 'nlms':
                d['nlms']['w'] = {**default_config()['nlms']['w'], **(v.get('w') or {})}
    # refs picks the motion axes; it wins over w when given
    refs = d['nlms'].get('refs')
    if refs:
        use = set(refs.split('+'))
        d['nlms']['w'] = {k: (d['nlms']['w'][k] if any(d['nlms']['w'][k]) else [1, 1, 1]) if k in use else [0, 0, 0] for k in ('acc', 'gyro', 'mag')}
    m = d['fusion'].get('method') or ('snr' if d['fusion'].get('auto', True) else 'manual')
    d['fusion']['method'] = m
    d['fusion']['auto'] = m == 'snr'
    return d


def js_config(cfg):
    """The parts of a config motionhr.js understands (for running the same settings in the iPad engine)."""
    c = merge_config(cfg)
    out = {k: copy.deepcopy(c[k]) for k in ('resample', 'ambient', 'bandpass', 'fusion', 'nlms', 'notch', 'beats', 'estimate', 'tracker', 'gate', 'impact')}
    if c['fusion']['method'] == 'mean':
        out['fusion'].update(auto=False, weights=[1 / 3] * 3)
    return out


def max_hr_of(zones):
    if zones.get('max_hr'):
        return float(zones['max_hr'])
    if zones.get('age'):
        return round(208 - 0.7 * float(zones['age']))
    return None


def zone_of(hr, max_hr):
    """0 = below zone 1, 1..5 = zones at 50/60/70/80/90 % of max (core/registry.js zoneOf)."""
    if not max_hr or hr is None or not math.isfinite(hr):
        return None
    p = hr / max_hr
    return 0 if p < 0.5 else 1 if p < 0.6 else 2 if p < 0.7 else 3 if p < 0.8 else 4 if p < 0.9 else 5


# ---------- filters (RBJ cookbook biquads, as core/algo/filters.js) ----------
def _design(kind, fs, f0, q=Q_BUTTER):
    if not (0 < f0 < fs / 2):
        raise ValueError(f'{kind} corner {f0} Hz must be between 0 and {fs / 2} Hz')
    w = 2 * math.pi * f0 / fs
    c, alpha = math.cos(w), math.sin(w) / (2 * q)
    a0 = 1 + alpha
    b = [(1 - c) / 2, 1 - c, (1 - c) / 2] if kind == 'low' else [(1 + c) / 2, -(1 + c), (1 + c) / 2]
    return np.array(b) / a0, np.array([1, -2 * c / a0, (1 - alpha) / a0])


def _primed(b, a, x):
    """filters.js Biquad: the first sample sets the steady state for a constant input, so the DC
    level of raw counts does not ring. scipy's zi is for the same transposed direct form II."""
    if len(x) == 0:
        return x
    return lfilter(b, a, x, zi=lfilter_zi(b, a) * x[0])[0]


def bandpass(x, fs, lo, hi):
    """filters.js BandPass: high-pass then low-pass, each primed on its own first input."""
    bh, ah = _design('high', fs, lo)
    bl, al = _design('low', fs, hi)
    return _primed(bl, al, _primed(bh, ah, x))


class Biquad:
    """Scalar transposed direct form II with in-place retuning (the cadence notch)."""

    def __init__(self, b0=1.0, b1=0.0, b2=0.0, a1=0.0, a2=0.0):
        self.b0, self.b1, self.b2, self.a1, self.a2 = b0, b1, b2, a1, a2
        self.z1 = self.z2 = 0.0
        self.primed = False
        self.on = False

    def step(self, x):
        if not self.primed:
            y0 = ((self.b0 + self.b1 + self.b2) / (1 + self.a1 + self.a2)) * x
            self.z2 = self.b2 * x - self.a2 * y0
            self.z1 = self.b1 * x - self.a1 * y0 + self.z2
            self.primed = True
            return y0
        y = self.b0 * x + self.z1
        self.z1 = self.b1 * x - self.a1 * y + self.z2
        self.z2 = self.b2 * x - self.a2 * y
        return y

    def notch(self, fs, f0, bw):
        w = 2 * math.pi * f0 / fs
        c = math.cos(w)
        alpha = math.sin(w) * math.sinh(math.log(2) / 2 * (bw / f0) * w / math.sin(w))
        a0 = 1 + alpha
        self.b0, self.b1, self.b2, self.a1, self.a2 = 1 / a0, -2 * c / a0, 1 / a0, -2 * c / a0, (1 - alpha) / a0


def ema(x, alpha_first, alpha, n_first, s0=0.0):
    """Running mean of x: s += (x - s) * alpha, with a faster alpha for the first n_first samples."""
    out = np.empty(len(x))
    k = min(n_first, len(x))
    if k:
        out[:k] = lfilter([alpha_first], [1, -(1 - alpha_first)], x[:k], zi=[(1 - alpha_first) * s0])[0]
        s0 = out[k - 1]
    if len(x) > k:
        out[k:] = lfilter([alpha], [1, -(1 - alpha)], x[k:], zi=[(1 - alpha) * s0])[0]
    return out


# ---------- spectrum and peaks ----------
class Spectrum:
    """Power between F_LO and F_HI of an evenly sampled window: Hann, mean removed, zero padded to NFFT."""

    def __init__(self, n, fs=FS):
        self.n = n
        self.k0, self.k1 = math.ceil(F_LO * NFFT / fs), math.floor(F_HI * NFFT / fs)
        self.f = np.arange(self.k0, self.k1 + 1) * fs / NFFT
        self.win = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n) / (n - 1))

    def of(self, x):
        X = np.fft.rfft((x - x.mean()) * self.win, NFFT)[self.k0:self.k1 + 1]
        return X.real ** 2 + X.imag ** 2


def pick_peak(sp, p, weight=None):
    """Strongest local peak of p (optionally weighted), parabola refined. {j, f, share} or None."""
    total = p.sum()
    if not total > 0:
        return None
    mid = p[1:-1]
    cand = np.nonzero((mid >= p[:-2]) & (mid >= p[2:]))[0] + 1
    if not len(cand):
        return None
    s = p[cand] * (weight(sp.f[cand]) if weight else 1)
    bj = int(cand[int(np.argmax(s))])
    y0, y1, y2 = p[bj - 1], p[bj], p[bj + 1]
    d = y0 - 2 * y1 + y2
    off = max(-0.5, min(0.5, 0.5 * (y0 - y2) / d)) if d else 0
    df = sp.f[1] - sp.f[0]
    span = round(0.1 / df)
    near = p[max(0, bj - span):min(len(p) - 1, bj + span) + 1].sum()
    return {'j': bj, 'f': sp.f[bj] + off * df, 'share': near / total}


def estimate_bpm(intervals):
    """core/algo/hr.js estimateBpm: median screened mean of beat intervals, with a quality 0..1."""
    iv = [x for x in intervals if MIN_BEAT_S <= x <= 2]
    if len(iv) < 3:
        return None
    med = float(np.median(iv))
    good = [x for x in iv if abs(x - med) <= 0.2 * med]
    if len(good) < 3:
        return None
    mean = sum(good) / len(good)
    cv = math.sqrt(sum((x - mean) ** 2 for x in good) / len(good)) / mean
    q = (len(good) / len(intervals)) * max(0, 1 - cv / 0.15)
    if q < 0.2:
        return None
    return {'bpm': 60 / mean, 'quality': round(q * 100) / 100}


def viterbi(spectra, freqs, step=6):
    """motionhr.js viterbi: most likely heart line through the per-second spectra, future included."""
    N, B = len(spectra), len(freqs)
    if not N:
        return []
    df = (freqs[1] - freqs[0]) * 60
    K = math.ceil(3 * step / df)

    def em(p):
        return np.log(p / (p.sum() or 1) + 1e-6)

    score = em(spectra[0][1])
    back = []
    idx = np.arange(B)
    for n in range(1, N):
        gap = max(1.0, spectra[n][0] - spectra[n - 1][0])
        kk = min(B, math.ceil(K * gap))
        offs = np.arange(-kk, kk + 1)
        src = idx[:, None] + offs[None, :]
        ok = (src >= 0) & (src < B)
        cand = np.where(ok, score[np.clip(src, 0, B - 1)] - (offs[None, :] * df / (step * gap)) ** 2, -np.inf)
        bi = np.argmax(cand, 1)        # first best, as the JS loop over ascending i
        back.append(src[idx, bi])
        score = cand[idx, bi] + em(spectra[n][1])
    j = int(np.argmax(score))
    path = [None] * N
    for n in range(N - 1, -1, -1):
        path[n] = {'t': spectra[n][0], 'bpm': float(freqs[j] * 60)}
        if n:
            j = int(back[n - 1][j])
    return path


# ---------- resampling ----------
def interp_valid(T, V, tq):
    """motionhr.js at(): linear interpolation, None (invalid) outside the data or across a gap > 0.5 s."""
    n = len(T)
    if n < 2:
        return np.zeros((len(tq), V.shape[1])), np.zeros(len(tq), bool)
    i = np.searchsorted(T, tq, 'right') - 1
    ok = (i >= 0) & (i + 1 < n)
    ic = np.clip(i, 0, n - 2)
    a, b = T[ic], T[ic + 1]
    ok &= (b - a) <= 0.5
    f = np.where(b > a, (tq - a) / np.where(b > a, b - a, 1), 0)[:, None]
    v = V[ic] + (V[ic + 1] - V[ic]) * f
    ok &= np.isfinite(v).all(1)
    return v, ok


def ppg_segments(T, start, end):
    """Grid segments where the PPG is continuous: (t0, t1) pairs, t0 at a sample, grid points t < t1."""
    br = np.nonzero(np.diff(T) > 0.5)[0]
    starts = np.concatenate([[T[0]], T[br + 1]])
    stops = np.concatenate([T[br], [T[-1]]])
    out = []
    for a, b in zip(starts, stops):
        a, b = max(a, start), min(b, end)
        if b - a > 1 / FS:
            out.append((a, b))
    return out


# ---------- the engine ----------
def run(streams, cfg=None, kind='polar'):
    """Run the pipeline over a whole recording.

    streams: {'ppg': (t, v[n, ch]), 'acc': ..., 'gyro': ..., 'mag': ...} with t in seconds (t_session_s).
    Returns {est: [per second dict], post: [{t, bpm}], answer: [{t, bpm, conf, zone}], beats: [[t, ok]],
             traces: {name: (t, v)}, cfg}.
    """
    cfg = merge_config(cfg)
    if 'ppg' not in streams or len(streams['ppg'][0]) < 2:
        raise ValueError('this recording has no PPG')
    pt, pv = streams['ppg']
    pt = np.asarray(pt, float)
    pv = np.asarray(pv, float).reshape(len(pt), -1)
    nch_rec = pv.shape[1]
    green = [0, 1, 2] if nch_rec >= 4 else [0]
    amb_ch = 3 if nch_rec >= 4 else None
    nCh = len(green)
    W = WINDOW_S * FS
    sp = Spectrum(W)
    bp_lo, bp_hi = (cfg['bandpass']['lo'], cfg['bandpass']['hi']) if cfg['bandpass']['on'] else (0.3, 5)
    bp_hi = min(bp_hi, FS / 2 - 0.5)
    taps = int(cfg['nlms']['taps'])
    wk = [np.array(cfg['nlms']['w'][k], float) for k in ('acc', 'gyro', 'mag')]
    fm = cfg['fusion']['method']

    # grid end: the last PPG time, cut to a motion stream that ends sooner (unless it lags by 2 s or more)
    end = pt[-1]
    for k in ('acc', 'gyro', 'mag'):
        if k in streams and len(streams[k][0]):
            last = streams[k][0][-1]
            if end - last < 2:
                end = min(end, last)
    segs = ppg_segments(pt, pt[0], end)

    st = {  # state that lives across PPG gaps (motionhr.js keeps these through fresh())
        'wts': np.full(nCh, 1 / nCh) if fm in ('snr', 'mean') else np.array([cfg['fusion']['weights'][i] if i < len(cfg['fusion']['weights']) else 0 for i in range(nCh)], float),
        'track': None, 'trackT': None, 'lastAnswerT': None, 'cadence': None, 'motionG': 0.0,
        'freezeUntil': -math.inf, 'impacts': 0, 'accScale': None, 'challengers': [],
    }
    if fm == 'best':
        st['wts'] = np.eye(nCh)[0]
    est, spectra, beats_out = [], [], []
    tr = {k: [] for k in ('t', 'raw', 'fused_raw', 'fused', 'nlms', 'clean', 'accG', 'gyroMag')}

    for (s0, s1) in segs:
        # grid by repeated addition, as the JS loop does (tg += dt), so the once-a-second ticks land on the same samples
        t = np.cumsum(np.concatenate([[s0], np.full(int((s1 - s0) * FS) + 2, 1 / FS)]))
        t = t[t < s1]
        n = len(t)
        if n < 2:
            continue
        x, ok = interp_valid(pt, pv, t)
        if not ok.all():   # should not happen inside a segment; cut at the first bad point
            n = int(np.argmin(ok))
            t, x = t[:n], x[:n]
        amb = x[:, amb_ch] if (cfg['ambient']['on'] and amb_ch is not None) else 0
        # 1-3 resample, ambient, band-pass; flip so a beat points up
        Y = np.stack([-bandpass(x[:, c] - amb, FS, bp_lo, bp_hi) for c in green], 1)
        scale = np.stack([ema(Y[:, c] ** 2, 0.2, 0.02, FS) for c in range(nCh)], 1)
        sq = np.sqrt(np.where(scale > 0, scale, 1))
        Yn = Y / sq   # unit size channels
        # display only: the fusion before band-pass, each channel on the scale of its band-passed RMS,
        # with a 4 s running mean taken off (edges averaged over what is there)
        rms = np.sqrt((Y ** 2).mean(0))
        raw_flip = np.stack([-(x[:, c] - amb) for c in green], 1) / np.where(rms > 0, rms, 1)
        k4 = min(4 * FS, n)
        kern = np.ones(k4)
        cnt = np.convolve(np.ones(n), kern, 'same')
        raw_flip = raw_flip - np.stack([np.convolve(raw_flip[:, c], kern, 'same') / cnt for c in range(nCh)], 1)

        # motion references, each band-passed over its own valid samples (JS steps a filter only when the axis has data)
        refs, rvalid = [], []
        for k in ('acc', 'gyro', 'mag'):
            if k in streams and len(streams[k][0]) >= 2:
                v, okm = interp_valid(np.asarray(streams[k][0], float), np.asarray(streams[k][1], float).reshape(len(streams[k][0]), -1)[:, :3], t)
            else:
                v, okm = np.zeros((n, 3)), np.zeros(n, bool)
            refs.append(v)
            rvalid.append(okm)
        a_raw, a_ok = refs[0], rvalid[0]
        if st['accScale'] is None and a_ok.any():
            st['accScale'] = 1000.0 if np.hypot.reduce(a_raw[np.argmax(a_ok)]) > 50 else 1.0
        accScale = st['accScale'] or 1.0
        accG = np.where(a_ok, np.sqrt((a_raw ** 2).sum(1)) / accScale, np.nan)
        gyroMag = np.where(rvalid[1], np.sqrt((refs[1] ** 2).sum(1)), np.nan)
        R = np.zeros((n, 9 * taps))
        accBp = np.zeros((n, 3))
        for r in range(3):
            okr = rvalid[r]
            idx = np.nonzero(okr)[0]
            for k in range(3):
                j = r * 3 + k
                v = np.zeros(n)
                if len(idx):
                    v[idx] = bandpass(refs[r][idx, k], FS, bp_lo, bp_hi)
                if r == 0:
                    accBp[:, k] = v / accScale
                rs = np.zeros(n)
                if len(idx):   # running size, updated only where the axis has data
                    sq_v = v ** 2
                    s, out = 0.0, np.zeros(n)
                    first = np.arange(n) < FS
                    # small loop: alpha depends on the grid count, the update on data presence
                    for i in range(n):
                        if okr[i]:
                            s += (sq_v[i] - s) * (0.2 if first[i] else 0.01)
                        out[i] = s
                    rs = out
                col = np.where(okr & (wk[r][k] != 0), v / np.sqrt(np.where(rs > 0, rs, 1)) * wk[r][k], 0)
                for lag in range(taps):   # R[n, j*taps + lag] = reference j, lag samples back (zero before the segment)
                    R[lag:, j * taps + lag] = col[:n - lag] if lag else col
        # impact freeze: frozen while t < (time of the last sample above g) + freeze
        frozen = np.zeros(n, bool)
        if cfg['impact']['on']:
            fz = cfg['impact']['freeze']
            hit = np.nan_to_num(accG, nan=0) > cfg['impact']['g']
            last_hit = np.maximum.accumulate(np.where(hit, t, -np.inf))
            frozen = t < np.maximum(last_hit + fz, st['freezeUntil'])
            for i in np.nonzero(hit)[0]:   # a hit after the last freeze ended is a new impact
                if t[i] > st['freezeUntil']:
                    st['impacts'] += 1
                st['freezeUntil'] = t[i] + fz
        acc_valid_cum = np.cumsum(a_ok)
        acc_valid_idx = np.nonzero(a_ok)[0]

        # sequential part: fusion with weights updated each second, NLMS, notch, beats, estimate
        wn = np.zeros(9 * taps)
        notch = Biquad()
        fused_a, nlms_a, clean_a = np.zeros(n), np.zeros(n), np.zeros(n)
        amp, y1, y2, t1, last_beat = 0.0, 0.0, 0.0, None, None
        beats = []
        next_est = None
        mu0 = cfg['nlms']['mu']
        nl_on = cfg['nlms']['on']
        bt_on = cfg['beats']['on']
        prom = cfg['beats']['minProm'] if bt_on else 0.3
        R_has = (R != 0).any(1)
        R_pow = 1e-6 + (R * R).sum(1)
        for i in range(n):
            ti = t[i]
            if cfg['fusion']['on']:
                f = float(Yn[i] @ st['wts'])
            else:
                f = float(Yn[i, 0])
            c = f
            if nl_on and R_has[i]:
                xi = R[i]
                c = f - float(wn @ xi)
                if not frozen[i]:
                    wn += (mu0 / R_pow[i] * c) * xi
            nlms_a[i] = c
            if cfg['notch']['on'] and notch.on:
                c = notch.step(c)
            fused_a[i] = f
            clean_a[i] = c
            # beats on the clean signal
            amp += (abs(c) - amp) * (1 / (FS * 2))
            if t1 is not None and y1 > y2 and y1 >= c and y1 > prom * amp and (last_beat is None or t1 - last_beat >= MIN_BEAT_S):
                trk = st['track']
                okb = (not bt_on) or (not (cfg['impact']['on'] and frozen[i]) and not (trk and last_beat is not None and abs(60 / (t1 - last_beat) - trk) > max(25, cfg['beats']['tol'] * trk) and len(beats) > 3))
                beats.append((t1, okb))
                beats_out.append([t1, okb])
                last_beat = t1
            y2, y1, t1 = y1, c, ti
            while beats and beats[0][0] < ti - WINDOW_S:
                beats.pop(0)
            if next_est is None:
                next_est = ti + 1
            if ti >= next_est:
                next_est += 1
                if i >= W:
                    e = _estimate(cfg, st, sp, ti, bool(frozen[i]), Y[i - W + 1:i + 1], clean_a[i - W + 1:i + 1],
                                  accBp[acc_valid_idx[max(0, acc_valid_cum[i] - W):acc_valid_cum[i]]] if acc_valid_cum[i] >= W else None,
                                  beats, notch, nCh, fm)
                    spectra.append((ti, e.pop('_p')))
                    est.append(e)
        tr['t'].append(t)
        tr['raw'].append(Yn[:, 0])
        tr['fused_raw'].append(raw_flip @ st['wts'] if cfg['fusion']['on'] else raw_flip[:, 0])
        tr['fused'].append(fused_a)
        tr['nlms'].append(nlms_a)
        tr['clean'].append(clean_a)
        tr['accG'].append(accG)
        tr['gyroMag'].append(gyroMag)

    step = max(3, cfg['tracker']['maxStep'] * 0.6) if cfg['tracker'].get('maxStep') else 6
    post = viterbi(spectra, sp.f, step) if spectra else []
    mx = max_hr_of(cfg['zones'])
    if cfg['viterbi']['on']:
        conf = {round(e['t'], 3): e['conf'] for e in est}
        answer = [{'t': p['t'], 'bpm': p['bpm'], 'conf': conf.get(round(p['t'], 3), 0.0)} for p in post]
    else:
        answer = [{'t': e['t'], 'bpm': e['bpm'], 'conf': e['conf']} for e in est]
    for a in answer:
        a['zone'] = zone_of(a['bpm'], mx)
    traces = {k: np.concatenate(v) if v else np.zeros(0) for k, v in tr.items()}
    return {'est': est, 'post': post, 'answer': answer, 'beats': beats_out, 'traces': traces, 'cfg': cfg, 'max_hr': mx}


def _estimate(cfg, st, sp, t, frozen, Ywin, cleanwin, accwin, beats, notch, nCh, fm):
    """Once a second: fusion weights, cadence, spectral and beat HR, tracker, confidence (motionhr.js estimate)."""
    track = st['track']
    # fusion weights from each channel's pulse to noise ratio near the tracked rate (or its own peak)
    if cfg['fusion']['on'] and fm in ('snr', 'best'):
        wfun = (lambda f: np.exp(-0.5 * ((f * 60 - track) / 12) ** 2)) if track else None
        snr = []
        for c in range(nCh):
            pk = pick_peak(sp, sp.of(Ywin[:, c]), wfun)
            snr.append(pk['share'] if pk else 0)
        snr = np.array(snr)
        if fm == 'best':
            if snr.max() > 0:
                st['wts'] = np.eye(nCh)[int(np.argmax(snr))]
        else:
            s = (snr ** 2).sum()
            if s > 0:
                st['wts'] = st['wts'] + ((snr ** 2) / s - st['wts']) * 0.3
    # movement size and rhythm from the band-passed ACC axes
    cad_share = 0
    if accwin is not None:
        s2 = float((accwin ** 2).sum())
        psum = sum(sp.of(accwin[:, k]) for k in range(3))
        st['motionG'] = math.sqrt(s2 / len(accwin))
        pk = pick_peak(sp, psum)
        st['cadence'] = pk['f'] if pk and pk['share'] > 0.2 and st['motionG'] > cfg['notch']['minG'] else None
        cad_share = pk['share'] if pk else 0
    else:
        st['motionG'], st['cadence'] = 0.0, None
    cadence, motionG = st['cadence'], st['motionG']
    fTrack = track / 60 if track else None
    notch.on = bool(cfg['notch']['on'] and cadence and (not fTrack or abs(cadence - fTrack) > 0.15))
    if notch.on:
        notch.notch(FS, cadence, cfg['notch']['width'] * 2)
    # spectral HR on the clean window
    p = sp.of(cleanwin)
    since = 0 if st['trackT'] is None else t - st['trackT']
    sigma = (cfg['tracker']['maxStep'] * max(1, since) + 8) / 60 if track else None
    nc_on, width, minG = cfg['notch']['on'], cfg['notch']['width'], cfg['notch']['minG']

    def near(f):
        if not nc_on or not cadence or motionG < minG:
            return np.ones_like(f)
        hit = ((np.abs(f - cadence) < width) | (np.abs(f - 2 * cadence) < width)) & ((not fTrack) or (np.abs(f - (fTrack or 0)) > 0.15))
        return np.where(hit, 0.25, 1.0)

    if sigma and cfg['tracker']['on']:
        spk = pick_peak(sp, p, lambda f: near(f) * np.exp(-0.5 * ((f - fTrack) / sigma) ** 2))
    else:
        spk = pick_peak(sp, p, near)
    free = pick_peak(sp, p, near)
    ch = st['challengers']
    if free:
        ch.append(free['f'] * 60)
        if len(ch) > 6:
            ch.pop(0)
    if free and spk and track and len(ch) == 6 and max(ch) - min(ch) < 8 and abs(free['f'] * 60 - track) > 15 and free['share'] > 0.3 and free['share'] > spk['share'] * 1.2:
        spk = free
        track = st['track'] = None
    spec = {'bpm': spk['f'] * 60, 'q': min(1, spk['share'] * 1.6)} if spk and spk['share'] >= 0.1 else None
    iv = [beats[i][0] - beats[i - 1][0] for i in range(1, len(beats)) if beats[i][1] and beats[i - 1][1]]
    pk = estimate_bpm(iv) if len(iv) >= 2 else None
    # blend
    bpm, agree, why = None, 0, None
    method = cfg['estimate'].get('method', 'blend')
    if not cfg['estimate']['on']:
        why = 'HR estimate is switched off'
    elif method == 'spectral':
        bpm = spec['bpm'] if spec else None
    elif method == 'beats':
        bpm = pk['bpm'] if pk else None
    elif spec and pk:
        if abs(spec['bpm'] - pk['bpm']) <= 8:
            ws, wp = cfg['estimate']['spectral'] * spec['q'], cfg['estimate']['peaks'] * pk['quality']
            bpm = (ws * spec['bpm'] + wp * pk['bpm']) / ((ws + wp) or 1)
            agree = 1
        else:
            bpm = pk['bpm'] if cadence and abs(spec['bpm'] - cadence * 60) < 6 and abs(pk['bpm'] - cadence * 60) >= 6 else spec['bpm']
    elif spec and cfg['estimate']['spectral'] > 0:
        bpm = spec['bpm']
    elif pk and cfg['estimate']['peaks'] > 0:
        bpm = pk['bpm']
    if bpm is None and not why:
        why = 'no clear pulse in the last 8 s'
    # tracker
    if bpm is not None and cfg['tracker']['on'] and track is not None:
        lim = cfg['tracker']['maxStep'] * max(1, t - st['trackT'])
        bpm = track + max(-lim, min(lim, bpm - track))
    if bpm is not None:
        st['track'], st['trackT'], st['lastAnswerT'] = bpm, t, t
    elif cfg['tracker']['on'] and track is not None and t - st['lastAnswerT'] <= cfg['tracker']['hold']:
        bpm = track
        why = f'held: {why}'
    else:
        st['track'] = st['trackT'] = None
    # confidence
    motion_pen = min(1, motionG / 1.5)
    conf = 0 if bpm is None else 0.45 * (spec['q'] if spec else 0) + 0.25 * (pk['quality'] if pk else 0) + 0.2 * agree + 0.1 * (1 - motion_pen)
    if frozen and cfg['impact']['on']:
        conf *= 0.5
        why = why or 'impact: holding'
    shown = bpm if bpm is not None and (not cfg['gate']['on'] or conf >= cfg['gate']['min']) else None
    if bpm is not None and shown is None:
        why = f'confidence {conf * 100:.0f} % below the gate'
    return {'t': float(t), 'bpm': shown, 'tracked': bpm, 'conf': float(conf), 'why': why,
            'spec': spec['bpm'] if spec else None, 'peaks': pk['bpm'] if pk else None,
            'cadence': cadence * 60 if cadence else None, 'motionG': motionG, 'impacts': st['impacts'],
            'frozen': frozen, 'notchOn': notch.on, 'weights': [float(w) for w in st['wts']], '_p': p}
