import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AiSdkAnalyzer } from "./analyzer.js";
import { getConfig } from "./config.js";
import { RadarDatabase } from "./db.js";
import { renderD1SyncSql, renderD1VerificationQuery } from "./d1-sync.js";
import { runCollection } from "./pipeline.js";
import { defaultSources } from "./sources.js";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function usage(): string {
  return [
    "Usage:",
    "  pnpm radar:run -- --provider <openai|anthropic|kimi|zhipu>",
    "  pnpm radar:sync-d1 -- --provider <openai|anthropic|kimi|zhipu> --dry-run",
    "  pnpm radar:sync-d1 -- --provider <openai|anthropic|kimi|zhipu> --confirm",
  ].join("\n");
}

function selectedProvider(args: string[]): string {
  const provider = valueAfter(args, "--provider");
  const providers = new Set(defaultSources().map((source) => source.id));
  if (!provider || !providers.has(provider)) throw new Error(`A valid provider is required.\n${usage()}`);
  return provider;
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: workspaceRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? "unknown"}`)));
  });
}

async function runProvider(provider: string): Promise<void> {
  const config = getConfig();
  if (!config.minimaxApiKey) throw new Error("MINIMAX_API_KEY is not set and ~/.mmx/config.json did not contain api_key");
  const source = defaultSources().find((candidate) => candidate.id === provider)!;
  const database = new RadarDatabase(config.databasePath);
  const analyzer = new AiSdkAnalyzer(database, config.minimaxModel, config.minimaxApiKey);
  const result = await runCollection(database, [source], analyzer, { provider });
  console.info(JSON.stringify(result, null, 2));
}

async function syncD1(provider: string, dryRun: boolean, confirm: boolean): Promise<void> {
  if (dryRun === confirm) throw new Error(`Choose exactly one of --dry-run or --confirm.\n${usage()}`);
  const database = new RadarDatabase(getConfig().databasePath);
  const records = database.listPublishedForSync(provider);
  const summary = records.map(({ article, release }) => ({ slug: article.slug, title: article.title, model: release.sourceTitle }));
  console.info(JSON.stringify({ provider, publishedRecords: records.length, records: summary }, null, 2));
  if (dryRun || records.length === 0) return;

  const directory = await mkdtemp(join(tmpdir(), "mpm-d1-sync-"));
  const sqlFile = join(directory, `${provider}.sql`);
  try {
    await writeFile(sqlFile, renderD1SyncSql(records), "utf8");
    await runCommand("pnpm", ["--filter", "@mpm/worker", "exec", "wrangler", "d1", "execute", "mpm-production", "--remote", "--file", sqlFile]);
    await runCommand("pnpm", ["--filter", "@mpm/worker", "exec", "wrangler", "d1", "execute", "mpm-production", "--remote", "--command", renderD1VerificationQuery(provider)]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "run") return runProvider(selectedProvider(args));
  if (command === "sync-d1") return syncD1(selectedProvider(args), args.includes("--dry-run"), args.includes("--confirm"));
  throw new Error(usage());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
