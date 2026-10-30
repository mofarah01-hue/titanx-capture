"""SQLite store for the workbench: sessions seen, runs (one HR lane each), their estimates, and scores.

TODO true HR scoring later: the reference device is not chosen yet (Apple Watch, Whoop or a chest
strap, to be decided). When it is, import its HR per session as a run of kind 'reference', then fill
`scores` with one row per (run, reference run, metric) - MAE, % within 5 bpm, coverage, split by motion
level like the comparison table. Until then `scores` stays empty; nothing in the workbench writes it.
"""
import json
import os
import sqlite3
import threading
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,          -- live:<name> | zip:<folder>/<file> | dir:<folder>/<name>
  source TEXT NOT NULL,         -- live | zip | folder
  path TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  live INTEGER NOT NULL DEFAULT 0,
  info TEXT                     -- JSON: label, started, devices
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  device TEXT NOT NULL,         -- device base name, <id>_<athlete>
  kind TEXT NOT NULL,           -- pipeline | ipad | polar | model | truth | reference (later)
  label TEXT NOT NULL,
  config TEXT NOT NULL,         -- JSON
  created TEXT NOT NULL,
  data_end_s REAL,              -- last t_session_s the run saw (live sessions grow)
  ms INTEGER
);
CREATE TABLE IF NOT EXISTS estimates (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  t REAL NOT NULL,              -- t_session_s
  bpm REAL,                     -- NULL = no answer that second
  conf REAL,
  zone INTEGER
);
CREATE INDEX IF NOT EXISTS estimates_run ON estimates(run_id, t);
-- TODO true HR scoring later (reference device: Apple Watch / Whoop / chest strap, to be decided). Empty until then.
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  reference_run_id INTEGER REFERENCES runs(id),
  reference TEXT,               -- which device gave the true HR
  metric TEXT NOT NULL,         -- mae | within5 | coverage
  motion TEXT,                  -- all | low | mid | high
  value REAL,
  created TEXT NOT NULL,
  notes TEXT
);
"""


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


class Store:
    def __init__(self, path):
        self.path = path
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self.lock = threading.Lock()
        self.con = sqlite3.connect(path, check_same_thread=False)
        self.con.executescript(SCHEMA)
        self.con.commit()

    def seen(self, s):
        """Record a session from Session.summary()."""
        info = json.dumps({'label': s.get('label'), 'started': s.get('started'), 'devices': [d['base'] for d in s.get('devices', [])]})
        with self.lock:
            t = now()
            self.con.execute('INSERT INTO sessions(id, source, path, first_seen, last_seen, live, info) VALUES (?,?,?,?,?,?,?) '
                             'ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, live=excluded.live, info=excluded.info, path=excluded.path',
                             (s['id'], s['source'], s['path'], t, t, int(bool(s.get('live'))), info))
            self.con.commit()

    def add_run(self, session_id, device, kind, label, config, answer, data_end_s=None, ms=None):
        with self.lock:
            cur = self.con.execute('INSERT INTO runs(session_id, device, kind, label, config, created, data_end_s, ms) VALUES (?,?,?,?,?,?,?,?)',
                                   (session_id, device, kind, label, json.dumps(config), now(), data_end_s, ms))
            rid = cur.lastrowid
            self.con.executemany('INSERT INTO estimates(run_id, t, bpm, conf, zone) VALUES (?,?,?,?,?)',
                                 [(rid, float(e['t']), None if e['bpm'] is None else float(e['bpm']), float(e.get('conf') or 0), e.get('zone')) for e in answer])
            self.con.commit()
            return rid

    def runs(self, session_id, device=None):
        q = 'SELECT id, session_id, device, kind, label, config, created, data_end_s, ms, (SELECT COUNT(*) FROM estimates e WHERE e.run_id = runs.id) FROM runs WHERE session_id = ?'
        args = [session_id]
        if device:
            q += ' AND device = ?'
            args.append(device)
        with self.lock:
            rows = self.con.execute(q + ' ORDER BY id DESC', args).fetchall()
        return [{'id': r[0], 'session_id': r[1], 'device': r[2], 'kind': r[3], 'label': r[4], 'config': json.loads(r[5]), 'created': r[6],
                 'data_end_s': r[7], 'ms': r[8], 'n': r[9]} for r in rows]

    def estimates(self, run_id):
        with self.lock:
            rows = self.con.execute('SELECT t, bpm, conf, zone FROM estimates WHERE run_id = ? ORDER BY t', (run_id,)).fetchall()
        return [{'t': r[0], 'bpm': r[1], 'conf': r[2], 'zone': r[3]} for r in rows]
