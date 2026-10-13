"""Transactional local timestamp snapshots. Newer covered dates replace older ones."""
import hashlib
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path


class PunchCache:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as c:
            c.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS imports (
                    sequence INTEGER PRIMARY KEY, digest TEXT UNIQUE, start TEXT, end TEXT,
                    source TEXT, imported_at TEXT, punch_count INTEGER, source_stamp REAL);
                CREATE TABLE IF NOT EXISTS punches (
                    employee_id TEXT, name TEXT, timestamp TEXT, workcode TEXT, source TEXT,
                    PRIMARY KEY(employee_id,timestamp,workcode,source));
                CREATE INDEX IF NOT EXISTS punches_time ON punches(timestamp);
                CREATE TABLE IF NOT EXISTS coverage (date TEXT PRIMARY KEY, import_sequence INTEGER, complete INTEGER NOT NULL DEFAULT 1);
            ''')
            if 'source_stamp' not in [r[1] for r in c.execute('PRAGMA table_info(imports)')]:
                c.execute('ALTER TABLE imports ADD COLUMN source_stamp REAL')
                c.execute("UPDATE imports SET source_stamp=CAST(strftime('%s',imported_at) AS REAL)")
            if 'complete' not in [r[1] for r in c.execute('PRAGMA table_info(coverage)')]:
                c.execute('ALTER TABLE coverage ADD COLUMN complete INTEGER NOT NULL DEFAULT 1')
                c.execute('UPDATE coverage SET complete=0 WHERE date >= (SELECT substr(imported_at,1,10) FROM imports WHERE sequence=coverage.import_sequence)')
            if not c.execute("SELECT 1 FROM sqlite_master WHERE name='punches_employee_time'").fetchone():
                c.execute('DELETE FROM punches WHERE rowid NOT IN (SELECT min(rowid) FROM punches GROUP BY employee_id,timestamp)')
                c.execute('CREATE UNIQUE INDEX IF NOT EXISTS punches_employee_time ON punches(employee_id,timestamp)')

    @contextmanager
    def connect(self):
        c = sqlite3.connect(self.path, timeout=15)
        c.row_factory = sqlite3.Row
        c.execute('PRAGMA synchronous=FULL')
        try:
            with c:
                yield c
        finally:
            c.close()

    def ingest(self, engine, rows, start, end, source, fingerprint, source_stamp=None, append_only=False, today=None):
        today = today or datetime.now().strftime('%Y-%m-%d')
        # Parse and validate everything before replacing any cached date.
        clean = {}
        for row in rows:
            employee = row['employee_id'].strip()
            if not employee.isdecimal():
                raise ValueError('Invalid employee ID in raw CSV.')
            ts = engine.parse_ts(row['timestamp']).strftime('%Y-%m-%d %H:%M:%S')
            if not start <= ts[:10] <= end:
                continue
            key = (employee, ts)
            if key not in clean:
                clean[key] = (employee, row.get('name', '').strip(), ts, row.get('workcode', '').strip(), row.get('source', '').strip())
        digest = hashlib.sha256((start+'|'+end+'|'+source+'|'+fingerprint).encode()).hexdigest()
        source_stamp = source_stamp if source_stamp is not None else datetime.now().timestamp()
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            if c.execute('SELECT 1 FROM imports WHERE digest=?', (digest,)).fetchone():
                c.execute('UPDATE imports SET source_stamp=? WHERE digest=?', (source_stamp, digest))
                return False
            cur = c.execute('INSERT INTO imports(digest,start,end,source,imported_at,punch_count,source_stamp) VALUES(?,?,?,?,?,?,?)',
                (digest, start, end, source, datetime.now().astimezone().isoformat(), len(clean), source_stamp))
            day = datetime.strptime(start, '%Y-%m-%d')
            stop = datetime.strptime(end, '%Y-%m-%d')
            while day <= stop:
                key = day.strftime('%Y-%m-%d')
                previous = c.execute('SELECT i.source_stamp FROM coverage d JOIN imports i ON i.sequence=d.import_sequence WHERE d.date=?', (key,)).fetchone()
                if not append_only and previous and previous[0] is not None and previous[0] > source_stamp:
                    day += timedelta(days=1)
                    continue
                if not append_only:
                    c.execute('DELETE FROM punches WHERE timestamp>=? AND timestamp<=?', (key+' 00:00:00', key+' 23:59:59'))
                c.executemany(('INSERT OR IGNORE' if append_only else 'INSERT')+' INTO punches VALUES(?,?,?,?,?)', (r for r in clean.values() if r[2][:10] == key))
                c.execute('INSERT INTO coverage(date,import_sequence,complete) VALUES(?,?,?) ON CONFLICT(date) DO UPDATE SET import_sequence=excluded.import_sequence,complete=max(coverage.complete,excluded.complete)',
                    (key, cur.lastrowid, int(key < today)))
                day += timedelta(days=1)
        return True

    def rows(self, start, end):
        with self.connect() as c:
            rows = [dict(r) for r in c.execute('SELECT * FROM punches WHERE timestamp>=? AND timestamp<=? ORDER BY CAST(employee_id AS INTEGER),timestamp',
                (start+' 00:00:00', end+' 23:59:59'))]
        # A name change must not split one employee's day into two calculation groups.
        names = {}
        for r in rows:
            if r['name']:
                names[r['employee_id']] = r['name']
        for r in rows:
            r['name'] = names.get(r['employee_id'], r['name'])
        return rows

    def info(self, start=None, end=None, today=None):
        today = today or datetime.now().strftime('%Y-%m-%d')
        with self.connect() as c:
            dates = [r[0] for r in c.execute('SELECT date FROM coverage ORDER BY date')]
            complete = {r[0] for r in c.execute('SELECT date FROM coverage WHERE complete=1')}
            imports = c.execute('SELECT count(*),max(imported_at) FROM imports').fetchone()
            punches = c.execute('SELECT count(*) FROM punches').fetchone()[0]
            counts = dict(c.execute('SELECT substr(timestamp,1,10),count(*) FROM punches GROUP BY substr(timestamp,1,10)'))
        missing = []
        if start and end:
            covered = set(dates)
            day = datetime.strptime(start, '%Y-%m-%d')
            while day.strftime('%Y-%m-%d') <= end:
                key = day.strftime('%Y-%m-%d')
                if key not in complete or key >= today:
                    missing.append(key)
                day += timedelta(days=1)
        return {'start': dates[0] if dates else None, 'end': dates[-1] if dates else None,
                'coveredDates': dates, 'completeDates':[d for d in dates if d in complete and d < today], 'partialDates':[d for d in dates if d not in complete or d >= today],
                'dayCounts':counts, 'missingDates': missing, 'pulls': imports[0], 'updatedAt': imports[1], 'punches': punches}
