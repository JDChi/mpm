import { describe, expect, it } from "vitest";
import { parseAnalysisPayload, validateAnalysis } from "../src/analyzer.js";

describe("analysis normalization", () => {
  it("accepts Chinese field names returned by MiniMax before applying the strict schema", () => {
    const analysis = validateAnalysis({
      标题: "GPT-5.6 的产品机会",
      摘要: "官方加强了复杂任务处理能力。",
      模型: ["GPT-5.6"],
      更新类型: "模型能力更新",
      能力标签: ["推理", "工具调用"],
      应用机会标签: ["Agent"],
      关键变化: ["更适合处理多步骤任务。"],
      潜在功能: [{ 名称: "任务助手", 应用场景: "复杂业务流程", 依据: "更强的工具使用能力", 前提条件: ["建立评估集"], 置信度: "中" }],
      注意事项: ["应用机会不是官方承诺。"],
    });

    expect(analysis).toMatchObject({
      title: "GPT-5.6 的产品机会",
      releaseKind: "model_capability",
      capabilityTags: ["reasoning", "tool_use"],
      opportunityTags: ["agent"],
      potentialFeatures: [{ name: "任务助手", confidence: "medium" }],
    });
  });

  it("repairs harmless list-shape differences before validation", () => {
    const analysis = validateAnalysis({
      title: "GPT-5.6 的产品机会",
      summary: "官方扩展了模型的能力边界。",
      models: ["GPT-5.6", "GPT-5.6 Sol", "GPT-5.6 Terra", "GPT-5.6 Luna"],
      releaseKind: "model_capability",
      capabilityTags: ["reasoning", "tool_use", "context", "coding"],
      opportunityTags: ["agent"],
      keyChanges: ["支持更复杂的工作流。"],
      potentialFeatures: [{ name: "任务助手", scenario: "复杂任务", rationale: "更强的推理能力", prerequisites: "建立评估集", confidence: "medium" }],
      caveats: ["应用机会不是官方承诺。"],
    });

    expect(analysis.models).toEqual(["GPT-5.6", "GPT-5.6 Sol", "GPT-5.6 Terra"]);
    expect(analysis.capabilityTags).toEqual(["reasoning", "tool_use", "context"]);
    expect(analysis.potentialFeatures[0]?.prerequisites).toEqual(["建立评估集"]);
  });

  it("accepts one-item strings where the provider omits an array wrapper", () => {
    const analysis = validateAnalysis({
      title: "GPT-5.5 的产品机会",
      summary: "更适合处理长流程任务。",
      models: "GPT-5.5",
      releaseKind: "版本更新",
      capabilityTags: "推理",
      opportunityTags: "智能体",
      keyChanges: "官方说明了模型能力变化。",
      potentialFeatures: {
        name: "任务助手",
        scenario: "跨系统跟进事项",
        rationale: "减少人工往返确认。",
        prerequisites: "需先接入业务系统",
        confidence: "中",
      },
      caveats: "这是产品推演，并非官方承诺。",
    });

    expect(analysis.models).toEqual(["GPT-5.5"]);
    expect(analysis.keyChanges).toEqual(["官方说明了模型能力变化。"]);
    expect(analysis.caveats).toEqual(["这是产品推演，并非官方承诺。"]);
    expect(analysis.potentialFeatures).toHaveLength(1);
  });

  it("accepts a valid JSON final response when MiniMax omits the submission tool call", () => {
    const analysis = validateAnalysis(parseAnalysisPayload(`\`\`\`json
      {"title":"K2.7 Code 的产品机会","summary":"更适合长程代码任务。","models":["Kimi K2.7 Code"],"releaseKind":"new_model","capabilityTags":["coding"],"opportunityTags":["developer_tools"],"keyChanges":["官方发布模型。"],"potentialFeatures":[{"name":"代码助手","scenario":"复杂项目","rationale":"长程任务能力提升。","prerequisites":["评测"],"confidence":"medium"}],"caveats":["不是官方承诺。"]}
    \`\`\``));

    expect(analysis.models).toEqual(["Kimi K2.7 Code"]);
    expect(analysis.title).toContain("K2.7 Code");
  });
});
