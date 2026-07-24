import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AnalysisResult,
  ArticleDetail,
  ArticleSummary,
  CapabilityTag,
  OpportunityTag,
  ProviderId,
  ReleaseKind,
  RunSummary,
} from "@mpm/contracts";
import type { ReleaseCandidate } from "./sources.js";
import type { ArticleFilters, ReleaseRepository, ReleaseStatus, StoredRelease } from "./repository.js";

type Row = Record<string, unknown>;

export type { ArticleFilters, ReleaseRepository, ReleaseStatus, StoredRelease } from "./repository.js";

export interface PublishedReleaseForSync {
  release: StoredRelease & { collectedAt: string; sourceOrder: number };
  article: {
    slug: string;
    title: string;
    summary: string;
    modelsJson: string;
    releaseKind: string;
    capabilityTagsJson: string;
    opportunityTagsJson: string;
    analysisJson: string;
    createdAt: string;
  };
}

function parseJsonArray<T extends string>(value: unknown): T[] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((item): item is T => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export class RadarDatabase implements ReleaseRepository {
  readonly sqlite: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.sqlite = new DatabaseSync(file);
    this.sqlite.exec("PRAGMA journal_mode = WAL;");
    this.sqlite.exec(`
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
    `);
    this.ensureColumn("releases", "status", "TEXT NOT NULL DEFAULT 'pending'");
    this.ensureColumn("releases", "analysis_attempts", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("releases", "last_analysis_error", "TEXT");
    this.ensureColumn("releases", "analysis_started_at", "TEXT");
    this.ensureColumn("releases", "source_order", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("articles", "models_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("articles", "release_kind", "TEXT NOT NULL DEFAULT 'model_update'");
    this.ensureColumn("articles", "capability_tags_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("articles", "opportunity_tags_json", "TEXT NOT NULL DEFAULT '[]'");
    this.sqlite.exec("UPDATE releases SET status = 'published' WHERE EXISTS (SELECT 1 FROM articles WHERE articles.release_id = releases.id)");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (!columns.some((item) => item.name === column)) this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  async startRun(): Promise<number> {
    const result = this.sqlite.prepare("INSERT INTO runs (status, started_at) VALUES ('running', ?)").run(new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  async finishRun(id: number, result: Omit<RunSummary, "id" | "startedAt" | "finishedAt">): Promise<void> {
    this.sqlite.prepare("UPDATE runs SET status = ?, finished_at = ?, discovered_count = ?, published_count = ?, error = ? WHERE id = ?")
      .run(result.status, new Date().toISOString(), result.discoveredCount, result.publishedCount, result.error, id);
  }

  async listRuns(): Promise<RunSummary[]> {
    return (this.sqlite.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 30").all() as Row[]).map((row) => ({
      id: Number(row.id),
      status: row.status as RunSummary["status"],
      startedAt: String(row.started_at),
      finishedAt: row.finished_at ? String(row.finished_at) : null,
      discoveredCount: Number(row.discovered_count),
      publishedCount: Number(row.published_count),
      error: row.error ? String(row.error) : null,
    }));
  }

  async insertRelease(candidate: ReleaseCandidate): Promise<number | null> {
    const result = this.sqlite.prepare(`INSERT OR IGNORE INTO releases
      (provider, source_url, source_title, source_excerpt, raw_content, published_at, fingerprint, collected_at, source_order, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(
      candidate.provider, candidate.sourceUrl, candidate.sourceTitle, candidate.sourceExcerpt,
      candidate.rawContent, candidate.publishedAt, candidate.fingerprint, new Date().toISOString(), candidate.sourceOrder ?? 0,
    );
    return result.changes === 1 ? Number(result.lastInsertRowid) : null;
  }

  async syncReleaseSourceOrder(candidate: ReleaseCandidate): Promise<void> {
    this.sqlite.prepare(`UPDATE releases SET source_order = ?
      WHERE provider = ? AND source_url = ? AND fingerprint = ?`).run(
      candidate.sourceOrder ?? 0, candidate.provider, candidate.sourceUrl, candidate.fingerprint,
    );
  }

  async claimNextRelease(excludedIds: number[] = [], provider?: string): Promise<StoredRelease | null> {
    const staleBefore = new Date(Date.now() - 15 * 60_000).toISOString();
    const providerFilter = provider ? "AND provider = ?" : "";
    const exclusions = excludedIds.length ? `AND id NOT IN (${excludedIds.map(() => "?").join(", ")})` : "";
    const row = this.sqlite.prepare(`SELECT * FROM releases
      WHERE (status IN ('pending', 'retryable_failed')
        OR (status = 'analyzing' AND analysis_started_at < ?))
      ${providerFilter}
      ${exclusions}
      ORDER BY published_at ASC, id ASC LIMIT 1`).get(staleBefore, ...(provider ? [provider] : []), ...excludedIds) as Row | undefined;
    if (!row) return null;
    const update = this.sqlite.prepare(`UPDATE releases
      SET status = 'analyzing', analysis_attempts = analysis_attempts + 1,
          analysis_started_at = ?, last_analysis_error = NULL
      WHERE id = ? AND (status IN ('pending', 'retryable_failed') OR (status = 'analyzing' AND analysis_started_at < ?))`)
      .run(new Date().toISOString(), Number(row.id), staleBefore);
    return update.changes === 1 ? this.getRelease(Number(row.id)) : null;
  }

  async getRelease(id: number): Promise<StoredRelease | null> {
    const row = this.sqlite.prepare("SELECT * FROM releases WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: Number(row.id), provider: String(row.provider) as ProviderId, sourceUrl: String(row.source_url),
      sourceTitle: String(row.source_title), sourceExcerpt: String(row.source_excerpt), rawContent: String(row.raw_content),
      publishedAt: String(row.published_at), fingerprint: String(row.fingerprint), status: String(row.status) as ReleaseStatus,
      analysisAttempts: Number(row.analysis_attempts), lastAnalysisError: row.last_analysis_error ? String(row.last_analysis_error) : null,
    };
  }

  async markReleaseRetryableFailed(id: number, error: string): Promise<void> {
    this.sqlite.prepare("UPDATE releases SET status = 'retryable_failed', last_analysis_error = ?, analysis_started_at = NULL WHERE id = ?")
      .run(error.slice(0, 2_000), id);
  }

  async publishArticle(release: StoredRelease, analysis: AnalysisResult): Promise<ArticleDetail> {
    const slug = `${release.provider}-${release.publishedAt.slice(0, 10)}-${release.fingerprint.slice(0, 10)}`;
    const createdAt = new Date().toISOString();
    this.sqlite.exec("BEGIN");
    try {
      this.sqlite.prepare(`INSERT INTO articles
        (release_id, slug, title, summary, models_json, release_kind, capability_tags_json, opportunity_tags_json, analysis_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(release.id, slug, analysis.title, analysis.summary, JSON.stringify(analysis.models), analysis.releaseKind,
          JSON.stringify(analysis.capabilityTags), JSON.stringify(analysis.opportunityTags), JSON.stringify(analysis), createdAt);
      this.sqlite.prepare("UPDATE releases SET status = 'published', last_analysis_error = NULL, analysis_started_at = NULL WHERE id = ?").run(release.id);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.articleFromRow({
      slug, title: analysis.title, summary: analysis.summary, created_at: createdAt, provider: release.provider,
      published_at: release.publishedAt, collected_at: createdAt, source_url: release.sourceUrl, source_title: release.sourceTitle,
      source_excerpt: release.sourceExcerpt, analysis_json: JSON.stringify(analysis), models_json: JSON.stringify(analysis.models),
      release_kind: analysis.releaseKind, capability_tags_json: JSON.stringify(analysis.capabilityTags),
      opportunity_tags_json: JSON.stringify(analysis.opportunityTags),
    }, true) as ArticleDetail;
  }

  async listArticles(filters: ArticleFilters = {}): Promise<ArticleSummary[]> {
    const rows = this.sqlite.prepare(`SELECT a.slug, a.title, a.summary, a.models_json, a.release_kind, a.capability_tags_json,
      a.opportunity_tags_json, a.created_at, r.provider, r.published_at, r.collected_at, r.source_url
      FROM articles a JOIN releases r ON a.release_id = r.id
      ${filters.provider ? "WHERE r.provider = ?" : ""} ORDER BY r.published_at DESC, r.source_order ASC, a.id DESC`)
      .all(...(filters.provider ? [filters.provider] : [])) as Row[];
    return rows.map((row) => this.articleFromRow(row, false) as ArticleSummary).filter((article) =>
      (!filters.model || article.models.includes(filters.model))
      && (!filters.capabilityTag || article.capabilityTags.includes(filters.capabilityTag as CapabilityTag))
      && (!filters.opportunityTag || article.opportunityTags.includes(filters.opportunityTag as OpportunityTag)),
    );
  }

  async getArticle(slug: string): Promise<ArticleDetail | null> {
    const row = this.sqlite.prepare(`SELECT a.slug, a.title, a.summary, a.models_json, a.release_kind, a.capability_tags_json,
      a.opportunity_tags_json, a.analysis_json, a.created_at, r.provider, r.published_at, r.collected_at, r.source_url,
      r.source_title, r.source_excerpt FROM articles a JOIN releases r ON a.release_id = r.id WHERE a.slug = ?`).get(slug) as Row | undefined;
    return row ? this.articleFromRow(row, true) as ArticleDetail : null;
  }

  /** Local-only export for the reviewed, idempotent D1 bootstrap command. */
  listPublishedForSync(provider: string): PublishedReleaseForSync[] {
    const rows = this.sqlite.prepare(`SELECT r.*, a.slug, a.title, a.summary, a.models_json, a.release_kind,
      a.capability_tags_json, a.opportunity_tags_json, a.analysis_json, a.created_at
      FROM releases r JOIN articles a ON a.release_id = r.id
      WHERE r.provider = ? AND r.status = 'published'
      ORDER BY r.published_at DESC, r.source_order ASC, a.id DESC`).all(provider) as Row[];
    return rows.map((row) => ({
      release: {
        id: Number(row.id), provider: String(row.provider) as ProviderId, sourceUrl: String(row.source_url),
        sourceTitle: String(row.source_title), sourceExcerpt: String(row.source_excerpt), rawContent: String(row.raw_content),
        publishedAt: String(row.published_at), fingerprint: String(row.fingerprint), collectedAt: String(row.collected_at),
        sourceOrder: Number(row.source_order), status: String(row.status) as ReleaseStatus,
        analysisAttempts: Number(row.analysis_attempts), lastAnalysisError: row.last_analysis_error ? String(row.last_analysis_error) : null,
      },
      article: {
        slug: String(row.slug), title: String(row.title), summary: String(row.summary), modelsJson: String(row.models_json),
        releaseKind: String(row.release_kind), capabilityTagsJson: String(row.capability_tags_json),
        opportunityTagsJson: String(row.opportunity_tags_json), analysisJson: String(row.analysis_json), createdAt: String(row.created_at),
      },
    }));
  }

  private articleFromRow(row: Row, detail: boolean): ArticleSummary | ArticleDetail {
    const summary: ArticleSummary = {
      slug: String(row.slug), title: String(row.title), provider: String(row.provider) as ProviderId,
      publishedAt: String(row.published_at), collectedAt: String(row.collected_at), summary: String(row.summary),
      sourceUrl: String(row.source_url), models: parseJsonArray<string>(row.models_json), releaseKind: String(row.release_kind) as ReleaseKind,
      capabilityTags: parseJsonArray<CapabilityTag>(row.capability_tags_json), opportunityTags: parseJsonArray<OpportunityTag>(row.opportunity_tags_json),
    };
    if (!detail) return summary;
    return {
      ...summary, sourceTitle: String(row.source_title), sourceExcerpt: String(row.source_excerpt),
      analysis: JSON.parse(String(row.analysis_json)) as AnalysisResult,
    };
  }
}
