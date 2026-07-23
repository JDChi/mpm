import { describe, expect, it } from "vitest";
import { HtmlReleaseNotesProvider, candidatesFromHtml, candidatesFromOpenAiModelCatalog } from "../src/sources.js";

describe("official model sources", () => {
  it("only emits dated sections that name a model or version", () => {
    const candidates = candidatesFromHtml("openai", "OpenAI", "https://help.openai.com/en/articles/9624314-model-release-notes", `
      <main>
        <h2>May 28, 2026</h2><p>GPT-5.6 improves tool calling and reasoning.</p>
        <h2>May 27, 2026</h2><p>ChatGPT desktop navigation is easier to use.</p>
      </main>
    `);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.rawContent).toContain("GPT-5.6");
  });

  it("keeps model updates when a documentation site wraps a release in header markup", () => {
    const candidates = candidatesFromHtml("anthropic", "Anthropic", "https://platform.claude.com/docs/en/release-notes/overview", `
      <article><header><h3><div>July 15, 2026</div></h3></header><ul><li>Claude Opus 4.8 supports a new system-message capability.</li></ul></article>
    `);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.rawContent).toContain("Claude Opus 4.8");
  });

  it("uses each explicit model card from OpenAI's official model catalog", () => {
    const collectedAt = "2026-07-23T08:00:00.000Z";
    const candidates = candidatesFromOpenAiModelCatalog("https://developers.openai.com/api/docs/models", `
      <main>
        <p><a href="/api/docs/models/gpt-5.6-sol">GPT-5.6 Sol</a></p>
        <a href="/api/docs/models/gpt-5.6-sol">GPT-5.6 Sol Frontier model Model ID gpt-5.6-sol Context window 1.05M Tools Functions, Computer use</a>
        <a href="/api/docs/models/gpt-realtime-2.1">GPT-Realtime-2.1 Reasoning model with tool use</a>
        <a href="https://example.com/gpt-5.6">Third-party copy</a>
      </main>
    `, collectedAt);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
      sourceTitle: "OpenAI Model Catalog · gpt-5.6-sol",
      publishedAt: collectedAt,
    });
    expect(candidates[0]?.rawContent).toContain("Context window 1.05M");
  });

  it("rejects a source outside the official allowlist", () => {
    expect(() => new HtmlReleaseNotesProvider("openai", "Third party", "https://example.com/models")).toThrow("Unapproved official source host");
  });

});
