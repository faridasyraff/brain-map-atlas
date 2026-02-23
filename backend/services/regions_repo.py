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
            "SELECT * FROM brain_regions WHERE mba_id = %s",
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
            "SELECT * FROM brain_regions WHERE color_r = %s AND color_g = %s AND color_b = %s",
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
            "SELECT * FROM brain_regions WHERE annotation_id = %s",
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
               WHERE acronym LIKE %s OR name LIKE %s
               ORDER BY graph_order ASC
               LIMIT %s""",
            (q, q, limit)
        )
        rows = cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def get_ancestors(mba_id: int) -> list[dict]:
    """
    Return ancestor chain from root to the selected region (inclusive).
    Raises ValueError if a cycle is detected.
    """
    conn = get_conn()
    try:
        cursor = conn.cursor()
        chain: list[dict] = []
        visited: set[int] = set()
        current_id: Optional[int] = mba_id

        while current_id is not None:
            if current_id in visited:
                raise ValueError(f"Cycle detected at mba_id={current_id}")
            visited.add(current_id)

            cursor.execute(
                """SELECT mba_id, acronym, name, parent_mba_id
                   FROM brain_regions
                   WHERE mba_id = %s""",
                (current_id,)
            )
            row = cursor.fetchone()
            if row is None:
                break

            region = dict(row)
            chain.append(region)
            current_id = region.get("parent_mba_id")

        chain.reverse()
        return chain
    finally:
        conn.close()


def get_children(mba_id: int) -> list[dict]:
    """
    Return immediate children for the given mba_id.
    Sorted by graph_order when present, otherwise by name.
    """
    conn = get_conn()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """SELECT mba_id, acronym, name, parent_mba_id
               FROM brain_regions
               WHERE parent_mba_id = %s
               ORDER BY
                 CASE WHEN graph_order IS NULL THEN 1 ELSE 0 END,
                 graph_order ASC,
                 name ASC""",
            (mba_id,)
        )
        rows = cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()
