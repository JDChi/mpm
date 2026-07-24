# MPM Repository Guide

MPM (Model to Product Manager) tracks official model releases and turns them
into product-oriented AI application insights. Keep the site useful to AI
product people; articles should not assume the reader is a programmer.

## Workspace layout

- `apps/web`: Vite + React front end.
- `apps/api`: local Hono API and SQLite implementation.
- `apps/worker`: Cloudflare Worker, D1 repository and Workflow entry point.
- `packages/contracts`: shared TypeScript types and schemas.
- `migrations`: D1 schema migrations.
- `data/mpm.sqlite`: local development data only; never commit or export secrets from it.

## Commands

Use `pnpm` (the repository is pinned to pnpm 10).

- `pnpm dev:api` / `pnpm dev:web`: run the local API and front end.
- `pnpm test`: run API and pipeline tests.
- `pnpm build`: build local packages.
- `pnpm build:cf`: build the production front end and type-check the Worker.
- `pnpm dev:cf`: run the Worker locally with local D1.
- `pnpm deploy:cf`: build, apply pending production D1 migrations, then deploy the Worker.

Run the focused test suite and the relevant build before handing off a change.

## Architecture rules

- Keep domain behavior behind the asynchronous `ReleaseRepository` interface.
  SQLite is the local implementation; D1 is the production implementation.
- The production Worker serves both the static web app and `/api/*` under one
  domain. Do not add a separate deployed API service without an explicit
  product decision.
- Cron only starts the Workflow. The Workflow collects releases, persists
  them, claims pending work, analyzes it, and publishes articles.
- Analysis must read only the release bound to the current job via
  `read_current_official_release()`. Do not add unrestricted web, file, or
  database access to the agent.
- Preserve release state transitions: `pending` → `analyzing` → `published`;
  failures are `retryable_failed`. Keep fingerprint de-duplication and atomic
  claiming intact.

## Editorial and source policy

- Admit only explicit first-party model release sources configured in code.
  Never use third-party news, social posts, aggregators, or user-supplied URLs
  as a fallback.
- Keep only new model launches, model-version updates, model-specific
  capabilities, and deprecations. Exclude pure app UI, plans, desktop, and
  unrelated product updates.
- Preserve the distinction between official facts and inferred product
  opportunities. Always retain the original official source link.
- Use the fixed tag vocabulary. Do not let model output invent tags.
- Article analysis should be practical, product-manager oriented, and
  accessible to non-programmers; avoid overly implementation-centric prose.

## Cloudflare production

- Worker name: `mpm`; production D1 database: `mpm-production`.
- `wrangler.jsonc` is the production configuration. Keep `DB`,
  `RELEASE_WORKFLOW`, static assets, Cron, and `nodejs_compat` bindings aligned
  with the code.
- Production secrets are `MINIMAX_API_KEY` and `ADMIN_TOKEN`. They are Worker
  Secrets, not repository variables. The model name is a non-sensitive
  Wrangler variable.
- The hidden `/api/admin/runs` endpoints require a Bearer `ADMIN_TOKEN` and
  must enqueue a Workflow; never run collection and analysis inline in HTTP.
- `main` is connected to Cloudflare Workers Builds. Treat every push to `main`
  as a production deployment. Do not enable preview builds with the production
  deploy script, since it applies production D1 migrations.

## Security and Git hygiene

- Never commit `.env`, API keys, admin tokens, `~/.mmx/config.json`, Keychain
  values, local SQLite databases, or production data exports.
- Do not expose administrative endpoints or tokens in the front end.
- Before a requested push, run `git diff --check`, inspect the exact staged
  scope, scan for secrets and local paths, then commit and push only the
  approved change.
- Do not reset, force-push, or overwrite unrelated user changes.
