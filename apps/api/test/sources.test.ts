import { describe, expect, it } from "vitest";
import { HtmlReleaseNotesProvider, candidateFromOpenAiModelGuide, candidatesFromHtml, openAiModelGuideTabsFromHtml } from "../src/sources.js";

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

  it("discovers the official Model guidance tabs instead of hard-coding model names", () => {
    const tabs = openAiModelGuideTabsFromHtml(`
      <button data-content-switcher-option data-value="gpt-5.6">GPT-5.6</button>
      <button data-content-switcher-option data-value="gpt-5.3-codex">GPT-5.3 Codex</button>
      <button data-content-switcher-option data-value="gpt-4.1">GPT-4.1</button>
    `);
    expect(tabs.map((tab) => tab.id)).toEqual([
      "gpt-5.6", "gpt-5.3-codex", "gpt-4.1",
    ]);
  });

  it("uses the official guide content for an explicitly selected model", () => {
    const collectedAt = "2026-07-23T08:00:00.000Z";
    const candidate = candidateFromOpenAiModelGuide("gpt-5.5", "GPT-5.5", "https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5", `
      <main><h1>Model guidance</h1><h2>Using GPT-5.5</h2><h2>What's new</h2><p>More efficient reasoning and stronger tool use.</p></main>
    `, collectedAt, 2);

    expect(candidate).toMatchObject({
      sourceUrl: "https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5",
      sourceTitle: "OpenAI Model Guidance · GPT-5.5",
      publishedAt: collectedAt,
      sourceOrder: 2,
    });
    expect(candidate.rawContent).toContain("What's new");
    expect(candidate.rawContent).not.toContain("GPT-4o mini TTS");
  });

  it("rejects a source outside the official allowlist", () => {
    expect(() => new HtmlReleaseNotesProvider("openai", "Third party", "https://example.com/models")).toThrow("Unapproved official source host");
  });

});
