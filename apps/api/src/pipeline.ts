import type { Analyzer } from "./analyzer.js";
import type { RadarDatabase } from "./db.js";
import type { SourceProvider } from "./sources.js";
import type { RunSummary } from "@mpm/contracts";

export async function runCollection(
  database: RadarDatabase,
  sources: SourceProvider[],
  analyzer: Analyzer,
): Promise<RunSummary> {
  const id = database.startRun();
  let discoveredCount = 0;
  let publishedCount = 0;
  const errors: string[] = [];

  for (const source of sources) {
    try {
      const candidates = await source.fetchUpdates();
      discoveredCount += candidates.length;
      for (const candidate of candidates) database.insertRelease(candidate);
    } catch (error) {
      errors.push(`${source.label}: fetch failed — ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  const attemptedReleaseIds = new Set<number>();
  for (;;) {
    const release = database.claimNextRelease([...attemptedReleaseIds]);
    if (!release) break;
    attemptedReleaseIds.add(release.id);
    try {
      const analysis = await analyzer.analyze(release.id);
      database.publishArticle(release, analysis);
      publishedCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      database.markReleaseRetryableFailed(release.id, message);
      errors.push(`release #${release.id}: analysis failed — ${message}`);
    }
  }

  const result = {
    status: errors.length ? "failed" as const : "succeeded" as const,
    discoveredCount,
    publishedCount,
    error: errors.length ? errors.join("\n").slice(0, 3_000) : null,
  };
  database.finishRun(id, result);
  return database.listRuns().find((run) => run.id === id)!;
}
