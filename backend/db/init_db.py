from pathlib import Path
import sqlite3

SCHEMA_PATH = Path(__file__).with_name("schema.sql")
DB_PATH = Path(__file__).resolve().parents[1] / "data" / "brain_atlas.db"

def init_db() -> Path:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    try:
        cursor = conn.cursor()
        schema = SCHEMA_PATH.read_text(encoding="utf-8")
        
        # Split by semicolon and execute each statement
        statements = [s.strip() for s in schema.split(';') if s.strip()]
        for stmt in statements:
            cursor.execute(stmt)
        
        conn.commit()
    except Exception as e:
        print(f"[ERROR] Failed to execute schema: {e}")
        raise
    finally:
        conn.close()

    return DB_PATH

if __name__ == "__main__":
    db = init_db()
    print(f"[OK] Initialized DB at: {db}")
