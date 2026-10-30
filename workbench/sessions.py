"""Find and read capture sessions: live folders that are still growing, finished zips, finished folders.

Live folders (tools/receive.mjs writes them) grow by appends; the last line can be cut mid way, and
manifest.json is swapped in whole from time to time. A CsvTail keeps a byte offset per file and parses
whole lines only, so polling a live session costs only the new bytes.

Streams come back as (t, v): t = t_session_s (float64), v = values (n, ch) float64. Rows with an empty
or unreadable cell are left out and counted, never filled in (as core/runs.js parseCsv).
"""
import io
import json
import os
import re
import threading
import zipfile

import numpy as np

META = {'i', 't_session_s', 't_sensor_ns', 't_sensor_ms', 't_sensor_us', 'rx_session_s'}
SIGNAL = ('ppg', 'acc', 'gyro', 'mag')
# <device id>_<athlete>_<stream>[_<n>].csv; the stream name is matched from the end
STREAM_RE = re.compile(r'^(?P<base>.+)_(?P<key>ppg_green|ppg_red|ppg_ir|ppg|acc|gyro|mag|hr|ppi|frames|temperature|quat)(?:_(?P<n>\d+))?\.csv$')
TRUTH = 'synthetic_truth.csv'


def parse_lines(header, text, want=None):
    """Whole CSV lines (no header) -> (t, v[n, ch], bad, gaps). want = signal column names."""
    cols = header
    tI = cols.index('t_session_s') if 't_session_s' in cols else 0
    names = want or [c for c in cols if c not in META]
    idx = [cols.index(c) for c in names]
    use = [tI] + idx
    if not text.strip():
        return np.zeros(0), np.zeros((0, len(names))), 0, 0
    try:   # fast path: every row complete and numeric
        a = np.loadtxt(io.StringIO(text), delimiter=',', usecols=use, ndmin=2, dtype=float)
        return a[:, 0].copy(), a[:, 1:].copy(), 0, 0
    except ValueError:
        pass
    t, v, bad, gaps = [], [], 0, 0
    for line in text.splitlines():
        if not line.strip():
            continue
        p = line.split(',')
        if len(p) <= max(use):
            bad += 1
            continue
        cells = [p[i].strip() for i in use]
        if any(c == '' for c in cells):
            gaps += 1
            continue
        try:
            x = [float(c) for c in cells]
        except ValueError:
            bad += 1
            continue
        t.append(x[0])
        v.append(x[1:])
    return np.array(t, float), np.array(v, float).reshape(len(t), len(names)), bad, gaps


class CsvTail:
    """One growing CSV: reads from the last byte offset, parses whole lines, keeps the rest for later."""

    def __init__(self, path, want=None):
        self.path, self.want = path, want
        self.offset = 0
        self.header = None
        self.chunks_t, self.chunks_v = [], []
        self.bad = self.gaps = 0
        self.rows = 0
        self._cat = None
        self.lock = threading.Lock()

    def poll(self):
        """Read new whole lines. Returns the number of new rows."""
        with self.lock:
            try:
                size = os.path.getsize(self.path)
            except OSError:
                return 0
            if size < self.offset:      # file replaced by a shorter one: start over (receive.mjs never does this)
                self.__init__(self.path, self.want)
            if size == self.offset:
                return 0
            with open(self.path, 'rb') as f:
                f.seek(self.offset)
                data = f.read(size - self.offset)
            end = data.rfind(b'\n')
            if end < 0:
                return 0                 # not one whole line yet
            data = data[:end + 1]
            self.offset += len(data)
            text = data.decode('utf-8', errors='replace')
            if self.header is None:
                nl = text.find('\n')
                self.header = [c.strip() for c in text[:nl].rstrip('\r').split(',')]
                text = text[nl + 1:]
                if 't_session_s' not in self.header:
                    raise ValueError(f'{os.path.basename(self.path)}: no t_session_s column')
            t, v, bad, gaps = parse_lines(self.header, text, self.want)
            self.bad += bad
            self.gaps += gaps
            if len(t):
                self.chunks_t.append(t)
                self.chunks_v.append(v)
                self.rows += len(t)
                self._cat = None
            return len(t)

    def data(self):
        with self.lock:
            if self._cat is None:
                if not self.chunks_t:
                    nc = len(self.want) if self.want else max(0, len([c for c in (self.header or []) if c not in META]))
                    self._cat = (np.zeros(0), np.zeros((0, nc)))
                else:
                    self.chunks_t = [np.concatenate(self.chunks_t)]
                    self.chunks_v = [np.concatenate(self.chunks_v)]
                    self._cat = (self.chunks_t[0], self.chunks_v[0])
            return self._cat

    def cols(self):
        return self.want or [c for c in (self.header or []) if c not in META]


