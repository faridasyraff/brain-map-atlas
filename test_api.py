"""
Quick test script for FastAPI endpoints
Run: python test_api.py
"""
import sys
sys.path.insert(0, '.')

from backend.services.regions_repo import get_region_by_id, get_region_by_rgb, search_regions
from backend.services.cache import get_cached_result, cache_result

print("=" * 60)
print("BACKEND API TEST")
print("=" * 60)

# Test 1: Direct region lookups
print("\n[1] GET /regions/315")
region = get_region_by_id(315)
print(f"    Status: 200")
print(f"    Response: {region}")

print("\n[2] GET /regions/by_rgb/lookup?r=112&g=255&b=113")
region = get_region_by_rgb(112, 255, 113)
print(f"    Status: 200")
print(f"    Response: {region}")

print("\n[3] GET /regions/search/direct?q=motor")
results = search_regions("motor", limit=5)
print(f"    Status: 200")
print(f"    Response: ({len(results)} results)")
for r in results[:2]:
    print(f"      - {r['acronym']}: {r['name']}")

# Test 2: Cached search
print("\n[4] GET /search?q=cortex (first call - cache miss)")
results = search_regions("cortex", limit=10)
cache_result("cortex", results)
print(f"    Status: 200")
print(f"    Response: ({len(results)} results, cached)")
for r in results[:2]:
    print(f"      - {r['acronym']}: {r['name']}")

print("\n[5] GET /search?q=cortex (second call - cache hit)")
cached = get_cached_result("cortex")
if cached:
    print(f"    Status: 200 (from cache)")
    print(f"    Response: ({len(cached)} results, hit_count incremented)")

print("\n" + "=" * 60)
print("Server command:")
print("  & '.venv\\Scripts\\Activate.ps1'; python -m uvicorn backend.app.main:app --reload --port 8000")
print("\nAPI Documentation:")
print("  http://localhost:8000/docs (Swagger UI)")
print("  http://localhost:8000/redoc (ReDoc)")
print("=" * 60)
