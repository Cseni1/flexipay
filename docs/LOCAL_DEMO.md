# Local demo runbook

Concise operator notes for `main` **`e99f03a`**. Uses existing scripts only
(`scripts/demo/offline.ts`, `scripts/seed/seed.ts`, DF scripts). No new
launcher. Secrets are never printed or committed.

Lane-D detail lives in `scripts/demo/README.md` / `scripts/seed/README.md`
(Freebuff). Sync status with those files when they refresh; this doc is the
integrator snapshot for local setup.

## Prerequisites (verified)

| Item | Value |
| --- | --- |
| Git tip | `e99f03a` (`origin/main`) |
| Node | **v24** (verified `v24.21.0`; `@types/node` ^24) |
| Install | from repo root: `npm install` |
| Prisma client | `npm run db:generate --workspace=@flexipay/api` (after pull / schema change) |
| Config check | `npm run validate:config` |

## Ports and processes

| Process | How it starts | Default |
| --- | --- | --- |
| Embedded Postgres | owned by `npm run dev --workspace=@flexipay/api` → `node scripts/dev-db.ts serve` | `127.0.0.1:54329`, data dir `apps/api/.pgdata` |
| API | same command; `PORT` / `FP_API_PORT` | **8788** → `http://127.0.0.1:8788` |
| Web (Vite) | `npm run dev --workspace=@flexipay/web` | **5173** → `http://127.0.0.1:5173` |

Override: `FP_API_PORT`, `FP_WEB_PORT` (must differ). Readiness timeouts:
`FP_OFFLINE_API_TIMEOUT_MS` (default 120000), `FP_OFFLINE_WEB_TIMEOUT_MS`
(default 60000).

## Environment names (values local only)

Copy names from root `.env.example`. For a mock offline demo you typically set:

| Name | Role |
| --- | --- |
| `FP_SETTLEMENT` | `mock` (offline launcher forces this) or `stellar` for online DF3 |
| `FP_CLAIM_SEAL_KEY` | 64 hex chars (32-byte seal); required for claim flows |
| `FP_API_URL` | e.g. `http://127.0.0.1:8788` |
| `FP_API_KEY` | Demo Platform sandbox Bearer key (**never log/commit**) |
| `FP_CONFIG_DIR` | defaults to repo `config/` via offline plan |
| `PORT` / `FP_API_PORT` / `FP_WEB_PORT` | as above |
| `DATABASE_URL` | set automatically by `dev-db.ts serve` for embedded Postgres |

Stellar / DF3 extras (online only; public ids from `scripts/testnet/testnet-ids.env`):
`FP_STELLAR_RPC_URL`, `FP_STELLAR_NETWORK_PASSPHRASE`, `FP_PAYOUT_VAULT_ID`,
`FP_RECIPIENT_A_ADDRESS`, plus secrets only in git-ignored
`scripts/testnet/.env.secrets`.

### Demo Platform key bootstrap

There is **no** HTTP route that creates an organization or API key. Local keys
are provisioned the same way API tests do: insert a Demo Platform
`organization` + hashed `apiKey` row into the **local** database, then export
`FP_API_KEY` in your shell (see `apps/api/test/helpers.ts` `newOrg`). Do not
paste keys into git, evidence JSON, or chat.

Until a key is set, `demo:offline` still starts API+web but **skips seed**.

### Browser vs API key (CCR-19)

- **No merged BFF yet.** Do not put `FP_API_KEY` in `apps/web` env or Vite
  `define`. Demo scripts and seed use the key in the **shell** only.
- Accepted minimal path (Freebuff owns implementation): Vite/same-origin proxy
  injects Bearer for protected `/v1/*`; public `/v1/claims/*` stay unauthenticated.
  See `docs/CONTRACT_CHANGES.md` CCR-19.

## Launch (offline / mock)

```bash
# 1) Inspect plan only (no processes; never prints FP_API_KEY)
npm run demo:offline -- --print-plan
# equivalent: node scripts/demo/offline.ts --print-plan

# 2) Start embedded Postgres + API + web (mock settlement). Skip seed if no key yet.
npm run demo:offline -- --no-seed

# 3) With FP_API_KEY already exported, start and auto-seed after /healthz + Vite ready
npm run demo:offline
```

