"""Titan X HR workbench: a local web GUI for comparing heart rate pipelines and models on Polar Verity
Sense recordings. Listens on 127.0.0.1 only (there is no option to change that).

  python workbench/server.py [--port 8795] [--live-dir DIR] [--rec-dir DIR ...] [--db FILE]

Settings (flag wins over env): TITANX_WB_PORT (8795), TITANX_LIVE_DIR (C:\\TitanX-data\\live),
TITANX_REC_DIRS (';' separated, default <home>\\Documents\\TitanX-recordings), TITANX_WB_DB
(C:\\TitanX-data\\workbench.db). Then open http://127.0.0.1:8795/.
"""
import argparse
import json
import math
import mimetypes
import os
import sys
import threading
import time
import traceback
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import compare   # noqa: E402
import db        # noqa: E402
import engines   # noqa: E402
import models    # noqa: E402
import pipeline  # noqa: E402
import sessions  # noqa: E402

HOST = '127.0.0.1'
STATIC = os.path.join(HERE, 'static')
TRACE_KEEP = 40


def default_paths():
    home = os.path.expanduser('~')
    win = os.name == 'nt'
    return {
        'live': r'C:\TitanX-data\live' if win else os.path.join(home, 'TitanX-data', 'live'),
        'rec': [os.path.join(home, 'Documents', 'TitanX-recordings')],
        'db': r'C:\TitanX-data\workbench.db' if win else os.path.join(home, 'TitanX-data', 'workbench.db'),
    }


