"""
The app's small SQLite database — right now just user accounts. SQLite is a
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
