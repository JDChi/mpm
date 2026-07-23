import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { AiSdkAnalyzer } from "../../api/src/analyzer.js";
import { createApp } from "../../api/src/app.js";
import { runCollection } from "../../api/src/pipeline.js";
import { defaultSources } from "../../api/src/sources.js";
import { D1RadarDatabase } from "./d1-repository.js";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  RELEASE_WORKFLOW: Workflow<RunParams>;
  ADMIN_TOKEN: string;
  MINIMAX_API_KEY: string;
  MINIMAX_MODEL?: string;
}

interface RunParams {
  trigger: "scheduled" | "manual";
}

function dependencies(env: Env) {
  const database = new D1RadarDatabase(env.DB);
  const analyzer = new AiSdkAnalyzer(database, env.MINIMAX_MODEL ?? "MiniMax-M2.7-highspeed", env.MINIMAX_API_KEY);
  return { database, sources: defaultSources(), analyzer };
}

export class ReleaseWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  async run(_event: WorkflowEvent<RunParams>, step: WorkflowStep): Promise<unknown> {
    return step.do("collect and analyze official model releases", { retries: { limit: 1, delay: "30 seconds" } }, async () => {
      const deps = dependencies(this.env);
      return runCollection(deps.database, deps.sources, deps.analyzer);
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    const deps = dependencies(env);
    const app = createApp({
      ...deps,
      config: { adminToken: env.ADMIN_TOKEN },
      startRun: async () => {
        const instance = await env.RELEASE_WORKFLOW.create({ params: { trigger: "manual" } });
        return { status: "queued", workflowId: instance.id };
      },
    });
    return app.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(env.RELEASE_WORKFLOW.create({ params: { trigger: "scheduled" } }));
  },
} satisfies ExportedHandler<Env>;
