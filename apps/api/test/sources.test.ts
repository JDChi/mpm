import { describe, expect, it } from "vitest";
import {
  HtmlReleaseNotesProvider,
  candidateFromKimiPlatformGuide,
  candidateFromOpenAiModelGuide,
  candidatesFromHtml,
  candidatesFromZhipuNewReleasesHtml,
  defaultSources,
  kimiPlatformModelsFromHtml,
  openAiModelGuideTabsFromHtml,
} from "../src/sources.js";

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

  it("discovers current Kimi model guides from the official platform, including K3", () => {
    const models = kimiPlatformModelsFromHtml("https://platform.kimi.com/", `
      <main>
        <a href="/docs/guide/kimi-k3-quickstart">K3 Kimi K3 是旗舰模型</a>
        <a href="/docs/guide/kimi-k2-7-code-quickstart">K2.7 Code Kimi K2.7 Code 是编程模型</a>
        <a href="/docs/guide/kimi-k2-6-quickstart">K2.6 Kimi K2.6 是通用模型</a>
        <a href="/docs/guide/quickstart">使用手册</a>
      </main>
    `);

    expect(models.map((model) => model.label)).toEqual(["Kimi K3", "Kimi K2.7 Code", "Kimi K2.6"]);
    const candidate = candidateFromKimiPlatformGuide(models[0]!, `<main><h1>Kimi K3</h1><p>支持 1M 上下文、原生视觉与长程编程任务，可在大型代码库、知识工作和复杂推理场景中持续执行任务。</p><p>支持推理强度、工具调用与结构化输出，并通过上下文缓存降低长对话成本。</p></main>`, "2026-07-24T08:00:00.000Z", 0);
    expect(candidate).toMatchObject({ provider: "kimi", sourceTitle: "Kimi API Platform · Kimi K3", sourceOrder: 0 });
    expect(candidate.rawContent).toContain("1M 上下文");
  });

  it("keeps only 智谱 model update cards and parses ISO dates", () => {
    const candidates = candidatesFromZhipuNewReleasesHtml("https://docs.bigmodel.cn/cn/update/new-releases", `
      <main>
        <div class="update-container"><button data-component-part="update-label">2026-06-16</button><div data-component-part="update-description">GLM-5.2 新一代旗舰模型上线</div><div data-component-part="update-content"><strong>GLM-5.2</strong><ul><li>支持 1M 上下文</li></ul></div></div>
        <div class="update-container"><button data-component-part="update-label">2026-05-29</button><div data-component-part="update-description">GLM Coding Plan 团队版上线</div><div data-component-part="update-content"><p>团队订阅与预算管理</p></div></div>
      </main>
    `);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ provider: "zhipu", publishedAt: "2026-06-16T12:00:00.000Z" });
    expect(candidates[0]?.sourceTitle).toContain("GLM-5.2");
  });

  it("registers the four official model providers", () => {
    expect(defaultSources().map((source) => source.id)).toEqual(["openai", "anthropic", "kimi", "zhipu"]);
  });

});
