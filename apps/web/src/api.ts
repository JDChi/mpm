import type { ArticleDetail, ArticleSummary, RunSummary } from "@mpm/contracts";

const base = import.meta.env.VITE_API_BASE ?? (import.meta.env.PROD ? "/api" : "http://localhost:8787/api");

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export interface ArticleFilters {
  provider?: string;
  model?: string;
  capabilityTag?: string;
  opportunityTag?: string;
}

export function listArticles(filters: ArticleFilters = {}): Promise<ArticleSummary[]> {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => Boolean(value)) as [string, string][]);
  return request(`/articles${query.size ? `?${query}` : ""}`);
}

export function getArticle(slug: string): Promise<ArticleDetail> {
  return request(`/articles/${encodeURIComponent(slug)}`);
}

export function listRuns(token: string): Promise<RunSummary[]> {
  return request("/admin/runs", { headers: { Authorization: `Bearer ${token}` } });
}

export function startRun(token: string): Promise<RunSummary> {
  return request("/admin/runs", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
}
