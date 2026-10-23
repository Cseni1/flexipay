# Local demo runbook

Operator notes for `main` **`92f8cc1`**. Existing scripts only
(`scripts/demo/offline.ts`, `scripts/seed/seed.ts`, DF scripts, Vite CCR-19
proxy). No new launcher. Never print or commit secrets.

Lane-D detail: `scripts/demo/README.md`, `scripts/seed/README.md`. Stellar
overview: `docs/STELLAR.md`. Prior-work disclosure: `docs/PRIOR_WORK.md`.

**Baseline status:** D1/D2 mock + Stellar flows, browser DF2/DF3/DF5, and
**CCR-11 Stellar restart** are evidenced (see below). Stellar fee-drift recovery
and the different-seal-key negative control remain open — see gaps. Do not
duplicate the successful CCR-11 chain run.

## Prerequisites

| Item | Value |
| --- | --- |
| Git tip | `92f8cc1` (`origin/main`) |
| Node | **v24** (verified `v24.21.0`) |
| Install | repo root: `npm install` |
| Prisma | `npm run db:generate --workspace=@flexipay/api` |
| Config | `npm run validate:config` |

## Ports

| Process | Command | Default |
| --- | --- | --- |
| Embedded Postgres | via `npm run dev --workspace=@flexipay/api` → `dev-db.ts serve` | `127.0.0.1:54329`, `apps/api/.pgdata` |
| API | same; `PORT` / `FP_API_PORT` | **8788** |
| Web (Vite + CCR-19 proxy) | `demo:offline` or web workspace | **5173**, prefer `--host 127.0.0.1` |

Overrides: `FP_API_PORT`, `FP_WEB_PORT`. Timeouts: `FP_OFFLINE_API_TIMEOUT_MS`
(120000), `FP_OFFLINE_WEB_TIMEOUT_MS` (60000).

## Environment (names only; values stay local)

| Name | Role |
| --- | --- |
| `FP_SETTLEMENT` | `mock` (offline forces this) or `stellar` for real vault settlement |
| `FP_CLAIM_SEAL_KEY` | 64 hex chars (claim seal) |
| `FP_API_URL` | API **origin** for Vite proxy / scripts (e.g. `http://127.0.0.1:8788`) |
| `FP_API_KEY` | Demo Platform Bearer for **Vite server** and seed — never in the browser bundle |
| `FP_CONFIG_DIR` | defaults to repo `config/` |
| `PORT` / `FP_API_PORT` / `FP_WEB_PORT` | as above |

Stellar extras (public ids in `scripts/testnet/testnet-ids.env`; secrets only in
git-ignored `scripts/testnet/.env.secrets`): `FP_STELLAR_RPC_URL`,
`FP_STELLAR_NETWORK_PASSPHRASE`, `FP_PAYOUT_VAULT_ID`, `FP_RECIPIENT_A_ADDRESS`.

No HTTP org/key bootstrap. Provision a local Demo Platform key (see
`apps/api/test/helpers.ts` `newOrg`), then export `FP_API_KEY` in the shell.
Without a key, `demo:offline` still starts API+web but skips seed.

**CCR-19:** `apps/web/vite.proxy.ts` injects Bearer on protected `/v1/*` from
server-side `FP_API_KEY`; `/v1/claims/*` stay public. Local Vite / `vite preview`
only — not static-deploy auth. Clients call relative `/v1/...`.

## Real Stellar vs simulated banking / FX

| Layer | When `FP_SETTLEMENT=mock` | When `FP_SETTLEMENT=stellar` |
| --- | --- | --- |
| Bank / e-wallet / FX legs | Simulated providers from `config/`; UI shows **SIMULATED** | Same simulated rails (still labelled) |
| Settle / vault | In-memory mock vault (`mock-tx-*` refs) | **Real** Soroban `payout_vault` on Stellar testnet (`create_payout` / `claim` / `cancel`) |
| Offline launcher | Always mock | N/A — use a separately started stellar API |

A 64-hex hash alone is not proof. DF3/DF4 acceptance decodes the vault invocation
from RPC; explorer links are supporting evidence only.

## Launch (offline / mock)

```bash
npm run demo:offline -- --print-plan          # no processes; never prints FP_API_KEY
npm run demo:offline -- --no-seed             # Postgres + API + web; skip seed
# with FP_API_KEY exported for the Vite/seed processes:
npm run demo:offline
```

Ready: `GET http://127.0.0.1:8788/healthz` → 200; Vite answers on 5173.

### Manual split

```bash
# terminal A — set FP_SETTLEMENT=mock, FP_CLAIM_SEAL_KEY, and PORT=8788
npm run dev --workspace=@flexipay/api

# terminal B — set FP_API_URL to the API origin and FP_API_KEY for the proxy
npm run dev --workspace=@flexipay/web -- --host 127.0.0.1 --port 5173
```

Shutdown: Ctrl-C on the offline launcher (process-group cleanup). Keep `.pgdata`
and the same seal key if you intend claim-restart checks.

## Seed / reset

