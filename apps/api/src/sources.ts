import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import type { ProviderId } from "@mpm/contracts";

export interface ReleaseCandidate {
  provider: ProviderId;
  sourceUrl: string;
  sourceTitle: string;
  sourceExcerpt: string;
  rawContent: string;
  publishedAt: string;
  // The official guidance page lists model tabs from newest to oldest, but
  // does not expose a per-model publication date. Keep that source order as a
  // stable tie-breaker without inventing a publication time.
  sourceOrder?: number;
  fingerprint: string;
}

export interface SourceProvider {
  id: ProviderId;
  label: string;
  displayLabel?: string;
  fetchUpdates(): Promise<ReleaseCandidate[]>;
}

const MODEL_UPDATE_PATTERN = /\b(?:gpt(?:[-\s]?\d+(?:\.\d+)?(?:[-\w.]*)?|[-\s]+[a-z]+(?:[-\d.]+)*)|o\d+(?:[-\w.]*)?|codex(?:[-\w.]*)?|claude[-\s]+(?:opus|sonnet|haiku|[a-z]+\s*\d+)(?:[-\w.]*)?)\b/i;
const KIMI_MODEL_PATTERN = /\b(?:kimi[-\s]?k\d+(?:\.\d+)?(?:[-\s][a-z]+|[-\w.]*)?|k\d+(?:\.\d+)?(?:[-\w.]+)?)\b/i;
const ZHIPU_MODEL_PATTERN = /\bglm-(?:\d+(?:\.\d+)?[a-z0-9.-]*|ocr|image|tts(?:-[\w.]+)?|asr(?:-[\w.]+)?|z\d+(?:-[\w.]+)?)\b/i;
const ALLOWED_SOURCE_HOSTS = new Set([
  "developers.openai.com",
  "help.openai.com",
  "platform.claude.com",
  "platform.kimi.com",
  "docs.bigmodel.cn",
]);

export interface OpenAiModelGuideTab {
  id: string;
  label: string;
}

