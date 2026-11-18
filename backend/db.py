"""
The app's small SQLite database: user accounts, plus each user's saved
regions (with notes) and recently viewed regions. SQLite is a
single ordinary file on disk (backend/data/app.db), not a separate server
you have to run, which is why it's a good fit for an app this size.

The database file lives inside backend/data, the same folder App.py already
uses for the downloaded atlas data — so it's covered by the same Docker
volume and survives container restarts without any extra setup.
"""
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent / 'data' / 'app.db'


def get_db():
    """Opens a new connection to the database file. SQLite connections are
    cheap and not meant to be shared across requests, so every route that
    needs the database just calls this and closes it when done."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row   # lets us read columns by name, e.g. row['email']
    conn.execute('PRAGMA foreign_keys = ON')   # so deleting a user deletes their data
    return conn


def init_db():
    """Creates the users table if it doesn't already exist. Safe to call
    every time the app starts — CREATE TABLE IF NOT EXISTS is a no-op once
    the table is already there."""
    conn = get_db()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            email         TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            is_admin      INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ''')
    # Regions a user saved, with an optional private note. `kind` is 'region'
    # (ref = parcellation index) or 'group' (ref = group name).
    conn.execute('''
        CREATE TABLE IF NOT EXISTS saved_regions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            kind       TEXT NOT NULL CHECK (kind IN ('region', 'group')),
            ref        TEXT NOT NULL,
            label      TEXT NOT NULL,
            acronym    TEXT NOT NULL DEFAULT '',
            color      TEXT NOT NULL DEFAULT '',
            note       TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE (user_id, kind, ref)
        )
    ''')
    # Recently viewed regions (kept to the newest HISTORY_LIMIT per user).
    conn.execute('''
        CREATE TABLE IF NOT EXISTS region_history (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            kind      TEXT NOT NULL CHECK (kind IN ('region', 'group')),
            ref       TEXT NOT NULL,
            label     TEXT NOT NULL,
            acronym   TEXT NOT NULL DEFAULT '',
            color     TEXT NOT NULL DEFAULT '',
            viewed_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_history_user ON region_history(user_id, id)')
    conn.commit()
    conn.close()


HISTORY_LIMIT = 50


def list_saved(user_id):
    conn = get_db()
    rows = conn.execute(
        'SELECT kind, ref, label, acronym, color, note, updated_at FROM saved_regions '
        'WHERE user_id = ? ORDER BY updated_at DESC, id DESC', (user_id,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def upsert_saved(user_id, kind, ref, label, acronym, color, note=None):
    """Save a region (or update its label/note if already saved). A note of
    None leaves an existing note untouched."""
    conn = get_db()
    conn.execute(
        '''INSERT INTO saved_regions (user_id, kind, ref, label, acronym, color, note)
           VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, ''))
           ON CONFLICT (user_id, kind, ref) DO UPDATE SET
             label = excluded.label, acronym = excluded.acronym, color = excluded.color,
             note = COALESCE(?, saved_regions.note), updated_at = datetime('now')''',
        (user_id, kind, ref, label, acronym, color, note, note))
    conn.commit()
    conn.close()


def delete_saved(user_id, kind, ref):
    conn = get_db()
    n = conn.execute('DELETE FROM saved_regions WHERE user_id = ? AND kind = ? AND ref = ?',
                     (user_id, kind, ref)).rowcount
    conn.commit()
    conn.close()
    return n > 0


def list_history(user_id, limit=30):
    conn = get_db()
    rows = conn.execute(
        'SELECT kind, ref, label, acronym, color, viewed_at FROM region_history '
        'WHERE user_id = ? ORDER BY id DESC LIMIT ?', (user_id, limit)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def add_history(user_id, kind, ref, label, acronym, color):
    """Record a view. Viewing the same region twice in a row only bumps its
    time instead of adding a duplicate; old entries beyond HISTORY_LIMIT go."""
    conn = get_db()
    last = conn.execute('SELECT id, kind, ref FROM region_history WHERE user_id = ? '
                        'ORDER BY id DESC LIMIT 1', (user_id,)).fetchone()
    if last and last['kind'] == kind and last['ref'] == ref:
        conn.execute("UPDATE region_history SET viewed_at = datetime('now') WHERE id = ?", (last['id'],))
    else:
        conn.execute('INSERT INTO region_history (user_id, kind, ref, label, acronym, color) '
                     'VALUES (?, ?, ?, ?, ?, ?)', (user_id, kind, ref, label, acronym, color))
        conn.execute('DELETE FROM region_history WHERE user_id = ? AND id NOT IN '
                     '(SELECT id FROM region_history WHERE user_id = ? ORDER BY id DESC LIMIT ?)',
                     (user_id, user_id, HISTORY_LIMIT))
    conn.commit()
    conn.close()


def delete_user(user_id):
    """Delete an account; its saved regions and history go with it (cascade)."""
    conn = get_db()
    conn.execute('DELETE FROM users WHERE id = ?', (user_id,))
    conn.commit()
    conn.close()


def create_user(email, password_hash, is_admin=False):
    conn = get_db()
    cur = conn.execute(
        'INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, ?)',
        (email, password_hash, 1 if is_admin else 0)
    )
    conn.commit()
    user_id = cur.lastrowid
    conn.close()
    return user_id


def get_user_by_email(email):
    conn = get_db()
    row = conn.execute('SELECT * FROM users WHERE email = ?', (email,)).fetchone()
    conn.close()
    return row


def get_user_by_id(user_id):
    conn = get_db()
    row = conn.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
    conn.close()
    return row


def user_count():
    conn = get_db()
    n = conn.execute('SELECT COUNT(*) AS n FROM users').fetchone()['n']
    conn.close()
    return n
