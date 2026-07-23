import type {
  AnalysisResult,
  ArticleDetail,
  ArticleSummary,
  RunSummary,
} from "@mpm/contracts";
import type { ReleaseCandidate } from "./sources.js";

export type ReleaseStatus = "pending" | "analyzing" | "published" | "retryable_failed";

export interface StoredRelease extends ReleaseCandidate {
  id: number;
  status: ReleaseStatus;
  analysisAttempts: number;
  lastAnalysisError: string | null;
}

export interface ArticleFilters {
  provider?: string;
  model?: string;
  capabilityTag?: string;
  opportunityTag?: string;
}

export interface ReleaseRepository {
  startRun(): Promise<number>;
  finishRun(id: number, result: Omit<RunSummary, "id" | "startedAt" | "finishedAt">): Promise<void>;
  listRuns(): Promise<RunSummary[]>;
  insertRelease(candidate: ReleaseCandidate): Promise<number | null>;
  syncReleaseSourceOrder(candidate: ReleaseCandidate): Promise<void>;
  claimNextRelease(excludedIds?: number[]): Promise<StoredRelease | null>;
  getRelease(id: number): Promise<StoredRelease | null>;
  markReleaseRetryableFailed(id: number, error: string): Promise<void>;
  publishArticle(release: StoredRelease, analysis: AnalysisResult): Promise<ArticleDetail>;
  listArticles(filters?: ArticleFilters): Promise<ArticleSummary[]>;
  getArticle(slug: string): Promise<ArticleDetail | null>;
}
