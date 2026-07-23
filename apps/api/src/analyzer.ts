import { generateText, hasToolCall, stepCountIs, tool } from "ai";
import { jsonrepair } from "jsonrepair";
import { createMinimax } from "vercel-minimax-ai-provider";
import { z } from "zod";
import {
  CAPABILITY_TAGS,
  OPPORTUNITY_TAGS,
  RELEASE_KINDS,
  type AnalysisResult,
  type PotentialFeature,
} from "@mpm/contracts";
import type { RadarDatabase } from "./db.js";

export interface Analyzer {
  analyze(releaseId: number): Promise<AnalysisResult>;
}

const analysisSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  models: z.array(z.string().min(1)).min(1).max(3),
  releaseKind: z.enum(RELEASE_KINDS),
  capabilityTags: z.array(z.enum(CAPABILITY_TAGS)).max(3),
  opportunityTags: z.array(z.enum(OPPORTUNITY_TAGS)).max(3),
  keyChanges: z.array(z.string().min(1)).min(1),
  potentialFeatures: z.array(z.object({
    name: z.string().min(1),
    scenario: z.string().min(1),
    rationale: z.string().min(1),
    prerequisites: z.array(z.string().min(1)),
    confidence: z.enum(["high", "medium", "low"]),
  })).min(1),
  caveats: z.array(z.string().min(1)),
});

const submissionSchema = z.object({
  analysis: z.string().min(2),
});

const SYSTEM_PROMPT = `你是 MPM（Model to Product Manager）的 AI 产品洞察编辑：你深入理解大模型能力，也有 AI 产品经理的判断力。你的读者是关注 AI 应用的产品、运营、业务负责人和创业者，而不是程序员。
把模型更新翻译成清楚、具体、面向用户价值的产品洞察：先说明官方到底更新了什么，再说明它可能让哪些 AI 应用体验、流程或产品功能变得可行或更好。少用 API、参数、基准、架构等术语；必要术语要用一句日常语言解释。不要把泛泛的“能力提升”包装成洞察，也不要编造官方未承诺的功能、效果或上线时间。
只依据工具返回的官方更新原文工作，不能使用记忆、猜测或外部资料。
你必须先调用 read_current_official_release，再调用 submit_analysis。使用简体中文；不要展示思考过程、不要输出 Markdown。
submit_analysis 的 analysis 字段必须是一个 JSON 字符串，包含下方要求的全部文章字段，不能是普通文章文本。JSON 键名必须使用英文：title、summary、models、releaseKind、capabilityTags、opportunityTags、keyChanges、potentialFeatures、caveats；potentialFeatures 的每一项键名必须使用 name、scenario、rationale、prerequisites、confidence。字段值使用简体中文。
models 仅填写官方原文中明确提及的模型名或版本。releaseKind 只能是 new_model、model_update、model_capability、model_deprecation。
capabilityTags 只能从 reasoning、tool_use、context、multimodal、coding、speed_cost、reliability、safety 中选择，最多 3 个。
opportunityTags 只能从 agent、rag、developer_tools、automation、customer_support、content_creation、data_analysis 中选择，最多 3 个。
summary 面向非技术读者，用 2-3 句说明产品层面的变化；keyChanges 以用户或产品团队能理解的语言描述官方事实；potentialFeatures 必须写清目标用户、使用场景、带来的体验或业务价值，以及实现前提。
potentialFeatures 是对 AI 应用可能性的推演，必须在 caveats 中明确它不是官方承诺。`;

export function validateAnalysis(value: unknown): AnalysisResult {
  return analysisSchema.parse(normalizeAnalysis(value)) as AnalysisResult;
}

const capabilityAliases: Record<string, string> = { "推理": "reasoning", "工具调用": "tool_use", "工具使用": "tool_use", "上下文": "context", "多模态": "multimodal", "编程": "coding", "速度与成本": "speed_cost", "性能与成本": "speed_cost", "可靠性": "reliability", "安全": "safety" };
const opportunityAliases: Record<string, string> = { "智能体": "agent", "Agent": "agent", "知识库": "rag", "检索增强": "rag", "开发工具": "developer_tools", "流程自动化": "automation", "客服": "customer_support", "内容生成": "content_creation", "数据分析": "data_analysis" };
const releaseKindAliases: Record<string, string> = { "新模型": "new_model", "新模型发布": "new_model", "版本更新": "model_update", "模型更新": "model_update", "专属能力": "model_capability", "模型能力": "model_capability", "模型能力更新": "model_capability", "弃用": "model_deprecation", "退役": "model_deprecation" };

