"""Search cache management"""
import hashlib
import json
from datetime import datetime, timedelta
from typing import Optional

from backend.services.db import get_conn


def normalize_query(q: str) -> str:
    """Normalize query: lowercase, trim, collapse whitespace"""
    return " ".join(q.lower().split())


def cache_key_from_query(q: str) -> str:
    """Generate SHA256 cache key from normalized query"""
    normalized = normalize_query(q)
    return hashlib.sha256(normalized.encode()).hexdigest()


def get_cached_result(q: str) -> Optional[list[dict]]:
    """
    Get cached search result if it exists and hasn't expired.
    If found, increment hit_count and return the result.
    Returns None if not in cache or expired.
    """
    key = cache_key_from_query(q)
    conn = get_conn()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """SELECT id, result_json, expires_at FROM search_cache 
               WHERE cache_key = ?""",
            (key,)
        )
        row = cursor.fetchone()
        
        if row is None:
            return None
        
        # Check expiration
        expires_at = datetime.fromisoformat(row["expires_at"])
        if datetime.utcnow() > expires_at:
            return None
        
        # Increment hit count
        cursor.execute(
            "UPDATE search_cache SET hit_count = hit_count + 1 WHERE id = ?",
            (row["id"],)
        )
        conn.commit()
        
        # Parse and return result
        result = json.loads(row["result_json"])
        return result
    finally:
        conn.close()


def cache_result(q: str, result: list[dict], ttl_days: int = 7) -> None:
    """
    Cache a search result for `ttl_days` days.
    Upsert by cache_key.
    """
    key = cache_key_from_query(q)
    normalized = normalize_query(q)
    result_json = json.dumps(result)
    expires_at = (datetime.utcnow() + timedelta(days=ttl_days)).isoformat()
    
    conn = get_conn()
    try:
        cursor = conn.cursor()
        cursor.execute(
            """INSERT INTO search_cache 
               (cache_key, query_text, normalized_query, result_json, hit_count, expires_at)
               VALUES (?, ?, ?, ?, 0, ?)
               ON CONFLICT(cache_key) DO UPDATE SET
                   result_json = excluded.result_json,
                   expires_at = excluded.expires_at,
                   hit_count = hit_count + 1""",
            (key, q, normalized, result_json, expires_at)
        )
        conn.commit()
    finally:
        conn.close()