function normalize(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function elementText($: cheerio.CheerioAPI, element: any): string {
  // Catalog cards use many adjacent elements (`Model ID` + `gpt-5.6-sol`),
  // which Cheerio otherwise concatenates without spaces.
  const copy = $(element).clone();
  copy.find("*").each((_, child) => { $(child).before(" "); });
  return normalize(copy.text());
}

function dateFromText(text: string): string | null {
  const isoMatch = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const date = new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T12:00:00Z`);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }
  const match = text.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/i);
  if (!match) return null;
  const date = new Date(`${match[0]} 12:00:00 UTC`);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function candidateFromReleaseContent(
  provider: ProviderId,
  label: string,
  sourceUrl: string,
  title: string,
  rawContent: string,
): ReleaseCandidate | null {
  const publishedAt = dateFromText(rawContent);
  if (!publishedAt) return null;
  const content = rawContent.slice(0, 12_000);
  return {
    provider,
    sourceUrl,
    sourceTitle: `${label} · ${title}`,
    sourceExcerpt: content.slice(0, 6_000),
    rawContent: content,
    publishedAt,
    fingerprint: fingerprintFor(provider, sourceUrl, content),
  };
}

function assertAllowedSourceUrl(sourceUrl: string): void {
  const host = new URL(sourceUrl).hostname;
  if (!ALLOWED_SOURCE_HOSTS.has(host)) throw new Error(`Unapproved official source host: ${host}`);
}

function fingerprintFor(provider: ProviderId, sourceUrl: string, rawContent: string): string {
  return createHash("sha256").update(`${provider}|${sourceUrl}|${rawContent}`).digest("hex");
}

export function openAiModelGuideTabsFromHtml(html: string): OpenAiModelGuideTab[] {
  const $ = cheerio.load(html);
  const tabs = new Map<string, OpenAiModelGuideTab>();
  for (const button of $("button[data-content-switcher-option][data-value]").toArray()) {
    const id = $(button).attr("data-value")?.trim();
    const label = normalize($(button).text());
    if (id && label) tabs.set(id, { id, label });
  }
  return [...tabs.values()];
}

export function candidatesFromHtml(provider: ProviderId, label: string, sourceUrl: string, html: string): ReleaseCandidate[] {
  const $ = cheerio.load(html);
  // Documentation sites commonly use <header> for each dated release section;
  // removing it would silently discard the date and all model-update content.
  $("script, style, nav, footer").remove();
  const headings = $("h2, h3, h4").toArray();
  const results: ReleaseCandidate[] = [];

  for (const heading of headings) {
    const headingText = normalize($(heading).text());
    // Some documentation generators put the date heading inside a <header>
    // while placing the release bullets immediately after that wrapper.
    const sectionStart = $(heading).closest("header").length ? $(heading).closest("header") : $(heading);
    const text = normalize(sectionStart.nextUntil("h1, h2, h3, h4, header:has(h1, h2, h3, h4)").text());
    const rawContent = `${headingText}\n${text}`.slice(0, 12_000);
    const date = dateFromText(rawContent);
    if (!date || !MODEL_UPDATE_PATTERN.test(rawContent)) continue;
    const fingerprint = fingerprintFor(provider, sourceUrl, rawContent);
    results.push({
      provider,
      sourceUrl,
      sourceTitle: `${label} · ${normalize($(heading).text())}`,
      sourceExcerpt: rawContent.slice(0, 6_000),
      rawContent,
      publishedAt: date,
      fingerprint,
    });
  }

  return results;
}

export interface KimiPlatformModel {
  sourceUrl: string;
  label: string;
}

/**
 * The Kimi API Platform home page lists currently supported models. Discover
 * the guide URLs there rather than hard-coding K3/K2.x model identifiers.
 */
export function kimiPlatformModelsFromHtml(indexUrl: string, html: string): KimiPlatformModel[] {
  const $ = cheerio.load(html);
  $("script, style, nav, footer").remove();
  const models = new Map<string, KimiPlatformModel>();
  for (const link of $("a[href]").toArray()) {
    const text = normalize($(link).text());
    const href = $(link).attr("href")!;
    if (!href.startsWith("/docs/guide/kimi-k")) continue;
    if (!KIMI_MODEL_PATTERN.test(text)) continue;
    const sourceUrl = new URL($(link).attr("href")!, indexUrl).toString();
    assertAllowedSourceUrl(sourceUrl);
    const label = text.match(/Kimi\s+K\d+(?:\.\d+)?(?:\s+Code)?/i)?.[0] ?? text;
    models.set(sourceUrl, { sourceUrl, label });
  }
  return [...models.values()];
}

export function candidateFromKimiPlatformGuide(
  model: KimiPlatformModel,
  html: string,
  collectedAt: string,
  sourceOrder = 0,
): ReleaseCandidate {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer").remove();
  const main = $("main").first().get(0);
  if (!main) throw new Error(`Kimi model guide has no main content: ${model.sourceUrl}`);
  const content = elementText($, main);
  if (content.length < 80) throw new Error(`Kimi model guide has insufficient content: ${model.sourceUrl}`);
  const rawContent = `Kimi API Platform\nModel: ${model.label}\n${content}`.slice(0, 12_000);
  return {
    provider: "kimi",
    sourceUrl: model.sourceUrl,
    sourceTitle: `Kimi API Platform · ${model.label}`,
    sourceExcerpt: rawContent.slice(0, 6_000),
    rawContent,
    // The platform catalog has no per-model release timestamp. Record when
    // MPM first observed this official guide, as with OpenAI Model Guidance.
    publishedAt: collectedAt,
    sourceOrder,
    fingerprint: fingerprintFor("kimi", model.sourceUrl, rawContent),
  };
}

/**
 * 智谱的更新页使用 update-container cards rather than heading sections. The
 * card's title and body are kept together so a dated model launch remains one
 * release, while plans and other non-model products are ignored.
 */
export function candidatesFromZhipuNewReleasesHtml(sourceUrl: string, html: string): ReleaseCandidate[] {
  const $ = cheerio.load(html);
  $("script, style, nav, footer").remove();
  const results: ReleaseCandidate[] = [];

  for (const card of $(".update-container").toArray()) {
    const date = normalize($(card).find('[data-component-part="update-label"]').first().text());
    const title = normalize($(card).find('[data-component-part="update-description"]').first().text());
    const body = normalize($(card).find('[data-component-part="update-content"]').first().text());
    const rawContent = `${date}\n${title}\n${body}`;
    if (!ZHIPU_MODEL_PATTERN.test(rawContent)) continue;
    const candidate = candidateFromReleaseContent("zhipu", "智谱 GLM 新品发布", sourceUrl, title || date, rawContent);
    if (candidate) results.push(candidate);
  }

  return results;
}

export function candidateFromOpenAiModelGuide(
  model: string,
  label: string,
  sourceUrl: string,
  html: string,
  collectedAt: string,
  sourceOrder = 0,
): ReleaseCandidate {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer").remove();
  const main = $("main").first().get(0);
  if (!main) throw new Error(`OpenAI model guide has no main content: ${sourceUrl}`);
  const guideContent = elementText($, main);
  if (guideContent.length < 80) throw new Error(`OpenAI model guide has insufficient content: ${sourceUrl}`);
  const rawContent = `OpenAI Model Guidance\nModel: ${label} (${model})\n${guideContent}`.slice(0, 12_000);
  return {
    provider: "openai",
    sourceUrl,
    sourceTitle: `OpenAI Model Guidance · ${label}`,
    sourceExcerpt: rawContent.slice(0, 6_000),
    rawContent,
    // This guide has no per-section release timestamp. The date records when
    // MPM first observed this official guide revision.
    publishedAt: collectedAt,
    sourceOrder,
    fingerprint: fingerprintFor("openai", sourceUrl, rawContent),
  };
}

async function mapWithConcurrency<T, R>(items: T[], maximum: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(maximum, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

export class OpenAiModelGuidanceProvider implements SourceProvider {
  readonly id = "openai" as const;
  readonly label = "OpenAI Model Guidance";
  readonly displayLabel = "OpenAI";
  readonly sourceUrl = "https://developers.openai.com/api/docs/guides/latest-model";

  constructor() {
    assertAllowedSourceUrl(this.sourceUrl);
  }

  async fetchUpdates(): Promise<ReleaseCandidate[]> {
    const indexResponse = await fetch(this.sourceUrl, {
      headers: {
        "User-Agent": "MPM/0.1 (+local development; official model-guidance monitor)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!indexResponse.ok) throw new Error(`${this.label} source returned HTTP ${indexResponse.status}`);
    const models = openAiModelGuideTabsFromHtml(await indexResponse.text());
    if (models.length === 0) throw new Error(`${this.label} page exposed no model tabs`);
    const collectedAt = new Date().toISOString();
    return mapWithConcurrency(models, 4, async (model, sourceOrder) => {
      const sourceUrl = `${this.sourceUrl}?model=${encodeURIComponent(model.id)}`;
      const response = await fetch(sourceUrl, {
        headers: {
          "User-Agent": "MPM/0.1 (+local development; official model-guidance monitor)",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (!response.ok) throw new Error(`${this.label} ${model.label} returned HTTP ${response.status}`);
      return candidateFromOpenAiModelGuide(model.id, model.label, sourceUrl, await response.text(), collectedAt, sourceOrder);
    });
  }
}

export class HtmlReleaseNotesProvider implements SourceProvider {
  constructor(
    readonly id: ProviderId,
    readonly label: string,
    readonly sourceUrl: string,
    private readonly maxItems = 3,
    readonly displayLabel = label,
  ) {
    assertAllowedSourceUrl(sourceUrl);
  }

  async fetchUpdates(): Promise<ReleaseCandidate[]> {
    const response = await fetch(this.sourceUrl, {
      headers: {
        "User-Agent": "MPM/0.1 (+local development; official release-note monitor)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!response.ok) throw new Error(`${this.label} source returned HTTP ${response.status}`);
    const html = await response.text();
    const releases = candidatesFromHtml(this.id, this.label, this.sourceUrl, html);
    if (releases.length === 0) throw new Error(`${this.label} parser found no model-release sections`);
    return releases.slice(0, this.maxItems);
  }
}

export class KimiPlatformProvider implements SourceProvider {
  readonly id = "kimi" as const;
  readonly label = "Kimi API Platform";
  readonly displayLabel = "Kimi";
  readonly sourceUrl = "https://platform.kimi.com/";

  constructor(private readonly maxItems = 3) {
    assertAllowedSourceUrl(this.sourceUrl);
  }

  async fetchUpdates(): Promise<ReleaseCandidate[]> {
    const indexResponse = await fetch(this.sourceUrl, {
      headers: { "User-Agent": "MPM/0.1 (+official Kimi model-platform monitor)", Accept: "text/html,application/xhtml+xml" },
    });
    if (!indexResponse.ok) throw new Error(`${this.label} source returned HTTP ${indexResponse.status}`);
    const models = kimiPlatformModelsFromHtml(this.sourceUrl, await indexResponse.text()).slice(0, this.maxItems);
    if (models.length === 0) throw new Error(`${this.label} page exposed no current model guides`);
    const collectedAt = new Date().toISOString();
    return mapWithConcurrency(models, 3, async (model, sourceOrder) => {
      const response = await fetch(model.sourceUrl, {
        headers: { "User-Agent": "MPM/0.1 (+official Kimi model-platform monitor)", Accept: "text/html,application/xhtml+xml" },
      });
      if (!response.ok) throw new Error(`${this.label} ${model.label} returned HTTP ${response.status}`);
      return candidateFromKimiPlatformGuide(model, await response.text(), collectedAt, sourceOrder);
    });
  }
}

export class ZhipuNewReleasesProvider implements SourceProvider {
  readonly id = "zhipu" as const;
  readonly label = "智谱 GLM 新品发布";
  readonly displayLabel = "智谱 GLM";
  readonly sourceUrl = "https://docs.bigmodel.cn/cn/update/new-releases";

  constructor(private readonly maxItems = 3) {
    assertAllowedSourceUrl(this.sourceUrl);
  }

  async fetchUpdates(): Promise<ReleaseCandidate[]> {
    const response = await fetch(this.sourceUrl, {
      headers: { "User-Agent": "MPM/0.1 (+official Zhipu model-release monitor)", Accept: "text/html,application/xhtml+xml" },
    });
    if (!response.ok) throw new Error(`${this.label} source returned HTTP ${response.status}`);
    const releases = candidatesFromZhipuNewReleasesHtml(this.sourceUrl, await response.text());
    if (releases.length === 0) throw new Error(`${this.label} parser found no model-release cards`);
    return releases.slice(0, this.maxItems);
  }
}

export function defaultSources(): SourceProvider[] {
  return [
    new OpenAiModelGuidanceProvider(),
    new HtmlReleaseNotesProvider("anthropic", "Anthropic Platform Release Notes", "https://platform.claude.com/docs/en/release-notes/overview", 3, "Anthropic"),
    new KimiPlatformProvider(),
    new ZhipuNewReleasesProvider(),
  ];
}

export function makeCandidate(input: Omit<ReleaseCandidate, "fingerprint">): ReleaseCandidate {
  return {
    ...input,
    fingerprint: fingerprintFor(input.provider, input.sourceUrl, input.rawContent),
  };
}