```bash
export FP_API_URL=http://127.0.0.1:8788
# export FP_API_KEY in the shell (local only)
node scripts/seed/seed.ts reset   # POST /v1/sandbox/reset
node scripts/seed/seed.ts         # reset + recipients + endpoints
```

On **`92f8cc1`**: reset, recipients, endpoints and batches are mounted. Seed and
replay **PASS** in
`scripts/demo/evidence/2026-10-23-d1-d2-final-acceptance.md`.

## Demo scripts

```bash
export FP_API_URL=http://127.0.0.1:8788
# export FP_API_KEY in the shell
export FP_SETTLEMENT=mock

node scripts/demo/df1-batch.ts
node scripts/demo/df2-one-off.ts
node scripts/demo/df3-claim.ts --mode mock
node scripts/demo/df4-failure.ts          # retry once, then refund
node scripts/demo/df5-za-company.ts
node scripts/demo/run-all.ts              # all five in mock

# Stellar: start the API with FP_SETTLEMENT=stellar and testnet env, then:
node scripts/demo/run-all.ts --stellar
# or one claim flow:
node scripts/demo/df3-claim.ts --mode stellar
```

Exit: `0` PASS, `1` FAIL, `2` BLOCKED. Per-run JSON under
`scripts/demo/evidence/` is git-ignored.

## Short UI demo (browser)

Against the **offline mock** stack (or a stellar API + web with proxy):

1. **Quote** — Send form → route, fees, FX, validity (SIMULATED labels on bank/FX).
2. **Payment** — Create → detail → **Fund** → status moves through processing.
3. **Claim** (crypto / claim-link path) — open claim URL → Accept with destination
   → payment becomes **Paid** only after release.
4. **Verified transaction** — on mock, settlement refs are `mock-tx-*`. On
   Stellar, use settle `lockTxRef` / `releaseTxRef` and RPC/explorer proof (see
   `docs/STELLAR.md`); do not treat `releaseTxRef` alone as paid (CCR-12: field
   may also hold a refund hash — check `payment.onchain` `phase`).
5. **Refund** — DF4 path: forced last-leg failure → one retry → `refunded` (script
   or show event log).
6. **Offline fallback** — if testnet is down: `npm run demo:offline` (mock only);
   say so in the pitch.

Browser DF2 / DF3 / DF5 evidence (real loopback API via Vite proxy, not Playwright
fixtures): screenshots under `scripts/demo/evidence/browser/` and the markdown
linked below.

## Tested commit and evidence

| Item | Value |
| --- | --- |
| Integrated tip | **`92f8cc1`** (D1/D2 + CCR-11 evidence + FX fix; includes `ab0e60a`) |
| Acceptance write-up | [`scripts/demo/evidence/2026-10-23-d1-d2-final-acceptance.md`](../scripts/demo/evidence/2026-10-23-d1-d2-final-acceptance.md) |
| CCR-15 mock recovery | [`scripts/demo/evidence/2026-10-23-ccr15-recovery-c859c92.md`](../scripts/demo/evidence/2026-10-23-ccr15-recovery-c859c92.md) |
| CCR-11 Stellar restart | [`scripts/demo/evidence/2026-10-23-ccr11-restart-stellar.md`](../scripts/demo/evidence/2026-10-23-ccr11-restart-stellar.md) (code `939a2f9`) |

D1 DF1–DF5 **PASS** on mock and Stellar; D2 seed/replay/offline **PASS**; browser
DF2/DF3/DF5 **PASS** (mock offline); CCR-11 Stellar restart **PASS**. Earlier D1/D2
and browser evidence is preserved. Scripts originally recorded HEAD `b48bfe3`
plus an uncommitted patch whose `*.ts` hash is preserved in the D1/D2 commits.

## Remaining verification gaps (honest)

| Gap | Status |
| --- | --- |
| **CCR-11 claim restart (Stellar)** | **PASS** — payout 39 + lock survived API restart (same DB/seal); UI accept; RPC-verified release to Worker A; no second fund/lock. Evidence: `scripts/demo/evidence/2026-10-23-ccr11-restart-stellar.md`. Tested code **`939a2f9`**. Different-seal-key negative control **NOT RUN**. |
| **CCR-11 claim restart (mock)** | Still fails release after restart (in-memory mock vault). Not required once Stellar restart PASS is recorded. |
| **Stellar fee-drift / CCR-15** | Mock **PASS**; testnet recovery **NOT VERIFIED** |
| **Local Vite proxy** | Dev-only sandbox Bearer injection — **not** deployed authentication |
| Independent RPC decode | DF3/DF4 only in the recorded run; DF1/DF2 rely on API/events |
| Settle-leg status after vault refund | Undefined; DF4 does not assert it |
| DF5 refusal code | No stable code; meaning asserted from `reasons[]` |
| Event features (anchor, passkey) | **Not started** before Sun 25 Oct 11:30 — planned event work, not Scale entry requirements |
| Tags `arrival` / `submission` | **Not created yet** — only `qualifier-v1` exists; do not mint early |

## Mounted routes (`92f8cc1`)

`healthz`, corridors, recipients, endpoints, batches, quotes, payments
(list/get/fund/cancel), events, claims get/accept, sandbox fail-next /
provider-health / advance-time / reset.
