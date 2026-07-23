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
  fingerprint: string;
}

export interface SourceProvider {
  id: ProviderId;
  label: string;
  fetchUpdates(): Promise<ReleaseCandidate[]>;
}

const MODEL_UPDATE_PATTERN = /\b(?:gpt(?:[-\s]?\d+(?:\.\d+)?(?:[-\w.]*)?|[-\s]+[a-z]+(?:[-\d.]+)*)|o\d+(?:[-\w.]*)?|codex(?:[-\w.]*)?|claude[-\s]+(?:opus|sonnet|haiku|[a-z]+\s*\d+)(?:[-\w.]*)?)\b/i;
const ALLOWED_SOURCE_HOSTS = new Set(["developers.openai.com", "help.openai.com", "platform.claude.com"]);

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
  const match = text.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/i);
  if (!match) return null;
  const date = new Date(`${match[0]} 12:00:00 UTC`);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
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

export function candidateFromOpenAiModelGuide(
  model: string,
  label: string,
  sourceUrl: string,
  html: string,
  collectedAt: string,
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
    fingerprint: fingerprintFor("openai", sourceUrl, rawContent),
  };
}

async function mapWithConcurrency<T, R>(items: T[], maximum: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(maximum, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

export class OpenAiModelGuidanceProvider implements SourceProvider {
  readonly id = "openai" as const;
  readonly label = "OpenAI Model Guidance";
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
    return mapWithConcurrency(models, 4, async (model) => {
      const sourceUrl = `${this.sourceUrl}?model=${encodeURIComponent(model.id)}`;
      const response = await fetch(sourceUrl, {
        headers: {
          "User-Agent": "MPM/0.1 (+local development; official model-guidance monitor)",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (!response.ok) throw new Error(`${this.label} ${model.label} returned HTTP ${response.status}`);
      return candidateFromOpenAiModelGuide(model.id, model.label, sourceUrl, await response.text(), collectedAt);
    });
  }
}

export class HtmlReleaseNotesProvider implements SourceProvider {
  constructor(
    readonly id: ProviderId,
    readonly label: string,
    readonly sourceUrl: string,
    private readonly maxItems = 3,
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

export function defaultSources(): SourceProvider[] {
  return [
    new OpenAiModelGuidanceProvider(),
    new HtmlReleaseNotesProvider("anthropic", "Anthropic Platform Release Notes", "https://platform.claude.com/docs/en/release-notes/overview"),
  ];
}

export function makeCandidate(input: Omit<ReleaseCandidate, "fingerprint">): ReleaseCandidate {
  return {
    ...input,
    fingerprint: fingerprintFor(input.provider, input.sourceUrl, input.rawContent),
  };
}
