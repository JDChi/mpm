import { serve } from "@hono/node-server";
import { AiSdkAnalyzer } from "./analyzer.js";
import { createApp } from "./app.js";
import { getConfig } from "./config.js";
import { RadarDatabase } from "./db.js";
import { defaultSources } from "./sources.js";

const config = getConfig();
if (!config.minimaxApiKey) throw new Error("MINIMAX_API_KEY is not set and ~/.mmx/config.json did not contain api_key");
const database = new RadarDatabase(config.databasePath);
const app = createApp({
  config,
  database,
  sources: defaultSources(),
  analyzer: new AiSdkAnalyzer(database, config.minimaxModel, config.minimaxApiKey),
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.info(`Model Radar API listening on http://localhost:${info.port}`);
});
