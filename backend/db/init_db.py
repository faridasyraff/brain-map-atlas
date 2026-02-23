"""PostgreSQL schema initialization for Neon"""
import os
from pathlib import Path

from dotenv import load_dotenv

try:
    import psycopg2
except ImportError:
    raise ImportError(
        "psycopg2-binary is required. Install with: pip install psycopg2-binary"
    )

SCHEMA_PATH = Path(__file__).with_name("schema.sql")

# Load environment variables from backend/.env
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


def init_db() -> str:
    """
    Initialize PostgreSQL schema in Neon.
    Reads backend/db/schema.sql and executes all statements.
    Returns the DATABASE_URL (database identifier).
    """
    if not SCHEMA_PATH.exists():
        raise FileNotFoundError(f"Schema file not found: {SCHEMA_PATH}")

    conn = None
    cursor = None
    try:
        # Connect to Neon PostgreSQL
        conn = psycopg2.connect(DATABASE_URL)
        cursor = conn.cursor()

        # Read schema file
        schema = SCHEMA_PATH.read_text(encoding="utf-8")

        # Execute all statements at once
        # PostgreSQL handles the parsing and execution
        # Remove comment lines and split by semicolon more carefully
        lines = []
        for line in schema.split("\n"):
            # Remove comments but preserve the line if it has code
            if "--" in line:
                code_part = line[:line.index("--")].strip()
            else:
                code_part = line.strip()
            
            if code_part:
                lines.append(code_part)
        
        schema_clean = " ".join(lines)
        
        # Split by semicolon and execute each statement
        statements = [s.strip() for s in schema_clean.split(";") if s.strip()]
        
        for i, stmt in enumerate(statements, 1):
            try:
                cursor.execute(stmt)
                print(f"  [{i}/{len(statements)}] ✓ Executed statement")
            except psycopg2.Error as e:
                print(f"[ERROR] Statement {i} failed: {e}")
                print(f"Statement: {stmt[:100]}...")
                raise

        # Commit all statements
        conn.commit()
        print(f"\n[OK] Initialized PostgreSQL schema in Neon ({len(statements)} statements)")

    except Exception as e:
        if conn:
            conn.rollback()
        print(f"[ERROR] Failed to initialize schema: {e}")
        raise

    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()

    return DATABASE_URL


if __name__ == "__main__":
    db_url = init_db()
    # Extract host from connection string for display (hide password)
    db_display = db_url.split("@")[1] if "@" in db_url else "Neon PostgreSQL"
    print(f"[INFO] Connected to: {db_display}")

