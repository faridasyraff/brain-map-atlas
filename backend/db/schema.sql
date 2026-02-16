PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS brain_regions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mba_id INTEGER UNIQUE NOT NULL,
  identifier TEXT NOT NULL,
  acronym TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_mba_id INTEGER,
  parent_identifier TEXT,
  depth INTEGER,
  color_r INTEGER,
  color_g INTEGER,
  color_b INTEGER,
  color_hex TEXT,
  graph_order REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(parent_mba_id) REFERENCES brain_regions(mba_id)
);

CREATE INDEX IF NOT EXISTS idx_brain_regions_parent_mba_id
ON brain_regions(parent_mba_id);

CREATE INDEX IF NOT EXISTS idx_brain_regions_name
ON brain_regions(name);

CREATE INDEX IF NOT EXISTS idx_brain_regions_acronym
ON brain_regions(acronym);

CREATE INDEX IF NOT EXISTS idx_brain_regions_rgb
ON brain_regions(color_r, color_g, color_b);

CREATE TABLE IF NOT EXISTS search_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_key TEXT UNIQUE NOT NULL,
  query_text TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  result_json TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_cache_expires_at
ON search_cache(expires_at);
