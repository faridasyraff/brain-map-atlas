"""SQLite connection management"""
import sqlite3
from pathlib import Path
from typing import Optional

# db.py is at backend/services/db.py, so:
# parent = backend/services
# parents[1] = backend (go up 1 level to get out of services)
DB_PATH = Path(__file__).resolve().parents[1] / "data" / "brain_atlas.db"


def get_conn() -> sqlite3.Connection:
    """
    Open a SQLite connection with row_factory for dict-like access.
    Caller is responsible for closing.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def dict_from_row(row: Optional[sqlite3.Row]) -> Optional[dict]:
    """Convert sqlite3.Row to dict, or None if row is None"""
    if row is None:
        return None
    return dict(row)