def clean(x):
    """JSON-safe: NaN and inf become null, numpy numbers become floats, rounded to keep replies small."""
    if isinstance(x, dict):
        return {k: clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    if isinstance(x, np.ndarray):
        return clean(x.tolist())
    if isinstance(x, (bool, np.bool_)):
        return bool(x)
    if isinstance(x, (int, np.integer)):
        return int(x)
    if isinstance(x, (float, np.floating)):
        x = float(x)
        return round(x, 5) if math.isfinite(x) else None
    return x


def window(t, v, t0, t1, n):
    """Points of (t, v[n, ch]) inside [t0, t1]: raw when few, else min and max per time bucket."""
    v = np.asarray(v, float).reshape(len(t), -1)
    a, b = np.searchsorted(t, t0, 'left'), np.searchsorted(t, t1, 'right')
    a, b = max(0, a - 1), min(len(t), b + 1)
    tt, vv = t[a:b], v[a:b]
    if len(tt) <= 2 * n:
        return {'mode': 'raw', 't': tt, 'v': vv.T}
    edges = np.searchsorted(tt, np.linspace(tt[0], tt[-1], n + 1))[:-1]
    edges = np.unique(edges)
    with np.errstate(all='ignore'):
        mn = np.fmin.reduceat(vv, edges, axis=0)
        mx = np.fmax.reduceat(vv, edges, axis=0)
    return {'mode': 'env', 't': tt[edges], 'min': mn.T, 'max': mx.T}


class App:
    def __init__(self, live_dir, rec_dirs, db_path, port):
        self.cfg = {'live_dir': live_dir, 'rec_dirs': rec_dirs, 'db': db_path, 'port': port}
        self.lib = sessions.Library(live_dir, rec_dirs)
        self.store = db.Store(db_path)
        self.traces = OrderedDict()   # key -> {name: (t, v)}
        self.seen = {}                # session id -> live flag written to the db
        self.lock = threading.Lock()
        self.next_key = 1

    # ----- sessions -----
    def sessions(self):
        out = []
        for s in self.lib.scan():
            try:
                man = s.manifest()
                info = man.get('session') or {}
                d = {'id': s.id, 'name': os.path.basename(s.path).removesuffix('.zip'), 'source': s.source, 'live': s.live,
                     'ended': s.source == 'live' and not s.live, 'label': info.get('label'), 'started': info.get('started'),
                     'duration_s': info.get('duration_s'), 'synthetic': 'synthetic' in man, 'path': s.path, 'devices': s.devices()}
                if self.seen.get(s.id) != d['live']:
                    self.store.seen(d)
                    self.seen[s.id] = d['live']
                out.append(d)
            except Exception as e:   # one bad session never hides the others
                out.append({'id': s.id, 'name': os.path.basename(s.path), 'source': s.source, 'error': str(e), 'live': False, 'devices': []})
        out.sort(key=lambda d: (d.get('started') or '', d['name']), reverse=True)   # newest first,
        out.sort(key=lambda d: (not d['live'], d.get('source') != 'live'))               # live ones on top
        return out

    def session(self, sid):
        s = self.lib.get(sid)
        summ = s.summary()
        devs = []
        for d in summ['devices']:
            info = {}
            for k in d['streams']:
                if k in ('ppg', 'acc', 'gyro', 'mag', 'hr'):
                    st = s.stream(d['base'], k)
                    if st is not None and len(st[0]) > 1:
                        span = st[0][-1] - st[0][0]
                        info[k] = {'rows': len(st[0]), 'hz': (len(st[0]) - 1) / span if span > 0 else None, 'cols': st[2], 't0': st[0][0], 't1': st[0][-1]}
            devs.append({**d, 'info': info})
        summ['devices'] = devs
        summ['annotations'] = [a for a in s.annotations() if isinstance(a, dict)]
        summ['truth'] = s.truth() is not None
        return summ

    def signals(self, sid, dev, t0, t1, n):
        s = self.lib.get(sid)
        out = {}
        p = s.stream(dev, 'ppg')
        if p is not None and len(p[0]):
            out['ppg'] = {'cols': p[2], **window(p[0], p[1], t0, t1, n)}
        for k, name in (('acc', 'accMag'), ('gyro', 'gyroMag')):
            st = s.stream(dev, k)
            if st is not None and len(st[0]):
                mag = np.sqrt((st[1][:, :3] ** 2).sum(1)) / (1000.0 if k == 'acc' else 1.0)
                out[name] = {'cols': ['|a| g' if k == 'acc' else '|w| dps'], **window(st[0], mag, t0, t1, n)}
        return out

    # ----- runs -----
    def keep_traces(self, traces):
        with self.lock:
            key = self.next_key
            self.next_key += 1
            self.traces[key] = traces
            while len(self.traces) > TRACE_KEEP:
                self.traces.popitem(last=False)
        return key

    def run(self, body):
        sid, dev = body['id'], body['dev']
        engine = body.get('engine', 'pipeline')
        s = self.lib.get(sid)
        st = s.signals(dev)
        mx = body.get('max_hr')
        cfg = body.get('config') or {}
        res = {'engine': engine, 'label': body.get('label') or engine}
        t0 = time.time()
        if engine == 'pipeline':
            if mx:
                cfg = {**cfg, 'zones': {'max_hr': mx}}
            r = engines.run_pipeline(st, cfg)
            tr = r['traces']
            key = self.keep_traces({k: (tr['t'], tr[k]) for k in tr if k != 't'})
            res.update(answer=r['answer'], post=r['post'], key=key, traces=[k for k in tr if k != 't'], config=r['cfg'],
                       beats=r['beats'][-20000:])
        elif engine == 'ipad':
            r = engines.run_ipad(st, pipeline.js_config(cfg) if body.get('same_config') else None, bool(body.get('viterbi')), mx)
            res.update(answer=r['answer'], node_ms=r['node_ms'])
        elif engine == 'polar':
            res['answer'] = engines.polar_hr(st, mx)
            if res['answer'] is None:
                raise ValueError('this device has no Polar HR (hr.csv); Max mode has none')
        elif engine == 'truth':
            res['answer'] = engines.truth_lane(s.truth(), mx)
            if res['answer'] is None:
                raise ValueError('no synthetic_truth.csv in this session')
        elif engine == 'model':
            name = body.get('model')
            if name not in models.MODELS:
                raise ValueError(f'unknown model {name}')
            res['answer'] = models.MODELS[name]().run(st)
            for a in res['answer']:
                a['zone'] = pipeline.zone_of(a['bpm'], mx)
        else:
            raise ValueError(f'unknown engine {engine}')
        res['ms'] = int((time.time() - t0) * 1000)
        end = float(st['ppg'][0][-1]) if 'ppg' in st else None
        res['data_end_s'] = end
        if body.get('save', True) and engine in ('pipeline', 'ipad', 'model'):
            conf = {'engine': engine, 'config': res.get('config', cfg), 'viterbi': body.get('viterbi'), 'model': body.get('model'), 'same_config': body.get('same_config')}
            res['run_id'] = self.store.add_run(sid, dev, engine if engine != 'model' else 'model', res['label'], conf, res['answer'], end, res['ms'])
        return res

    def trace(self, key, name, t0, t1, n):
        with self.lock:
            tr = self.traces.get(key)
        if not tr or name not in tr:
            raise KeyError('that run is no longer in memory; run it again')
        t, v = tr[name]
        return window(t, v, t0, t1, n)


class Handler(BaseHTTPRequestHandler):
    app: App = None
    server_version = 'TitanXWorkbench/1'

    def log_message(self, fmt, *args):
        pass   # quiet; errors are printed in reply()

    def allowed(self):
        """Only this machine's own pages: a Host or Origin naming anything else is refused (DNS rebinding, other sites)."""
        port = self.app.cfg['port']
        ok = {f'127.0.0.1:{port}', f'localhost:{port}'}
        if self.headers.get('Host') not in ok:
            return False
        o = self.headers.get('Origin')
        return o is None or o.replace('http://', '') in ok

    def reply(self, status, obj=None, body=None, ctype='application/json; charset=utf-8'):
        data = body if body is not None else json.dumps(clean(obj), separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def fail(self, e, status=500):
        if status == 500:
            traceback.print_exc()
        self.reply(status, {'ok': False, 'error': f'{type(e).__name__}: {e}' if status == 500 else str(e)})

    def do_GET(self):
        if not self.allowed():
            return self.reply(403, {'ok': False, 'error': 'local pages only'})
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        A = self.app
        try:
            if u.path in ('/', '/index.html'):
                return self.static('index.html')
            if u.path.startswith('/static/'):
                return self.static(u.path[len('/static/'):])
            if u.path == '/api/status':
                return self.reply(200, {'ok': True, 'config': A.cfg, 'models': models.status(), 'defaults': pipeline.default_config()})
            if u.path == '/api/sessions':
                return self.reply(200, {'ok': True, 'sessions': A.sessions()})
            if u.path == '/api/session':
                return self.reply(200, {'ok': True, 'session': A.session(q['id'])})
            if u.path == '/api/signals':
                return self.reply(200, {'ok': True, **A.signals(q['id'], q['dev'], float(q['t0']), float(q['t1']), int(q.get('n', 1500)))})
            if u.path == '/api/trace':
                return self.reply(200, {'ok': True, **A.trace(int(q['key']), q['name'], float(q['t0']), float(q['t1']), int(q.get('n', 1500)))})
            if u.path == '/api/runs':
                return self.reply(200, {'ok': True, 'runs': A.store.runs(q['id'], q.get('dev'))})
            if u.path == '/api/estimates':
                return self.reply(200, {'ok': True, 'answer': A.store.estimates(int(q['run']))})
            self.reply(404, {'ok': False, 'error': 'not found'})
        except KeyError as e:
            self.fail(e, 404)
        except Exception as e:
            self.fail(e)

    def do_POST(self):
        if not self.allowed():
            return self.reply(403, {'ok': False, 'error': 'local pages only'})
        u = urlparse(self.path)
        try:
            n = int(self.headers.get('Content-Length') or 0)
            if n > 50 * 1024 * 1024:
                return self.reply(413, {'ok': False, 'error': 'too big'})
            body = json.loads(self.rfile.read(n) or b'{}')
            if u.path == '/api/run':
                return self.reply(200, {'ok': True, **self.app.run(body)})
            if u.path == '/api/compare':
                s = self.app.lib.get(body['id'])
                acc = s.stream(body['dev'], 'acc')
                span = body.get('span')
                return self.reply(200, {'ok': True, **compare.table(body['lanes'], acc[:2] if acc else None, span, float(body.get('lo', 0.05)), float(body.get('hi', 0.2)))})
            self.reply(404, {'ok': False, 'error': 'not found'})
        except (KeyError, ValueError) as e:
            self.fail(e, 400)
        except Exception as e:
            self.fail(e)

    def static(self, rel):
        path = os.path.normpath(os.path.join(STATIC, rel))
        if not path.startswith(STATIC + os.sep) or not os.path.isfile(path):
            return self.reply(404, {'ok': False, 'error': 'not found'})
        with open(path, 'rb') as f:
            data = f.read()
        ctype = mimetypes.guess_type(path)[0] or 'application/octet-stream'
        if ctype.startswith('text/') or ctype.endswith('javascript'):
            ctype += '; charset=utf-8'
        self.reply(200, body=data, ctype=ctype)


def main(argv=None):
    d = default_paths()
    ap = argparse.ArgumentParser(description='Titan X HR workbench (127.0.0.1 only)')
    ap.add_argument('--port', type=int, default=int(os.environ.get('TITANX_WB_PORT', 8795)))
    ap.add_argument('--live-dir', default=os.environ.get('TITANX_LIVE_DIR', d['live']))
    ap.add_argument('--rec-dir', action='append', help='finished sessions (zips or folders); repeat for more')
    ap.add_argument('--db', default=os.environ.get('TITANX_WB_DB', d['db']))
    a = ap.parse_args(argv)
    rec = [os.path.abspath(p) for p in (a.rec_dir or [p for p in os.environ.get('TITANX_REC_DIRS', '').split(';') if p] or d['rec'])]
    a.live_dir, a.db = os.path.abspath(a.live_dir), os.path.abspath(a.db)
    Handler.app = App(a.live_dir, rec, a.db, a.port)
    srv = ThreadingHTTPServer((HOST, a.port), Handler)
    srv.daemon_threads = True
    print(f'workbench on http://{HOST}:{a.port}/  live: {a.live_dir}  recordings: {"; ".join(rec)}  db: {a.db}', flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