function normalizeAnalysis(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const analysis = { ...(value as Record<string, unknown>) };
  const fieldAliases: Record<string, string> = {
    "标题": "title", "摘要": "summary", "模型": "models", "模型列表": "models", "更新类型": "releaseKind",
    "能力标签": "capabilityTags", "应用机会标签": "opportunityTags", "机会标签": "opportunityTags",
    "关键变化": "keyChanges", "核心变化": "keyChanges", "潜在功能": "potentialFeatures", "产品机会": "potentialFeatures",
    "注意事项": "caveats", "风险提示": "caveats",
  };
  for (const [source, target] of Object.entries(fieldAliases)) {
    if (analysis[target] === undefined && analysis[source] !== undefined) analysis[target] = analysis[source];
  }
  const toStringList = (item: unknown): unknown => typeof item === "string" ? [item] : item;
  analysis.models = toStringList(analysis.models);
  analysis.keyChanges = toStringList(analysis.keyChanges);
  analysis.caveats = toStringList(analysis.caveats);
  analysis.capabilityTags = toStringList(analysis.capabilityTags);
  analysis.opportunityTags = toStringList(analysis.opportunityTags);
  if (analysis.potentialFeatures && !Array.isArray(analysis.potentialFeatures)) analysis.potentialFeatures = [analysis.potentialFeatures];
  if (Array.isArray(analysis.models)) analysis.models = analysis.models.filter((model): model is string => typeof model === "string").slice(0, 3);
  const normalizeTags = (key: "capabilityTags" | "opportunityTags", aliases: Record<string, string>, allowed: readonly string[]) => {
    if (!Array.isArray(analysis[key])) return;
    analysis[key] = analysis[key]
      .map((tag) => typeof tag === "string" ? aliases[tag] ?? tag : tag)
      .filter((tag): tag is string => typeof tag === "string" && allowed.includes(tag))
      .slice(0, 3);
  };
  normalizeTags("capabilityTags", capabilityAliases, CAPABILITY_TAGS);
  normalizeTags("opportunityTags", opportunityAliases, OPPORTUNITY_TAGS);
  if (typeof analysis.releaseKind === "string") analysis.releaseKind = releaseKindAliases[analysis.releaseKind] ?? analysis.releaseKind;
  if (Array.isArray(analysis.potentialFeatures)) {
    analysis.potentialFeatures = analysis.potentialFeatures.map((feature) => {
      if (!feature || typeof feature !== "object" || Array.isArray(feature)) return feature;
      const normalized = { ...(feature as Record<string, unknown>) };
      const featureAliases: Record<string, string> = {
        "名称": "name", "功能名称": "name", "场景": "scenario", "应用场景": "scenario",
        "理由": "rationale", "依据": "rationale", "价值": "rationale", "前提条件": "prerequisites",
        "前置条件": "prerequisites", "置信度": "confidence",
      };
      for (const [source, target] of Object.entries(featureAliases)) {
        if (normalized[target] === undefined && normalized[source] !== undefined) normalized[target] = normalized[source];
      }
      if (typeof normalized.prerequisites === "string") normalized.prerequisites = [normalized.prerequisites];
      if (typeof normalized.confidence === "string") {
        normalized.confidence = ({ "高": "high", "中": "medium", "低": "low" } as Record<string, string>)[normalized.confidence] ?? normalized.confidence;
      }
      return normalized;
    });
  }
  return analysis;
}

function parseSubmittedAnalysis(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return JSON.parse(jsonrepair(input));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export class AiSdkAnalyzer implements Analyzer {
  private readonly provider;

  constructor(
    private readonly database: RadarDatabase,
    private readonly model: string,
    apiKey: string,
  ) {
    // `createMinimax` is the provider package's Anthropic-compatible factory.
    // China-region credentials require MiniMax's official minimaxi.com endpoint.
    this.provider = createMinimax({ apiKey, baseURL: "https://api.minimaxi.com/anthropic/v1" });
  }

  async analyze(releaseId: number): Promise<AnalysisResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await generateText({
          model: this.provider.chat(this.model as never),
          system: SYSTEM_PROMPT,
          prompt: "请读取当前官方模型更新，面向非技术读者提炼产品事实与 AI 应用洞察，并提交结构化结果。",
          temperature: 0.2,
          maxOutputTokens: 1_400,
          tools: {
            read_current_official_release: tool({
              description: "读取当前已领取的单条官方模型更新原文。必须先调用此工具，再做分析。",
              inputSchema: z.object({}),
              execute: async () => {
                const release = this.database.getRelease(releaseId);
                if (!release) throw new Error("Current release was not found in the database");
                if (release.status !== "analyzing") throw new Error("Current release is not claimed for analysis");
                return {
                  sourceTitle: release.sourceTitle,
                  sourceUrl: release.sourceUrl,
                  publishedAt: release.publishedAt,
                  content: release.rawContent,
                };
              },
            }),
            submit_analysis: tool({
              description: "在读取官方原文后，提交最终的结构化模型更新分析。analysis 必须是符合要求字段的 JSON 字符串，只在完成分析时调用一次。",
              inputSchema: submissionSchema,
              execute: async () => ({ accepted: true }),
            }),
          },
          toolChoice: "required",
          stopWhen: [hasToolCall("submit_analysis"), stepCountIs(4)],
        });
        const calls = result.steps.flatMap((step) => step.toolCalls);
        const sourceCallIndex = calls.findIndex((call) => call.toolName === "read_current_official_release");
        const finalCall = calls.find((call) => call.toolName === "submit_analysis");
        if (sourceCallIndex === -1) throw new Error("Model did not read the official release through the required tool");
        if (!finalCall) throw new Error("Model did not submit a structured analysis");
        if (calls.indexOf(finalCall) < sourceCallIndex) throw new Error("Model submitted analysis before reading the official release");
        const submitted = submissionSchema.parse(finalCall.input);
        return validateAnalysis(parseSubmittedAnalysis(submitted.analysis));
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`MiniMax structured analysis failed after retry: ${errorMessage(lastError)}`);
  }
}

export function makeAnalysisForTest(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return validateAnalysis({
    title: "模型更新带来的应用机会",
    summary: "官方模型能力更新。",
    models: ["GPT-5.6"],
    releaseKind: "model_update",
    capabilityTags: ["reasoning"],
    opportunityTags: ["agent"],
    keyChanges: ["模型能力更新"],
    potentialFeatures: [{ name: "任务代理", scenario: "企业自动化", rationale: "模型能力提升", prerequisites: ["评估"], confidence: "medium" }],
    caveats: ["应用机会是 AI 推演，不是官方承诺。"],
    ...overrides,
  });
}
