# Brain Atlas Backend API

SQLite-backed FastAPI server for region lookup, RGB-to-region mapping, and cached semantic search.

## Quick Start

### 1. Initialize Database (one-time)

```bash
python backend/db/init_db.py
python backend/db/seed_db.py
```

### 2. Run Server

Activate venv first:
```powershell
& '.venv\Scripts\Activate.ps1'
python -m uvicorn backend.app.main:app --reload --port 8000
```

Or on Mac/Linux:
```bash
source .venv/bin/activate
uvicorn backend.app.main:app --reload --port 8000
```

Server will be available at: **http://localhost:8000**

### 3. Interactive API Docs

- **Swagger UI**: http://localhost:8000/docs
- **ReDoc**: http://localhost:8000/redoc

## API Endpoints

### Region Lookup

**GET** `/regions/{mba_id}`
- Fetch a single region by MBA structure ID
- Example: `GET /regions/315` → Isocortex
- Response: `200 JSON region object` or `404`

```json
{
  "id": 6,
  "mba_id": 315,
  "identifier": "MBA:315",
  "acronym": "Isocortex",
  "name": "Isocortex",
  "parent_mba_id": 695,
  "color_r": 112,
  "color_g": 255,
  "color_b": 113,
  "color_hex": "#70FF71",
  "graph_order": 5.0
}
```

### RGB Lookup (for 2D Slice Clicking)

**GET** `/regions/by_rgb/lookup?r={r}&g={g}&b={b}`
- Find region by RGB color (from label PNG pixel)
- Example: `GET /regions/by_rgb/lookup?r=112&g=255&b=113` → Isocortex
- Returns `404` if RGB(0,0,0) (background) or no match found

### Direct Search (No Cache)

**GET** `/regions/search/direct?q={query}&limit={limit}`
- Search regions by acronym or name using LIKE matching
- Case-insensitive
- Example: `GET /regions/search/direct?q=motor&limit=5`
- Response: `200 JSON [region, ...]`

### Cached Search

**GET** `/search?q={query}&limit={limit}`
- Search with automatic caching (7-day TTL)
- First call: runs search, caches result
- Subsequent calls with same query: returns cached result, increments hit_count
- Query normalization: lowercase, trim whitespace
- Cache key: SHA256 hash of normalized query
- Response: `200 JSON [region, ...]`

### Health Check

**GET** `/health`
- Simple heartbeat endpoint
- Response: `{"status": "ok"}`

## Architecture

### Database (SQLite)

**Location**: `backend/data/brain_atlas.db`

**Tables**:
- `brain_regions`: 1,327 regions from Allen Brain Atlas
  - Columns: id, mba_id, identifier, acronym, name, parent_mba_id, parent_identifier, depth, color_r/g/b, color_hex, graph_order, created_at
  - Indexes: mba_id (unique), parent_mba_id, acronym, name, RGB composite
- `search_cache`: Cached search results
  - Columns: id, cache_key (unique), query_text, normalized_query, result_json, hit_count, created_at, expires_at
  - Index: expires_at

### Services

**`backend/services/db.py`**
- `get_conn()` - Open SQLite connection with row_factory
- `dict_from_row()` - Convert sqlite3.Row to dict

**`backend/services/regions_repo.py`**
- `get_region_by_id(mba_id)` - Fetch by structure ID
- `get_region_by_rgb(r, g, b)` - Fetch by color (2D slicing)
- `search_regions(query, limit)` - Search by acronym/name

**`backend/services/cache.py`**
- `normalize_query(q)` - Lowercase, trim, collapse whitespace
- `cache_key_from_query(q)` - SHA256 hash
- `get_cached_result(q)` - Check cache, increment hit_count, return if not expired
- `cache_result(q, result, ttl_days=7)` - Upsert cache entry

### Routes

**`backend/app/routes/regions.py`**
- `/regions/{mba_id}` - Single region
- `/regions/by_rgb/lookup` - RGB lookup
- `/regions/search/direct` - Uncached search

**`backend/app/routes/search.py`**
- `/search` - Cached search

### FastAPI App

**`backend/app/main.py`**
- FastAPI setup
- CORS middleware (allows http://localhost:5173)
- Route inclusion
- Health endpoint

## Testing

Run the test script to verify all endpoints work:

```bash
python test_api.py
```

## Notes

- **No ORM**: Using raw sqlite3 for simplicity and transparency
- **No external cache**: Results cached in SQLite search_cache table
- **Local DB**: Single-file SQLite, no server setup needed
- **Short-lived connections**: New connection per request, closed immediately
- **Background pixels**: RGB(0,0,0) returns 404 (use direct search if needed)
- **Thread-safe**: sqlite3 with default isolation level

## Future Enhancements

- Add hierarchy traversal (parent chain, children, depth)
- Implement fuzzy/semantic search with embeddings
- Add region statistics (volume, surface area)
- Support Allen API enrichment as fallback
- Add pagination to search results
- Cache invalidation strategies