Ready when: `GET http://127.0.0.1:8788/healthz` → 200, and the Vite URL answers.

### Clean shutdown

Ctrl-C / SIGTERM on the offline launcher: it SIGTERMs its process groups, waits,
then SIGKILLs. Do not leave orphan `node`/`vite` children. Stopping leaves
`apps/api/.pgdata` intact for restart (same seal key required for claim
restart tests).

### Manual split (same existing commands)

```bash
# terminal A — API (+ embedded Postgres on 54329)
FP_SETTLEMENT=mock FP_CLAIM_SEAL_KEY=… PORT=8788 npm run dev --workspace=@flexipay/api

# terminal B — web
npm run dev --workspace=@flexipay/web -- --host 127.0.0.1 --port 5173
```

## Seed / reset

```bash
export FP_API_URL=http://127.0.0.1:8788
# export FP_API_KEY=…   # local only

node scripts/seed/seed.ts reset   # POST /v1/sandbox/reset
node scripts/seed/seed.ts         # reset + four recipients; then probes endpoints
```

**Status on `e99f03a` (do not claim PASS):**

| Step | Result |
| --- | --- |
| `POST /v1/sandbox/reset` | mounted |
| `POST /v1/recipients` ×4 | mounted |
| Endpoint create / full seed | **BLOCKED** — `POST /v1/endpoints` **not mounted** (schemas on main since `ad9dc2c`; routes wait on #43) |
| Exit | seed exits **2 BLOCKED** when endpoints missing |

## Mock DF scripts

```bash
export FP_API_URL=http://127.0.0.1:8788
# export FP_API_KEY=…
export FP_SETTLEMENT=mock

node scripts/demo/df1-batch.ts      # BLOCKED — needs POST /v1/batches (+ endpoints)
node scripts/demo/df2-one-off.ts    # BLOCKED — needs seeded endpoints
node scripts/demo/df3-claim.ts      # BLOCKED — needs endpoints / full seed path
node scripts/demo/df4-failure.ts    # BLOCKED — same
node scripts/demo/df5-za-company.ts # BLOCKED — same
node scripts/demo/run-all.ts        # exits 2 unless every flow PASS
```

Exit codes: `0` PASS, `1` FAIL, `2` BLOCKED. Evidence JSON under
`scripts/demo/evidence/` is git-ignored per run; committed markdown evidence
must not contain keys or secrets.

**Also open (not a DF route gap):** CCR-15 claim-accept after fee-drift can still
mark `paid` on `e99f03a` — see `scripts/demo/evidence/2026-10-23-orphan-lock-286d044.md`.
Do not treat mock DF as acceptance until that is fixed and Freebuff re-verifies.

## Online Stellar (separate)

Requires testnet setup (`scripts/testnet/setup.sh` → public
`testnet-ids.env` + git-ignored secrets), `FP_SETTLEMENT=stellar`, and Worker A
address. Example shape only:

```bash
# export FP_API_URL=… FP_API_KEY=… FP_SETTLEMENT=stellar
# export FP_RECIPIENT_A_ADDRESS=G… FP_STELLAR_RPC_URL=… \
#   FP_STELLAR_NETWORK_PASSPHRASE='Test SDF Network ; September 2015' \
#   FP_PAYOUT_VAULT_ID=C…
node scripts/demo/df3-claim.ts --mode stellar
# or: node scripts/demo/run-all.ts --stellar
```

**Not claimed run here.** Still **BLOCKED** on seed/endpoints (#43) and CCR-15
recovery before treating online DF3 as acceptance.

## What is mounted vs missing (`e99f03a`)

**Mounted:** `healthz`, corridors, recipients, quotes, payments (list/get/fund/cancel),
events, claims get/accept, sandbox fail-next / provider-health / reset.

**Not mounted (schemas only):** `POST/GET /v1/endpoints`, `POST/GET /v1/batches`,
`POST /v1/sandbox/advance-time`.

## Offline fallback

If network or Stellar is unavailable: use `npm run demo:offline -- --no-seed`
(or with a local key + seed once endpoints land). Settlement stays **mock**;
providers are simulated from `config/`. Plan-only:
`node scripts/demo/offline.ts --print-plan`.
