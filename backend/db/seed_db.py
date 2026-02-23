"""
Seed brain_regions table from parcellation_term.csv
"""
import csv
import os
from pathlib import Path
from dotenv import load_dotenv
import psycopg2

# Configuration - change these if paths differ
CSV_PATH = Path(__file__).resolve().parents[2] / "frontend" / "public" / "data" / "parcellation_term.csv"

# Load environment variables
backend_dir = Path(__file__).resolve().parents[1]
env_file = backend_dir / ".env"
load_dotenv(dotenv_path=env_file)
DATABASE_URL = os.getenv("DATABASE_URL")

def seed_db() -> None:
    """Load CSV and upsert into brain_regions table using PostgreSQL ON CONFLICT"""
    
    if not CSV_PATH.exists():
        raise FileNotFoundError(f"CSV not found: {CSV_PATH}")
    
    if not DATABASE_URL:
        raise ValueError("DATABASE_URL environment variable not set in backend/.env")
    
    conn = psycopg2.connect(DATABASE_URL)
    cursor = conn.cursor()
    
    stats = {"processed": 0, "inserted": 0, "updated": 0, "skipped": 0}
    
    try:
        with open(CSV_PATH, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            
            for row in reader:
                stats["processed"] += 1
                
                try:
                    # Parse identifier -> mba_id
                    identifier = row.get('identifier', '').strip()
                    if not identifier:
                        stats["skipped"] += 1
                        continue
                    
                    mba_id = int(identifier.split(':')[1])
                    
                    # Parse parent_identifier -> parent_mba_id
                    parent_identifier = row.get('parent_identifier', '').strip()
                    parent_mba_id = None
                    if parent_identifier:
                        try:
                            parent_mba_id = int(parent_identifier.split(':')[1])
                        except (IndexError, ValueError):
                            pass
                    
                    # Parse other fields
                    acronym = row.get('acronym', '').strip() or None
                    name = row.get('name', '').strip() or None
                    color_hex = row.get('color_hex_triplet', '').strip() or None
                    
                    # Parse colors
                    color_r = None
                    color_g = None
                    color_b = None
                    try:
                        color_r = int(row.get('red', '').strip()) if row.get('red', '').strip() else None
                        color_g = int(row.get('green', '').strip()) if row.get('green', '').strip() else None
                        color_b = int(row.get('blue', '').strip()) if row.get('blue', '').strip() else None
                    except ValueError:
                        pass

                    # Compute combined annotation_id when RGB present
                    annotation_id = None
                    if color_r is not None and color_g is not None and color_b is not None:
                        try:
                            annotation_id = (int(color_r) << 16) | (int(color_g) << 8) | int(color_b)
                        except Exception:
                            annotation_id = None
                    
                    # Parse graph_order
                    graph_order = None
                    try:
                        graph_order = float(row.get('graph_order', '').strip()) if row.get('graph_order', '').strip() else None
                    except ValueError:
                        pass
                    
                    # PostgreSQL upsert: INSERT ... ON CONFLICT(mba_id) DO UPDATE
                    cursor.execute(
                        """INSERT INTO brain_regions
                           (mba_id, identifier, acronym, name, parent_mba_id, parent_identifier,
                            color_r, color_g, color_b, color_hex, annotation_id, graph_order)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                           ON CONFLICT(mba_id) DO UPDATE SET
                               identifier = EXCLUDED.identifier,
                               acronym = EXCLUDED.acronym,
                               name = EXCLUDED.name,
                               parent_mba_id = EXCLUDED.parent_mba_id,
                               parent_identifier = EXCLUDED.parent_identifier,
                               color_r = EXCLUDED.color_r,
                               color_g = EXCLUDED.color_g,
                               color_b = EXCLUDED.color_b,
                               color_hex = EXCLUDED.color_hex,
                               annotation_id = EXCLUDED.annotation_id,
                               graph_order = EXCLUDED.graph_order""",
                        (
                            mba_id,
                            identifier,
                            acronym,
                            name,
                            parent_mba_id,
                            parent_identifier,
                            color_r,
                            color_g,
                            color_b,
                            color_hex,
                            annotation_id,
                            graph_order
                        )
                    )
                    
                    # Track whether this was an insert or update by checking rows affected
                    # psycopg2 cursor.rowcount: 1 = insert, 2 = update (because it deletes then re-inserts)
                    if cursor.rowcount == 1:
                        stats["inserted"] += 1
                    else:
                        stats["updated"] += 1
                
                except (ValueError, IndexError, KeyError) as e:
                    print(f"[WARN] Skipped row {stats['processed']}: {e}")
                    stats["skipped"] += 1
        
        # Commit all upserts
        conn.commit()
    
    except Exception as e:
        print(f"[ERROR] Seeding failed: {e}")
        conn.rollback()
        raise
    
    finally:
        conn.close()
    
    # Verification query
    conn = psycopg2.connect(DATABASE_URL)
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM brain_regions")
    total_rows = cursor.fetchone()[0]
    conn.close()
    
    # Print results
    print(f"\n[Seeding Complete]")
    print(f"  Processed: {stats['processed']}")
    print(f"  Inserted:  {stats['inserted']}")
    print(f"  Updated:   {stats['updated']}")
    print(f"  Skipped:   {stats['skipped']}")
    print(f"\nTotal rows in brain_regions: {total_rows}")

if __name__ == "__main__":
    seed_db()
