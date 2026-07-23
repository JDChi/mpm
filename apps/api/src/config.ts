import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface AppConfig {
  adminToken: string | undefined;
  databasePath: string;
  minimaxApiKey: string | undefined;
  minimaxModel: string;
  port: number;
}

const workspaceRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function loadDotEnv(): Record<string, string> {
  const file = resolve(workspaceRoot, ".env");
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, "")];
      }),
  );
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const local = loadDotEnv();
  const read = (key: string) => env[key] ?? local[key];
  const minimaxApiKey = read("MINIMAX_API_KEY") ?? loadMmxApiKey();
  return {
    adminToken: read("ADMIN_TOKEN"),
    databasePath: resolve(workspaceRoot, read("DATABASE_PATH") ?? "data/mpm.sqlite"),
    minimaxApiKey,
    minimaxModel: read("MINIMAX_MODEL") ?? read("MMX_MODEL") ?? "MiniMax-M2.7-highspeed",
    port: Number(read("PORT") ?? 8787),
  };
}

function loadMmxApiKey(): string | undefined {
  const file = resolve(homedir(), ".mmx/config.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { api_key?: unknown };
    return typeof parsed.api_key === "string" && parsed.api_key ? parsed.api_key : undefined;
  } catch {
    return undefined;
  }
}
