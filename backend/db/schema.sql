-- PostgreSQL schema for Brain Atlas
-- Foreign keys are enabled by default in PostgreSQL

CREATE TABLE IF NOT EXISTS brain_regions (
  id SERIAL PRIMARY KEY,
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
  annotation_id INTEGER,
  graph_order REAL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
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

CREATE INDEX IF NOT EXISTS idx_brain_regions_annotation_id
ON brain_regions(annotation_id);

CREATE TABLE IF NOT EXISTS search_cache (
  id SERIAL PRIMARY KEY,
  cache_key TEXT UNIQUE NOT NULL,
  query_text TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  result_json TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_cache_expires_at
ON search_cache(expires_at);
