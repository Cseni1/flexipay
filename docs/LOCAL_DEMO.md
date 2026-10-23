# Local demo runbook

Concise operator notes for `main` **`f4347bd`**. Uses existing scripts only
(`scripts/demo/offline.ts`, `scripts/seed/seed.ts`, DF scripts, Vite CCR-19
proxy). No new launcher. Secrets are never printed or committed.

Lane-D detail lives in `scripts/demo/README.md` / `scripts/seed/README.md`
(Freebuff). This doc is the integrator snapshot for local setup.

## Prerequisites (verified)

| Item | Value |
| --- | --- |
| Git tip | `f4347bd` (`origin/main`) |
| Node | **v24** (verified `v24.21.0`) |
| Install | from repo root: `npm install` |
| Prisma client | `npm run db:generate --workspace=@flexipay/api` |
| Config check | `npm run validate:config` |

## Ports and processes

| Process | How it starts | Default |
| --- | --- | --- |
| Embedded Postgres | `npm run dev --workspace=@flexipay/api` → `dev-db.ts serve` | `127.0.0.1:54329`, `apps/api/.pgdata` |
| API | same; `PORT` / `FP_API_PORT` | **8788** |
| Web (Vite + CCR-19 proxy) | `npm run demo:offline` or web workspace | **5173**, prefer `--host 127.0.0.1` |

Override: `FP_API_PORT`, `FP_WEB_PORT` (must differ). Timeouts:
`FP_OFFLINE_API_TIMEOUT_MS` (120000), `FP_OFFLINE_WEB_TIMEOUT_MS` (60000).

## Environment names (values local only)

| Name | Role |
| --- | --- |
| `FP_SETTLEMENT` | `mock` (offline forces this) or `stellar` for online DF3 |
| `FP_CLAIM_SEAL_KEY` | 64 hex chars (claim seal) |
| `FP_API_URL` | API **origin** for Vite proxy (e.g. `http://127.0.0.1:8788`) — server-side only |
| `FP_API_KEY` | Demo Platform Bearer for **Vite server** / shell seed — never in browser bundle |
| `FP_CONFIG_DIR` | defaults to repo `config/` |
| `PORT` / `FP_API_PORT` / `FP_WEB_PORT` | as above |

Stellar extras: `FP_STELLAR_RPC_URL`, `FP_STELLAR_NETWORK_PASSPHRASE`,
`FP_PAYOUT_VAULT_ID`, `FP_RECIPIENT_A_ADDRESS`; secrets only in
`scripts/testnet/.env.secrets`.

### Demo Platform key

No HTTP bootstrap. Provision org+key in local DB (see `apps/api/test/helpers.ts`
`newOrg`), export `FP_API_KEY` for Vite/seed. Never commit values.

### Browser auth (CCR-19)

Local Vite plugin (`apps/web/vite.proxy.ts`) injects Bearer for protected
`/v1/*` from server-side `FP_API_KEY`; public `/v1/claims/*` stay keyless.
**Local-dev / `vite preview` only** — not authentication for a deployed static
build. Clients use relative `/v1/...`.

## Launch (offline / mock)

```bash
npm run demo:offline -- --print-plan          # no processes; no key printed
npm run demo:offline -- --no-seed             # API + web; skip seed
# with FP_API_KEY + FP_API_URL set for the Vite process:
npm run demo:offline
```

Ready: `GET http://127.0.0.1:8788/healthz` → 200; Vite on 5173.

### Shutdown

Ctrl-C / SIGTERM on the offline launcher (process-group cleanup). Keep
`.pgdata` + same `FP_CLAIM_SEAL_KEY` for claim restart tests.

### Manual split

```bash
# terminal A
FP_SETTLEMENT=mock FP_CLAIM_SEAL_KEY=… PORT=8788 npm run dev --workspace=@flexipay/api

# terminal B (proxy reads FP_API_URL + FP_API_KEY from apps/web env / process env)
FP_API_URL=http://127.0.0.1:8788 FP_API_KEY=… \
  npm run dev --workspace=@flexipay/web -- --host 127.0.0.1 --port 5173
```

## Seed / reset

```bash
export FP_API_URL=http://127.0.0.1:8788
# export FP_API_KEY=…
node scripts/seed/seed.ts reset
node scripts/seed/seed.ts
```

On **`f4347bd`**: `POST /v1/sandbox/reset`, recipients, **and**
`POST /v1/endpoints` are mounted. Full seed PASS is Freebuff’s acceptance to
confirm — do not claim it here while they are mid-run.

## Mock DF / browser

Shell DF scripts (after seed) and browser CF1/CF4 through the local proxy target
**`f4347bd`**. Freebuff owns full acceptance evidence.

**CCR-15 mock/public-API recovery:** PASS on `f4347bd` (Freebuff evidence
`9d05609`). Refund-failure / crash-window: backend-test only. **Stellar:** NOT
VERIFIED. Do not claim MVP complete until mandatory acceptance is recorded.

## Online Stellar (separate)

```bash
# FP_SETTLEMENT=stellar + testnet ids/secrets + recipient address
node scripts/demo/df3-claim.ts --mode stellar
```

Not claimed in this runbook.

## Mounted routes (`f4347bd`)

`healthz`, corridors, recipients, **endpoints**, **batches**, quotes, payments
(list/get/fund/cancel), events, claims get/accept, sandbox fail-next /
provider-health / **advance-time** / reset.

## `releaseTxRef` note (CCR-12)

Settle `releaseTxRef` may hold a **claim release** or a **vault refund** hash.
Do not treat the field alone as “paid / claimed”; use `Payment.status`, settle
leg status/`errorCode`, and `payment.onchain` `phase` (`release` vs `refund`).

## Offline fallback

`npm run demo:offline -- --no-seed` (or with key + seed). Settlement stays
**mock**. Plan-only: `node scripts/demo/offline.ts --print-plan`.
