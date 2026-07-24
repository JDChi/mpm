import type { PublishedReleaseForSync } from "./db.js";

function sqlString(value: string): string {
  if (value.includes("\0")) throw new Error("Cannot sync SQLite text containing a NUL byte");
  return `'${value.replaceAll("'", "''")}'`;
}

function releaseIdentity(record: PublishedReleaseForSync): string {
  const { provider, sourceUrl, fingerprint } = record.release;
  return `provider = ${sqlString(provider)} AND source_url = ${sqlString(sourceUrl)} AND fingerprint = ${sqlString(fingerprint)}`;
}

/**
 * Builds a retry-safe D1 import. Existing releases and articles are never
 * overwritten; the final update only makes sure an imported article's release
 * is not left pending for the production Workflow to analyze again. Wrangler's
 * remote D1 file executor owns the transaction, so this must not emit BEGIN or
 * COMMIT statements.
 */
export function renderD1SyncSql(records: PublishedReleaseForSync[]): string {
  if (records.length === 0) return "";
  const statements: string[] = [];

  for (const record of records) {
    const { release, article } = record;
    statements.push(`INSERT OR IGNORE INTO releases
      (provider, source_url, source_title, source_excerpt, raw_content, published_at, fingerprint, collected_at, status, source_order)
      VALUES (${sqlString(release.provider)}, ${sqlString(release.sourceUrl)}, ${sqlString(release.sourceTitle)},
        ${sqlString(release.sourceExcerpt)}, ${sqlString(release.rawContent)}, ${sqlString(release.publishedAt)},
        ${sqlString(release.fingerprint)}, ${sqlString(release.collectedAt)}, 'published', ${release.sourceOrder});`);
    statements.push(`INSERT OR IGNORE INTO articles
      (release_id, slug, title, summary, models_json, release_kind, capability_tags_json, opportunity_tags_json, analysis_json, created_at)
      SELECT id, ${sqlString(article.slug)}, ${sqlString(article.title)}, ${sqlString(article.summary)},
        ${sqlString(article.modelsJson)}, ${sqlString(article.releaseKind)}, ${sqlString(article.capabilityTagsJson)},
        ${sqlString(article.opportunityTagsJson)}, ${sqlString(article.analysisJson)}, ${sqlString(article.createdAt)}
      FROM releases WHERE ${releaseIdentity(record)};`);
    statements.push(`UPDATE releases SET status = 'published', last_analysis_error = NULL, analysis_started_at = NULL
      WHERE ${releaseIdentity(record)} AND EXISTS (SELECT 1 FROM articles WHERE articles.release_id = releases.id);`);
  }

  return `${statements.join("\n")}\n`;
}

export function renderD1VerificationQuery(provider: string): string {
  return `SELECT r.provider, COUNT(*) AS releases, COUNT(a.id) AS articles
    FROM releases r LEFT JOIN articles a ON a.release_id = r.id
    WHERE r.provider = ${sqlString(provider)}
    GROUP BY r.provider;`;
}
