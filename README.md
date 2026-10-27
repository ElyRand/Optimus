# Optimus

A local-first personal agent with supervised autonomy, built with **TanStack AI, Temporal, Hono, React, Prisma and SQLite**.

**Status: working dry-run prototype.** API, proposal review, approval, cancellation and recovery have automated tests. All GitHub publication remains simulated. The live Codex/Claude microVM harness is experimental and has not been exercised by CI.

## What works

- Local bearer-protected Hono API and React/Vite dashboard.
- Temporal missions: prepare → show proposal → await owner decision → recheck policy and payload → simulated completion.
- Durable approvals bound to the exact task, repository and objective. Altering the action invalidates approval.
- Global pause, per-mission cancellation, explicit failure states, and approval recovery after worker and Temporal server restarts.
- Prisma on SQLite for the task, approval and audit ledger, with bounded FTS5 memory search.
- Deterministic initiative rules for allowlisted `ci.failed` events submitted to the authenticated API.
- Optional owner-scoped Slack Socket Mode integration. Slack notification failures leave dashboard approval available.
- Codex (default) or Claude Code adapter through Docker Sandboxes microVMs only; disabled by default.

## Run locally

Requirements: **Node.js 22+**, npm and the [Temporal CLI](https://docs.temporal.io/cli). Docker Sandboxes (`sbx`) is only needed for the experimental live harness. Run all commands from the repository root.

```bash
npm ci
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste the generated token into `API_ACCESS_TOKEN` in `.env`. `APPROVED_REPOS` defaults to `ElyRand/Optimus`; replace it with your comma-separated repository allowlist. Keep `LIVE_HARNESS=false` for the tested flow. On Windows, use `Copy-Item .env.example .env` instead of `cp`.

Start each service in a separate terminal:

```bash
# 1. Temporal (create the data directory first)
mkdir -p data
temporal server start-dev --ip 127.0.0.1 --db-filename data/temporal.db

# 2. Worker
npm run dev:worker

# 3. API
npm run dev:api

# 4. Dashboard
npm run dev:web
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173), enter your local API token, and create a mission. Read its proposal and approve or reject it. Approval reports a **simulation**, with no push or pull request. The token stays in the tab's memory.

The API defaults to port 3001 and Vite proxies `/api` there. If changing `API_PORT`, also update the proxy in `apps/web/vite.config.ts`.

If a decision is saved while Temporal is unavailable, use **Renvoyer la décision enregistrée** in the dashboard after Temporal returns. Decisions cannot be reversed by retrying.

## Verify

```bash
npm run check
npm test
npm run build
npm run test:integration
```

Unit tests cover permissions, action hash changes, mismatched approvals, pause/revocation, memory, authentication, API validation, failures and retrying approval signals. Integration tests start a real Temporal development server, exercise the API and worker against temporary SQLite files, restart both worker and Temporal before approval, and cover rejection, cancellation, preparation failure and a Slack outage. No model calls or Slack/GitHub credentials are needed.

The integration suite downloads Temporal CLI on its first run, requiring network access and local TCP ports. CI runs these commands on Node 22 and 24. `npm run build` produces the Vite dashboard in `apps/web/dist`; API and worker execute TypeScript through `tsx`.

## Experimental live harness

Set `LIVE_HARNESS=true` only after configuring a real Docker Sandboxes microVM, its network policy and a Codex/Claude CLI session **inside the sandbox**. `AGENT_HARNESS=codex` uses Codex login rather than an API key. `AGENT_HARNESS=claude` selects Claude Code; `AGENT_MODEL` optionally overrides its model. Host login is not assumed to propagate into the VM.

Never mount your home, `.env`, browser profile, SSH keys, Docker socket or production credentials. No automatic host-process fallback exists. Harness output is an **unverified, non-publishable report**. Real sandbox startup, session restoration, bounded execution, cancellation and artifact extraction are the next milestone.

## Boundaries and remaining work

The host owns memory, secrets and the Permission Broker; the model cannot grant capabilities. Unknown capabilities are denied. Approval never overrides a denied capability, and the broker rechecks the current repository allowlist before completion.

This prototype does not implement real GitHub writes, unrestricted host shell, Computer Use, Jev classification, autonomous schedules, webhook subscriptions or production secret storage. The `/api/events` endpoint is authenticated input, not a GitHub webhook receiver. Event receipt and workflow startup do not yet have a transactional outbox; retries of a recorded event after startup failure need manual recovery. Activities that perform real external actions will need persisted idempotency and external verification before enabling retries.

See [AGENTS.md](AGENTS.md), [architecture](docs/ARCHITECTURE.md) and [security](docs/SECURITY.md).
