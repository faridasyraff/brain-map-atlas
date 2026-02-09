"""Region lookup routes"""
from fastapi import APIRouter, HTTPException

from backend.services.regions_repo import (
    get_region_by_id,
    get_region_by_rgb,
    search_regions,
    get_region_by_annotation,
)

router = APIRouter(prefix="/regions", tags=["regions"])


@router.get("/{mba_id}")
async def get_region(mba_id: int):
    """
    Get a single region by MBA structure ID.
    
    Example: GET /regions/315 -> Isocortex
    """
    region = get_region_by_id(mba_id)
    if region is None:
        raise HTTPException(status_code=404, detail=f"Region MBA:{mba_id} not found")
    return region


@router.get("/by_rgb/lookup")
async def get_region_by_rgb_lookup(r: int, g: int, b: int):
    """
    Get region by RGB color values (from 2D slice label PNG).
    
    Returns 404 if RGB(0, 0, 0) (background) or region not found.
    
    Example: GET /regions/by_rgb/lookup?r=112&g=255&b=113 -> Isocortex
    """
    # Background pixels return 404
    if r == 0 and g == 0 and b == 0:
        raise HTTPException(status_code=404, detail="Background pixel (0,0,0)")
    
    region = get_region_by_rgb(r, g, b)
    if region is None:
        raise HTTPException(status_code=404, detail=f"No region found for RGB({r},{g},{b})")
    
    return region


@router.get("/by_annotation/{annotation_id}")
async def get_region_by_annotation_lookup(annotation_id: int):
    """
    Get region by combined annotation id encoded in label PNG (annotation_id = b + (g<<8) + (r<<16)).
    Returns 404 if not found.
    Example: GET /regions/by_annotation/526157192
    """
    # annotation_id 0 treated as background
    if annotation_id == 0:
        raise HTTPException(status_code=404, detail="Background annotation id 0")

    region = get_region_by_annotation(annotation_id)
    if region is None:
        raise HTTPException(status_code=404, detail=f"No region found for annotationId {annotation_id}")

    return region


@router.get("/search/direct")
async def search_regions_direct(q: str, limit: int = 20):
    """
    Search regions by acronym or name (no caching).
    
    Example: GET /regions/search/direct?q=motor -> [MOp, MOs, ...]
    """
    if not q or len(q.strip()) == 0:
        raise HTTPException(status_code=400, detail="Query cannot be empty")
    
    results = search_regions(q, limit=limit)
    return results
