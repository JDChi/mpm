import type { Analyzer } from "./analyzer.js";
import type { ReleaseRepository } from "./repository.js";
import type { SourceProvider } from "./sources.js";
import type { RunSummary } from "@mpm/contracts";

export interface CollectionOptions {
  /** Limits both collection and analysis to one configured provider. */
  provider?: string;
}

export async function runCollection(
  database: ReleaseRepository,
  sources: SourceProvider[],
  analyzer: Analyzer,
  options: CollectionOptions = {},
): Promise<RunSummary> {
  const id = await database.startRun();
  let discoveredCount = 0;
  let publishedCount = 0;
  const errors: string[] = [];

  for (const source of sources.filter((source) => !options.provider || source.id === options.provider)) {
    try {
      const candidates = await source.fetchUpdates();
      discoveredCount += candidates.length;
      for (const candidate of candidates) {
        await database.insertRelease(candidate);
        await database.syncReleaseSourceOrder(candidate);
      }
    } catch (error) {
      errors.push(`${source.label}: fetch failed — ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  const attemptedReleaseIds = new Set<number>();
  for (;;) {
    const release = await database.claimNextRelease([...attemptedReleaseIds], options.provider);
    if (!release) break;
    attemptedReleaseIds.add(release.id);
    try {
      const analysis = await analyzer.analyze(release.id);
      await database.publishArticle(release, analysis);
      publishedCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      await database.markReleaseRetryableFailed(release.id, message);
      errors.push(`release #${release.id}: analysis failed — ${message}`);
    }
  }

  const result = {
    status: errors.length ? "failed" as const : "succeeded" as const,
    discoveredCount,
    publishedCount,
    error: errors.length ? errors.join("\n").slice(0, 3_000) : null,
  };
  await database.finishRun(id, result);
  return (await database.listRuns()).find((run) => run.id === id)!;
}
