"""PostgreSQL connection management"""
import os
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except ImportError:
    raise ImportError(
        "psycopg2-binary is required. Install with: pip install psycopg2-binary"
    )

# Load environment variables from backend/.env file
# Find the backend directory relative to this file
backend_dir = Path(__file__).resolve().parents[1]
env_file = backend_dir / ".env"
load_dotenv(dotenv_path=env_file)

# Get database URL from environment
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError(
        "DATABASE_URL environment variable not set. "
        "Add it to backend/.env or set it in your shell."
    )


def get_conn():
    """
    Open a PostgreSQL connection with RealDictCursor for dict-like access.
    Rows are returned as dictionaries.
    Caller is responsible for closing.
    """
    conn = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
    return conn


def dict_from_row(row: Optional[dict]) -> Optional[dict]:
    """
    Return dict as-is (RealDictCursor already returns dicts), or None if row is None.
    Maintains compatibility with SQLite version.
    """
    if row is None:
        return None
    return row