def _want_for(key):
    return ['hr_bpm'] if key == 'hr' else (['hr_bpm'] if key == 'truth' else None)


class Session:
    """One session from a folder (live or finished) or a zip. Thread safe enough for a local server."""

    def __init__(self, sid, path, source):
        self.id, self.path, self.source = sid, path, source  # source: live | folder | zip
        self.tails = {}           # filename -> CsvTail (folders)
        self.zip_cache = None     # (mtime, {filename: (t, v, cols)})
        self.lock = threading.Lock()

    # ----- files -----
    def _files(self):
        if self.source == 'zip':
            with zipfile.ZipFile(self.path) as z:
                return {os.path.basename(n): n for n in z.namelist() if not n.endswith('/')}
        return {n: os.path.join(self.path, n) for n in os.listdir(self.path)}

    def _read_json(self, name):
        try:
            if self.source == 'zip':
                with zipfile.ZipFile(self.path) as z:
                    names = [n for n in z.namelist() if os.path.basename(n) == name]
                    if not names:
                        return None
                    return json.loads(z.read(sorted(names, key=len)[0]).decode('utf-8'))
            p = os.path.join(self.path, name)
            if not os.path.exists(p):
                return None
            with open(p, encoding='utf-8') as f:
                return json.load(f)
        except (OSError, ValueError, KeyError):
            return None   # a manifest being swapped in, or damaged: try again on the next poll

    @property
    def live(self):
        return self.source == 'live' and not os.path.exists(os.path.join(self.path, '_ended.json'))

    def manifest(self):
        return self._read_json('manifest.json') or {}

    def annotations(self):
        try:
            if self.source == 'zip':
                j = self._read_json('annotations.json')
                if isinstance(j, list):
                    return j
                with zipfile.ZipFile(self.path) as z:
                    names = [n for n in z.namelist() if os.path.basename(n) == 'annotations.jsonl']
                    text = z.read(names[0]).decode('utf-8') if names else ''
            else:
                p = os.path.join(self.path, 'annotations.jsonl')
                text = open(p, encoding='utf-8').read() if os.path.exists(p) else ''
            out = []
            for line in text.splitlines():
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass      # last line still being written
            return out
        except OSError:
            return []

    # ----- streams -----
    def stream_files(self):
        """{device base: {key: [filenames oldest first]}} from the file names."""
        out = {}
        for fn in self._files():
            m = STREAM_RE.match(fn)
            if not m:
                continue
            out.setdefault(m['base'], {}).setdefault(m['key'], []).append((int(m['n'] or 0), fn))
        return {b: {k: [fn for _, fn in sorted(v)] for k, v in ks.items()} for b, ks in out.items()}

    def devices(self):
        """[{base, device_id, athlete, kind, mode, streams}] from the files, named from the manifest where it knows them."""
        man = self.manifest()
        by_base = {}
        for d in man.get('devices') or []:
            for st in (d.get('streams') or {}).values():
                f = (st or {}).get('file')
                m = STREAM_RE.match(f) if f else None
                if m:
                    by_base[m['base']] = d
        out = []
        for base, keys in sorted(self.stream_files().items()):
            d = by_base.get(base, {})
            out.append({'base': base, 'device_id': d.get('device_id') or base.split('_')[0], 'athlete': d.get('athlete') or '_'.join(base.split('_')[1:]) or 'unassigned',
                        'kind': d.get('kind', 'polar'), 'mode': d.get('mode'), 'streams': sorted(keys)})
        return out

    def _load(self, fn, key):
        """(t, v, cols) of one file, read incrementally for folders and cached for zips."""
        if self.source == 'zip':
            mt = os.path.getmtime(self.path)
            with self.lock:
                if not self.zip_cache or self.zip_cache[0] != mt:
                    self.zip_cache = (mt, {})
                cache = self.zip_cache[1]
                if fn not in cache:
                    with zipfile.ZipFile(self.path) as z:
                        inner = self._files()[fn]
                        text = z.read(inner).decode('utf-8', errors='replace')
                    nl = text.find('\n')
                    header = [c.strip() for c in text[:nl].rstrip('\r').split(',')]
                    body = text[nl + 1:]
                    if body and not body.endswith('\n'):
                        body = body[:body.rfind('\n') + 1]   # cut last line: left out, as core/runs.js does
                    want = _want_for(key)
                    t, v, _, _ = parse_lines(header, body, want)
                    cache[fn] = (t, v, want or [c for c in header if c not in META])
                return cache[fn]
        with self.lock:
            tail = self.tails.get(fn)
            if tail is None:
                tail = self.tails[fn] = CsvTail(os.path.join(self.path, fn), _want_for(key))
        tail.poll()
        t, v = tail.data()
        return t, v, tail.cols()

    def stream(self, base, key):
        """(t, v, cols) of one stream, files joined in order, or None."""
        files = self.stream_files().get(base, {}).get(key)
        if not files:
            return None
        parts = [self._load(fn, key) for fn in files]
        parts = [p for p in parts if p[1].shape[1] == parts[0][1].shape[1]]   # a later layout with other columns is left out
        if len(parts) == 1:
            return parts[0]
        return np.concatenate([p[0] for p in parts]), np.concatenate([p[1] for p in parts]), parts[0][2]

    def truth(self):
        """The known HR of a synthetic session, or None."""
        if TRUTH not in self._files():
            return None
        t, v, _ = self._load(TRUTH, 'truth')
        return t, v[:, 0]

    def signals(self, base):
        """{'ppg': (t, v), 'acc': ..., 'gyro': ..., 'mag': ...} for the pipeline, plus 'hr' when Polar gave one."""
        out = {}
        for key in (*SIGNAL, 'hr'):
            s = self.stream(base, key)
            if s is not None and len(s[0]):
                out[key] = (s[0], s[1])
        return out

    def summary(self):
        man = self.manifest()
        s = man.get('session') or {}
        span = None
        devs = self.devices()
        if devs:
            p = self.stream(devs[0]['base'], 'ppg')
            if p is not None and len(p[0]):
                span = [float(p[0][0]), float(p[0][-1])]
        return {'id': self.id, 'name': os.path.basename(self.path).removesuffix('.zip'), 'source': self.source, 'live': self.live,
                'ended': self.source == 'live' and not self.live, 'label': s.get('label'), 'started': s.get('started'),
                'duration_s': s.get('duration_s') if s.get('duration_s') is not None else (span[1] if span else None), 'devices': devs, 'span': span,
                'synthetic': 'synthetic' in man, 'path': self.path}


