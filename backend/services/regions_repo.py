"""Region repository - query brain_regions table"""
from typing import Optional
from backend.services.db import get_conn, dict_from_row


def get_region_by_id(mba_id: int) -> Optional[dict]:
    """
    Fetch region by MBA structure ID.
    Returns dict with keys: id, mba_id, identifier, acronym, name, parent_mba_id, 
                           parent_identifier, depth, color_r, color_g, color_b, color_hex, graph_order
    """
    conn = get_conn()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM brain_regions WHERE mba_id = ?",
            (mba_id,)
        )
        row = cursor.fetchone()
        return dict_from_row(row)
    finally:
        conn.close()


def get_region_by_rgb(r: int, g: int, b: int) -> Optional[dict]:
    """
    Fetch region by RGB color values.
    Returns dict or None if not found.
    Note: RGB(0, 0, 0) background is NOT stored in brain_regions.
    """
    conn = get_conn()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM brain_regions WHERE color_r = ? AND color_g = ? AND color_b = ?",
            (r, g, b)
        )
        row = cursor.fetchone()
        return dict_from_row(row)
    finally:
        conn.close()


def get_region_by_annotation(annotation_id: int) -> Optional[dict]:
    """
    Fetch region by combined annotation id (r<<16 | g<<8 | b).
    Returns dict or None if not found.
    """
    conn = get_conn()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM brain_regions WHERE annotation_id = ?",
            (annotation_id,)
        )
        row = cursor.fetchone()
        return dict_from_row(row)
    finally:
        conn.close()


def search_regions(query: str, limit: int = 20) -> list[dict]:
    """
    Search regions by acronym or name using LIKE.
    Query is case-insensitive.
    Returns list of region dicts, up to `limit` results.
    """
    conn = get_conn()
    try:
        cursor = conn.cursor()
        q = f"%{query}%"
        cursor.execute(
            """SELECT * FROM brain_regions 
               WHERE acronym LIKE ? OR name LIKE ?
               ORDER BY graph_order ASC
               LIMIT ?""",
            (q, q, limit)
        )
        rows = cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()
