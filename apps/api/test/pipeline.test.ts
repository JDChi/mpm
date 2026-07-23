import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisResult } from "@mpm/contracts";
import { RadarDatabase } from "../src/db.js";
import { makeAnalysisForTest, validateAnalysis } from "../src/analyzer.js";
import { runCollection } from "../src/pipeline.js";
import { makeCandidate, type SourceProvider } from "../src/sources.js";

const candidate = makeCandidate({
  provider: "openai",
  sourceUrl: "https://example.com/notes",
  sourceTitle: "OpenAI · July 1, 2026",
  sourceExcerpt: "GPT Example launched",
  rawContent: "GPT Example launched with a larger context window.",
  publishedAt: "2026-07-01T12:00:00.000Z",
});

const analysis: AnalysisResult = makeAnalysisForTest({
  title: "GPT Example 带来更长上下文工作流",
  summary: "适合长文档助手。",
  models: ["GPT Example"],
  capabilityTags: ["context"],
  opportunityTags: ["rag"],
  keyChanges: ["官方发布了更长上下文窗口。"],
  potentialFeatures: [{ name: "长文档工作台", scenario: "法务审阅", rationale: "可容纳完整材料", prerequisites: ["成本评估"], confidence: "medium" }],
  caveats: ["功能建议是 AI 推演。"],
});

describe("collection pipeline", () => {
  it("validates the fixed model and category taxonomy", () => {
    expect(validateAnalysis(analysis).models).toEqual(["GPT Example"]);
    expect(validateAnalysis({ ...analysis, capabilityTags: ["freeform"] }).capabilityTags).toEqual([]);
    expect(() => validateAnalysis({ ...analysis, releaseKind: "freeform" })).toThrow();
    expect(validateAnalysis({ ...analysis, capabilityTags: ["推理", "模型幻觉"], opportunityTags: ["智能体"], releaseKind: "模型能力更新" }).capabilityTags).toEqual(["reasoning"]);
  });

  it("publishes once and deduplicates repeated source content", async () => {
    const db = new RadarDatabase(join(mkdtempSync(join(tmpdir(), "mpm-")), "test.sqlite"));
    const source: SourceProvider = { id: "openai", label: "OpenAI", fetchUpdates: async () => [candidate] };
    const analyzer = { analyze: async () => analysis };
    const first = await runCollection(db, [source], analyzer);
    const second = await runCollection(db, [source], analyzer);
    expect(first.status).toBe("succeeded");
    expect(first.publishedCount).toBe(1);
    expect(second.publishedCount).toBe(0);
    expect(await db.listArticles()).toHaveLength(1);
  });

  it("retries a previously stored release when its earlier analysis failed", async () => {
    const db = new RadarDatabase(join(mkdtempSync(join(tmpdir(), "mpm-")), "retry.sqlite"));
    const source: SourceProvider = { id: "openai", label: "OpenAI", fetchUpdates: async () => [candidate] };
    const failed = await runCollection(db, [source], { analyze: async () => { throw new Error("temporary failure"); } });
    const retried = await runCollection(db, [source], { analyze: async () => analysis });
    expect(failed.publishedCount).toBe(0);
    expect(retried.publishedCount).toBe(1);
    expect(await db.listArticles()).toHaveLength(1);
  });

  it("only returns an article when all requested classifications match", async () => {
    const db = new RadarDatabase(join(mkdtempSync(join(tmpdir(), "mpm-")), "filters.sqlite"));
    const source: SourceProvider = { id: "openai", label: "OpenAI", fetchUpdates: async () => [candidate] };
    await runCollection(db, [source], { analyze: async () => analysis });
    expect(await db.listArticles({ model: "GPT Example", capabilityTag: "context", opportunityTag: "rag" })).toHaveLength(1);
    expect(await db.listArticles({ capabilityTag: "coding" })).toHaveLength(0);
  });

  it("keeps the official tab order when observed timestamps are tied", async () => {
    const db = new RadarDatabase(join(mkdtempSync(join(tmpdir(), "mpm-")), "source-order.sqlite"));
    const newest = makeCandidate({
      provider: "openai", sourceUrl: "https://official.example/gpt-5.6", sourceTitle: "GPT-5.6",
      sourceExcerpt: "GPT Example launched", rawContent: "GPT Example launched with a larger context window.",
      publishedAt: "2026-07-01T12:00:00.000Z", sourceOrder: 0,
    });
    const older = makeCandidate({
      provider: "openai", sourceUrl: "https://official.example/gpt-4.1", sourceTitle: "GPT-4.1",
      sourceExcerpt: "GPT Example launched", rawContent: "GPT Example launched with a larger context window.",
      publishedAt: "2026-07-01T12:00:00.000Z", sourceOrder: 1,
    });
    const source: SourceProvider = { id: "openai", label: "Official", fetchUpdates: async () => [newest, older] };
    await runCollection(db, [source], { analyze: async () => analysis });

    expect((await db.listArticles()).map((article) => article.sourceUrl)).toEqual([newest.sourceUrl, older.sourceUrl]);
  });
});
