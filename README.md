# MPM · Model to Product Manager

面向 AI 产品人的模型更新洞察站：持续追踪官方模型发布记录，提炼值得讨论的产品机会。

## 本地启动

1. 安装依赖：`pnpm install`
2. 复制 `.env.example` 为 `.env`，只设置 `ADMIN_TOKEN`。
3. 在两个终端分别运行 `pnpm dev:api` 与 `pnpm dev:web`。
4. 打开 `http://localhost:5173` 查看文章与模型筛选。

本地 MiniMax 凭据默认从 `~/.mmx/config.json` 的 `api_key` 读取，不会复制到项目内；也可以使用 `MINIMAX_API_KEY` 显式覆盖。
本地默认使用 `MiniMax-M2.7-highspeed`，通过 MiniMax 官方 Vercel AI SDK Provider 的 Anthropic 兼容模式调用 `https://api.minimaxi.com/anthropic/v1`；可用 `MINIMAX_MODEL` 覆盖。

本机有代理环境变量时，API 启动脚本会启用 Node 的代理支持；Cloudflare 部署版将直接由 Worker 出网。

首轮仅处理每个来源最新 3 条模型相关记录，避免一次性为完整历史发布记录消耗模型额度；后续运行会依靠内容指纹自动去重。候选记录会先保存到 SQLite，再由 AI 分析任务领取；失败记录会在下次运行时重试。

首版只允许四个第一方来源：OpenAI Model Guidance、Claude Platform Release Notes、Kimi API 开放平台与智谱 GLM「新品发布」。OpenAI 与 Kimi 都从官方当前模型页实时发现型号，再逐一采集对应模型说明；智谱仅收录页面中的 GLM 模型更新卡。页面只保留明确关联模型或版本的发布、能力变更和弃用信息；应用界面、套餐、桌面端与任何第三方来源都会被忽略。

### 本地预热与同步生产数据

按厂商单独抓取、分析，避免领取其他厂商的待处理记录：

```sh
pnpm radar:run -- --provider kimi
pnpm radar:run -- --provider zhipu
```

确认本地文章效果后，可先预览再将该厂商的已发布文章及官方原文幂等导入生产 D1：

```sh
pnpm radar:sync-d1 -- --provider kimi --dry-run
pnpm radar:sync-d1 -- --provider kimi --confirm
```

同步命令只读取本地 SQLite 中已发布的 release/article，不导出运行历史或任何密钥。它以官方来源指纹和文章 slug 去重，重复执行不会覆盖线上文章；导入后会查询远端计数。Cloudflare Cron + Workflow 仍会在后续每天自动采集和分析新变化。

## Cloudflare 生产环境

生产站点部署为一个 Cloudflare Worker，静态前端与 `/api/*` 同源，D1 数据库名为 `mpm-production`；每日 UTC 02:15（北京时间 10:15）由 Cron 触发 Workflow 采集和分析。当前地址为 [mpm.chijiaduo.workers.dev](https://mpm.chijiaduo.workers.dev)。

首次部署与后续发布：

1. 在 Cloudflare Worker 中配置 Secrets：`MINIMAX_API_KEY`、`ADMIN_TOKEN`；不要把它们写入 `.env` 或 Git。
2. 运行 `pnpm deploy:cf`，它会构建前端、生成 Worker 类型并发布 Worker。
3. D1 schema 由 `migrations/` 管理；执行 `pnpm --filter @mpm/worker exec wrangler d1 migrations apply mpm-production --remote` 后再发布引用新 schema 的代码。

线上手动补跑入口为受保护的 `POST /api/admin/runs`，不在前端显示。当前管理员 Token 保存于本机 macOS Keychain；需要在本机终端使用时运行：

```sh
security find-generic-password -a mpm -s mpm-admin-token -w
```