class Library:
    """Every session in the live folder and the recordings folder. Sessions are kept so their tails persist."""

    def __init__(self, live_dir, rec_dirs):
        self.live_dir = live_dir
        self.rec_dirs = [d for d in rec_dirs if d]
        self.sessions = {}
        self.lock = threading.Lock()

    def scan(self):
        found = []
        if self.live_dir and os.path.isdir(self.live_dir):
            for n in sorted(os.listdir(self.live_dir)):
                p = os.path.join(self.live_dir, n)
                if os.path.isdir(p) and not n.startswith(('.', '_')):
                    found.append((f'live:{n}', p, 'live'))
        for d in self.rec_dirs:
            if not os.path.isdir(d):
                continue
            for n in sorted(os.listdir(d)):
                p = os.path.join(d, n)
                if n.lower().endswith('.zip') and os.path.isfile(p) and not n.startswith('.'):
                    found.append((f'zip:{os.path.basename(d)}/{n}', p, 'zip'))
                elif os.path.isdir(p) and os.path.exists(os.path.join(p, 'manifest.json')) and not n.startswith(('.', '_')):
                    found.append((f'dir:{os.path.basename(d)}/{n}', p, 'folder'))
        with self.lock:
            for sid, p, src in found:
                if sid not in self.sessions:
                    self.sessions[sid] = Session(sid, p, src)
            gone = set(self.sessions) - {f[0] for f in found}
            for sid in gone:
                del self.sessions[sid]
            return list(self.sessions.values())

    def get(self, sid):
        with self.lock:
            s = self.sessions.get(sid)
        if s is None:
            self.scan()
            with self.lock:
                s = self.sessions.get(sid)
        if s is None:
            raise KeyError(f'no session {sid}')
        return s
