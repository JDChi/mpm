import { Hono } from "hono";
import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import type { Analyzer } from "./analyzer.js";
import type { AppConfig } from "./config.js";
import type { RadarDatabase } from "./db.js";
import { runCollection } from "./pipeline.js";
import type { SourceProvider } from "./sources.js";

export interface AppDependencies {
  config: AppConfig;
  database: RadarDatabase;
  sources: SourceProvider[];
  analyzer: Analyzer;
}

export function createApp(deps: AppDependencies): Hono {
  const app = new Hono();
  app.use("/api/*", cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST"],
  }));

  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/providers", (c) => c.json(deps.sources.map(({ id, label }) => ({ id, label }))));
  app.get("/api/articles", (c) => c.json(deps.database.listArticles({
    provider: c.req.query("provider"),
    model: c.req.query("model"),
    capabilityTag: c.req.query("capabilityTag"),
    opportunityTag: c.req.query("opportunityTag"),
  })));
  app.get("/api/articles/:slug", (c) => {
    const article = deps.database.getArticle(c.req.param("slug"));
    return article ? c.json(article) : c.json({ error: "Article not found" }, 404);
  });

  const admin: MiddlewareHandler = async (c, next) => {
    if (!deps.config.adminToken) return c.json({ error: "ADMIN_TOKEN is not configured" }, 503);
    if (c.req.header("Authorization") !== `Bearer ${deps.config.adminToken}`) return c.json({ error: "Unauthorized" }, 401);
    await next();
  };
  app.use("/api/admin/*", admin);
  app.get("/api/admin/runs", (c) => c.json(deps.database.listRuns()));
  app.post("/api/admin/runs", async (c) => c.json(await runCollection(deps.database, deps.sources, deps.analyzer)));

  return app;
}
