import { describe, expect, it } from "vitest";
import { renderD1SyncSql, renderD1VerificationQuery } from "../src/d1-sync.js";
import type { PublishedReleaseForSync } from "../src/db.js";

const record: PublishedReleaseForSync = {
  release: {
    id: 1, provider: "kimi", sourceUrl: "https://platform.kimi.com/docs/guide/kimi-k3-quickstart",
    sourceTitle: "Kimi API Platform · Kimi K3", sourceExcerpt: "K3's official notes", rawContent: "K3's official notes",
    publishedAt: "2026-07-24T00:00:00.000Z", collectedAt: "2026-07-24T01:00:00.000Z", fingerprint: "fingerprint", sourceOrder: 0,
    status: "published", analysisAttempts: 1, lastAnalysisError: null,
  },
  article: {
    slug: "kimi-2026-07-24-fingerprin", title: "K3 的产品机会", summary: "摘要", modelsJson: '["Kimi K3"]', releaseKind: "new_model",
    capabilityTagsJson: '["reasoning"]', opportunityTagsJson: '["agent"]', analysisJson: '{"title":"K3 的产品机会"}', createdAt: "2026-07-24T01:02:00.000Z",
  },
};

describe("D1 bootstrap SQL", () => {
  it("is idempotent and escapes official content safely", () => {
    const sql = renderD1SyncSql([record]);
    expect(sql).toContain("INSERT OR IGNORE INTO releases");
    expect(sql).toContain("INSERT OR IGNORE INTO articles");
    expect(sql).toContain("K3''s official notes");
    expect(sql).toContain("status = 'published'");
    expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT)\b/);
  });

  it("uses a provider-only remote verification query", () => {
    expect(renderD1VerificationQuery("zhipu")).toContain("WHERE r.provider = 'zhipu'");
  });
});
