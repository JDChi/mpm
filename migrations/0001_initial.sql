CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_title TEXT NOT NULL,
  source_excerpt TEXT NOT NULL,
  raw_content TEXT NOT NULL,
  published_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  analysis_attempts INTEGER NOT NULL DEFAULT 0,
  last_analysis_error TEXT,
  analysis_started_at TEXT,
  source_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(provider, source_url, fingerprint)
);

CREATE INDEX IF NOT EXISTS releases_claim_idx ON releases(status, published_at, id);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY,
  release_id INTEGER NOT NULL UNIQUE REFERENCES releases(id),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  models_json TEXT NOT NULL DEFAULT '[]',
  release_kind TEXT NOT NULL DEFAULT 'model_update',
  capability_tags_json TEXT NOT NULL DEFAULT '[]',
  opportunity_tags_json TEXT NOT NULL DEFAULT '[]',
  analysis_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  published_count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
