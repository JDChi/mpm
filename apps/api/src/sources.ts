import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import type { ProviderId } from "@model-radar/contracts";

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

const MODEL_UPDATE_PATTERN = /\b(?:gpt[-\s]?\d+(?:\.\d+)?(?:[-\w.]*)?|o\d+(?:[-\w.]*)?|codex(?:[-\w.]*)?|claude[-\s]+(?:opus|sonnet|haiku|[a-z]+\s*\d+)(?:[-\w.]*)?)\b/i;
const ALLOWED_SOURCE_HOSTS = new Set(["help.openai.com", "platform.claude.com"]);

function normalize(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function dateFromText(text: string): string | null {
  const match = text.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/i);
  if (!match) return null;
  const date = new Date(`${match[0]} 12:00:00 UTC`);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
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
    const fingerprint = createHash("sha256").update(`${provider}|${sourceUrl}|${rawContent}`).digest("hex");
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

export class HtmlReleaseNotesProvider implements SourceProvider {
  constructor(
    readonly id: ProviderId,
    readonly label: string,
    readonly sourceUrl: string,
    private readonly maxItems = 3,
  ) {
    const host = new URL(sourceUrl).hostname;
    if (!ALLOWED_SOURCE_HOSTS.has(host)) throw new Error(`Unapproved official source host: ${host}`);
  }

  async fetchUpdates(): Promise<ReleaseCandidate[]> {
    const response = await fetch(this.sourceUrl, {
      headers: {
        "User-Agent": "ModelRadar/0.1 (+local development; official release-note monitor)",
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
    new HtmlReleaseNotesProvider("openai", "OpenAI Model Release Notes", "https://help.openai.com/en/articles/9624314-model-release-notes"),
    new HtmlReleaseNotesProvider("anthropic", "Anthropic Platform Release Notes", "https://platform.claude.com/docs/en/release-notes/overview"),
  ];
}

export function makeCandidate(input: Omit<ReleaseCandidate, "fingerprint">): ReleaseCandidate {
  return {
    ...input,
    fingerprint: createHash("sha256").update(`${input.provider}|${input.sourceUrl}|${input.rawContent}`).digest("hex"),
  };
}
