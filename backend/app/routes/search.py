"""Cached search routes"""
from fastapi import APIRouter, HTTPException

from backend.services.cache import get_cached_result, cache_result
from backend.services.regions_repo import search_regions

router = APIRouter(tags=["search"])


@router.get("/search")
async def search_cached(q: str, limit: int = 20):
    """
    Search regions with caching.
    
    - Normalizes query (lowercase, trim, collapse whitespace)
    - Checks cache (key = SHA256 of normalized query)
    - If cached and not expired: returns cached result and increments hit_count
    - If missing/expired: runs search, caches for 7 days, returns result
    
    Example: GET /search?q=motor%20cortex -> [region1, region2, ...]
    """
    if not q or len(q.strip()) == 0:
        raise HTTPException(status_code=400, detail="Query cannot be empty")
    
    # Try cache first
    cached = get_cached_result(q)
    if cached is not None:
        return cached
    
    # Cache miss: run search and cache result
    results = search_regions(q, limit=limit)
    cache_result(q, results, ttl_days=7)
    
    return results
