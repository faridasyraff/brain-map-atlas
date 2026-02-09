"""
Seed brain_regions table from parcellation_term.csv
"""
import csv
import sqlite3
from pathlib import Path

# Configuration - change these if paths differ
CSV_PATH = Path(__file__).resolve().parents[2] / "frontend" / "public" / "data" / "parcellation_term.csv"
DB_PATH = Path(__file__).resolve().parents[1] / "data" / "brain_atlas.db"

def seed_db() -> None:
    """Load CSV and upsert into brain_regions table"""
    
    if not CSV_PATH.exists():
        raise FileNotFoundError(f"CSV not found: {CSV_PATH}")
    
    if not DB_PATH.exists():
        raise FileNotFoundError(f"Database not found: {DB_PATH}")
    
    conn = sqlite3.connect(DB_PATH)
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
                    
                    # Upsert logic
                    cursor.execute(
                        "SELECT id FROM brain_regions WHERE mba_id = ?",
                        (mba_id,)
                    )
                    
                    existing = cursor.fetchone()
                    
                    if existing:
                        # Update existing row
                        cursor.execute(
                            """UPDATE brain_regions SET
                               identifier = ?,
                               acronym = ?,
                               name = ?,
                               parent_mba_id = ?,
                               parent_identifier = ?,
                               color_r = ?,
                               color_g = ?,
                               color_b = ?,
                               color_hex = ?,
                               annotation_id = ?,
                               graph_order = ?
                               WHERE mba_id = ?""",
                            (
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
                                graph_order,
                                mba_id
                            )
                        )
                        stats["updated"] += 1
                    else:
                        # Insert new row
                        cursor.execute(
                            """INSERT INTO brain_regions
                               (mba_id, identifier, acronym, name, parent_mba_id, parent_identifier,
                                color_r, color_g, color_b, color_hex, annotation_id, graph_order)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
                        stats["inserted"] += 1
                
                except (ValueError, IndexError, KeyError) as e:
                    print(f"[WARN] Skipped row {stats['processed']}: {e}")
                    stats["skipped"] += 1
        
        conn.commit()
    
    except Exception as e:
        print(f"[ERROR] Seeding failed: {e}")
        conn.rollback()
        raise
    
    finally:
        conn.close()
    
    # Verification query
    conn = sqlite3.connect(DB_PATH)
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
