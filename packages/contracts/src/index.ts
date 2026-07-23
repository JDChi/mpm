export type ProviderId = "openai" | "anthropic" | string;

export const CAPABILITY_TAGS = ["reasoning", "tool_use", "context", "multimodal", "coding", "speed_cost", "reliability", "safety"] as const;
export type CapabilityTag = (typeof CAPABILITY_TAGS)[number];

export const OPPORTUNITY_TAGS = ["agent", "rag", "developer_tools", "automation", "customer_support", "content_creation", "data_analysis"] as const;
export type OpportunityTag = (typeof OPPORTUNITY_TAGS)[number];

export const RELEASE_KINDS = ["new_model", "model_update", "model_capability", "model_deprecation"] as const;
export type ReleaseKind = (typeof RELEASE_KINDS)[number];

export interface PotentialFeature {
  name: string;
  scenario: string;
  rationale: string;
  prerequisites: string[];
  confidence: "high" | "medium" | "low";
}

export interface AnalysisResult {
  title: string;
  summary: string;
  models: string[];
  releaseKind: ReleaseKind;
  capabilityTags: CapabilityTag[];
  opportunityTags: OpportunityTag[];
  keyChanges: string[];
  potentialFeatures: PotentialFeature[];
  caveats: string[];
}

export interface ArticleSummary {
  slug: string;
  title: string;
  provider: ProviderId;
  publishedAt: string;
  collectedAt: string;
  summary: string;
  sourceUrl: string;
  models: string[];
  releaseKind: ReleaseKind;
  capabilityTags: CapabilityTag[];
  opportunityTags: OpportunityTag[];
}

export interface ArticleDetail extends ArticleSummary {
  sourceTitle: string;
  sourceExcerpt: string;
  analysis: AnalysisResult;
}

export interface RunSummary {
  id: number;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  discoveredCount: number;
  publishedCount: number;
  error: string | null;
}
