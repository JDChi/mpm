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

/**
 * OpenAI's model catalog already separates each model into a dedicated card.
 * We use the official model ID as the unit of collection instead of guessing
 * which model a general changelog sentence might be referring to.
 */
export function candidatesFromOpenAiModelCatalog(catalogUrl: string, html: string, collectedAt: string): ReleaseCandidate[] {
  const $ = cheerio.load(html);
  $("script, style, nav, footer").remove();
  const entries = new Map<string, ReleaseCandidate>();

  for (const anchor of $("a").toArray()) {
    const href = $(anchor).attr("href");
    if (!href || !/^\/api\/docs\/models\/[a-z0-9.-]+$/i.test(href)) continue;

    const sourceUrl = new URL(href, catalogUrl).toString();
    const modelId = href.split("/").at(-1)!;
    const linkText = elementText($, anchor);
    const parentText = elementText($, $(anchor).parent().get(0)!);
    const parentHasOwnModelId = parentText.replace(/\s+/g, "").toLowerCase().includes(`modelid${modelId}`);
    const cardText = parentHasOwnModelId ? parentText : linkText;
    if (!cardText) continue;
    const rawContent = `OpenAI Model Catalog\nModel ID: ${modelId}\n${cardText}`.slice(0, 12_000);
    const candidate: ReleaseCandidate = {
      provider: "openai",
      sourceUrl,
      sourceTitle: `OpenAI Model Catalog · ${modelId}`,
      sourceExcerpt: rawContent.slice(0, 6_000),
      rawContent,
      // The catalog does not expose an official release date per card. This is
      // the time MPM first observed this official catalog snapshot.
      publishedAt: collectedAt,
      fingerprint: fingerprintFor("openai", sourceUrl, rawContent),
    };
    const previous = entries.get(sourceUrl);
    // The same model can appear in introductory copy and in its full card.
    // Keep the richer occurrence while preserving catalog order.
    if (!previous || candidate.rawContent.length > previous.rawContent.length) entries.set(sourceUrl, candidate);
  }

  return [...entries.values()];
}

export class OpenAiModelCatalogProvider implements SourceProvider {
  readonly id = "openai" as const;
  readonly label = "OpenAI Model Catalog";
  readonly sourceUrl = "https://developers.openai.com/api/docs/models";

  constructor(private readonly maxItems = 3) {
    assertAllowedSourceUrl(this.sourceUrl);
  }

  async fetchUpdates(): Promise<ReleaseCandidate[]> {
    const response = await fetch(this.sourceUrl, {
      headers: {
        "User-Agent": "MPM/0.1 (+local development; official release-note monitor)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!response.ok) throw new Error(`${this.label} source returned HTTP ${response.status}`);
    const releases = candidatesFromOpenAiModelCatalog(this.sourceUrl, await response.text(), new Date().toISOString());
    if (releases.length === 0) throw new Error(`${this.label} parser found no model cards`);
    return releases.slice(0, this.maxItems);
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
    new OpenAiModelCatalogProvider(),
    new HtmlReleaseNotesProvider("anthropic", "Anthropic Platform Release Notes", "https://platform.claude.com/docs/en/release-notes/overview"),
  ];
}

export function makeCandidate(input: Omit<ReleaseCandidate, "fingerprint">): ReleaseCandidate {
  return {
    ...input,
    fingerprint: fingerprintFor(input.provider, input.sourceUrl, input.rawContent),
  };
}
