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
import type { ReleaseCandidate } from "../../api/src/sources.js";
import type { ArticleFilters, ReleaseRepository, ReleaseStatus, StoredRelease } from "../../api/src/repository.js";

type Row = Record<string, unknown>;

function parseJsonArray<T extends string>(value: unknown): T[] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((item): item is T => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export class D1RadarDatabase implements ReleaseRepository {
  constructor(private readonly database: D1Database) {}

  async startRun(): Promise<number> {
    const result = await this.database.prepare("INSERT INTO runs (status, started_at) VALUES ('running', ?)").bind(new Date().toISOString()).run();
    return Number(result.meta.last_row_id);
  }

  async finishRun(id: number, result: Omit<RunSummary, "id" | "startedAt" | "finishedAt">): Promise<void> {
    await this.database.prepare("UPDATE runs SET status = ?, finished_at = ?, discovered_count = ?, published_count = ?, error = ? WHERE id = ?")
      .bind(result.status, new Date().toISOString(), result.discoveredCount, result.publishedCount, result.error, id).run();
  }

  async listRuns(): Promise<RunSummary[]> {
    const rows = (await this.database.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 30").all<Row>()).results;
    return rows.map((row) => ({
      id: Number(row.id), status: row.status as RunSummary["status"], startedAt: String(row.started_at),
      finishedAt: row.finished_at ? String(row.finished_at) : null, discoveredCount: Number(row.discovered_count),
      publishedCount: Number(row.published_count), error: row.error ? String(row.error) : null,
    }));
  }

  async insertRelease(candidate: ReleaseCandidate): Promise<number | null> {
    const result = await this.database.prepare(`INSERT OR IGNORE INTO releases
      (provider, source_url, source_title, source_excerpt, raw_content, published_at, fingerprint, collected_at, source_order, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).bind(
      candidate.provider, candidate.sourceUrl, candidate.sourceTitle, candidate.sourceExcerpt, candidate.rawContent,
      candidate.publishedAt, candidate.fingerprint, new Date().toISOString(), candidate.sourceOrder ?? 0,
    ).run();
    return result.meta.changes === 1 ? Number(result.meta.last_row_id) : null;
  }

  async syncReleaseSourceOrder(candidate: ReleaseCandidate): Promise<void> {
    await this.database.prepare(`UPDATE releases SET source_order = ?
      WHERE provider = ? AND source_url = ? AND fingerprint = ?`).bind(
      candidate.sourceOrder ?? 0, candidate.provider, candidate.sourceUrl, candidate.fingerprint,
    ).run();
  }

  async claimNextRelease(excludedIds: number[] = []): Promise<StoredRelease | null> {
    const staleBefore = new Date(Date.now() - 15 * 60_000).toISOString();
    const exclusions = excludedIds.length ? `AND id NOT IN (${excludedIds.map(() => "?").join(", ")})` : "";
    const row = await this.database.prepare(`SELECT * FROM releases
      WHERE (status IN ('pending', 'retryable_failed') OR (status = 'analyzing' AND analysis_started_at < ?))
      ${exclusions} ORDER BY published_at ASC, id ASC LIMIT 1`).bind(staleBefore, ...excludedIds).first<Row>();
    if (!row) return null;
    const result = await this.database.prepare(`UPDATE releases SET status = 'analyzing', analysis_attempts = analysis_attempts + 1,
      analysis_started_at = ?, last_analysis_error = NULL
      WHERE id = ? AND (status IN ('pending', 'retryable_failed') OR (status = 'analyzing' AND analysis_started_at < ?))`)
      .bind(new Date().toISOString(), Number(row.id), staleBefore).run();
    return result.meta.changes === 1 ? this.getRelease(Number(row.id)) : null;
  }

  async getRelease(id: number): Promise<StoredRelease | null> {
    const row = await this.database.prepare("SELECT * FROM releases WHERE id = ?").bind(id).first<Row>();
    return row ? this.releaseFromRow(row) : null;
  }

  async markReleaseRetryableFailed(id: number, error: string): Promise<void> {
    await this.database.prepare("UPDATE releases SET status = 'retryable_failed', last_analysis_error = ?, analysis_started_at = NULL WHERE id = ?")
      .bind(error.slice(0, 2_000), id).run();
  }

  async publishArticle(release: StoredRelease, analysis: AnalysisResult): Promise<ArticleDetail> {
    const slug = `${release.provider}-${release.publishedAt.slice(0, 10)}-${release.fingerprint.slice(0, 10)}`;
    const createdAt = new Date().toISOString();
    await this.database.batch([
      this.database.prepare(`INSERT INTO articles
        (release_id, slug, title, summary, models_json, release_kind, capability_tags_json, opportunity_tags_json, analysis_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        release.id, slug, analysis.title, analysis.summary, JSON.stringify(analysis.models), analysis.releaseKind,
        JSON.stringify(analysis.capabilityTags), JSON.stringify(analysis.opportunityTags), JSON.stringify(analysis), createdAt,
      ),
      this.database.prepare("UPDATE releases SET status = 'published', last_analysis_error = NULL, analysis_started_at = NULL WHERE id = ?").bind(release.id),
    ]);
    return {
      slug, title: analysis.title, provider: release.provider, publishedAt: release.publishedAt, collectedAt: createdAt,
      summary: analysis.summary, sourceUrl: release.sourceUrl, models: analysis.models, releaseKind: analysis.releaseKind,
      capabilityTags: analysis.capabilityTags, opportunityTags: analysis.opportunityTags, sourceTitle: release.sourceTitle,
      sourceExcerpt: release.sourceExcerpt, analysis,
    };
  }

  async listArticles(filters: ArticleFilters = {}): Promise<ArticleSummary[]> {
    const rows = (await this.database.prepare(`SELECT a.slug, a.title, a.summary, a.models_json, a.release_kind, a.capability_tags_json,
      a.opportunity_tags_json, a.created_at, r.provider, r.published_at, r.collected_at, r.source_url
      FROM articles a JOIN releases r ON a.release_id = r.id
      ${filters.provider ? "WHERE r.provider = ?" : ""} ORDER BY r.published_at DESC, r.source_order ASC, a.id DESC`)
      .bind(...(filters.provider ? [filters.provider] : [])).all<Row>()).results;
    return rows.map((row) => this.articleFromRow(row, false) as ArticleSummary).filter((article) =>
      (!filters.model || article.models.includes(filters.model))
      && (!filters.capabilityTag || article.capabilityTags.includes(filters.capabilityTag as CapabilityTag))
      && (!filters.opportunityTag || article.opportunityTags.includes(filters.opportunityTag as OpportunityTag)),
    );
  }

  async getArticle(slug: string): Promise<ArticleDetail | null> {
    const row = await this.database.prepare(`SELECT a.slug, a.title, a.summary, a.models_json, a.release_kind, a.capability_tags_json,
      a.opportunity_tags_json, a.analysis_json, a.created_at, r.provider, r.published_at, r.collected_at, r.source_url,
      r.source_title, r.source_excerpt FROM articles a JOIN releases r ON a.release_id = r.id WHERE a.slug = ?`).bind(slug).first<Row>();
    return row ? this.articleFromRow(row, true) as ArticleDetail : null;
  }

  private releaseFromRow(row: Row): StoredRelease {
    return {
      id: Number(row.id), provider: String(row.provider) as ProviderId, sourceUrl: String(row.source_url),
      sourceTitle: String(row.source_title), sourceExcerpt: String(row.source_excerpt), rawContent: String(row.raw_content),
      publishedAt: String(row.published_at), fingerprint: String(row.fingerprint), sourceOrder: Number(row.source_order),
      status: String(row.status) as ReleaseStatus, analysisAttempts: Number(row.analysis_attempts),
      lastAnalysisError: row.last_analysis_error ? String(row.last_analysis_error) : null,
    };
  }

  private articleFromRow(row: Row, detail: boolean): ArticleSummary | ArticleDetail {
    const summary: ArticleSummary = {
      slug: String(row.slug), title: String(row.title), provider: String(row.provider) as ProviderId,
      publishedAt: String(row.published_at), collectedAt: String(row.collected_at), summary: String(row.summary),
      sourceUrl: String(row.source_url), models: parseJsonArray<string>(row.models_json), releaseKind: String(row.release_kind) as ReleaseKind,
      capabilityTags: parseJsonArray<CapabilityTag>(row.capability_tags_json), opportunityTags: parseJsonArray<OpportunityTag>(row.opportunity_tags_json),
    };
    return detail ? { ...summary, sourceTitle: String(row.source_title), sourceExcerpt: String(row.source_excerpt), analysis: JSON.parse(String(row.analysis_json)) as AnalysisResult } : summary;
  }
}
