# D3 acceptance evidence — 23 October 2026

Lane-D worktree `/Users/csenike/Projects/FlexiPay/flexipay-laned`, branch
`csenge-freebuff/D3-acceptance`. Base `main` under test: **`8ce753c`**. Lane-D
commit: **`391ea4d`**.

D2 #27 owns `scripts/demo/offline.ts`, `scripts/seed/**` and
`tests/e2e/{offline,seed}.test.ts`; this worktree did not edit those files. The
only `scripts/seed` change is `scripts/seed/fixtures/flows.json`, which D2 #27
does not touch.

## Checks

| Command                                                                                 | Exit | Result                                              |
| --------------------------------------------------------------------------------------- | ---- | --------------------------------------------------- |
| `npm ci --no-audit --no-fund`                                                           | 0    | 1018 packages installed                             |
| `npm run db:generate --workspace @flexipay/api`                                         | 0    | Prisma client generated for the new worktree        |
| `npx tsc -p scripts/demo/tsconfig.json`                                                 | 0    | clean                                               |
| `npx vitest run tests/e2e/*.test.ts`                                                    | 0    | **35 passed** (harness 16, stellar 13, preflight 6) |
| `npm test --workspace @flexipay/domain`                                                 | 0    | **68 passed**                                       |
| `npx prettier --check "scripts/demo/**/*.ts" "scripts/seed/**/*.json" "tests/e2e/*.ts"` | 0    | clean                                               |
| `bash scripts/check-separation.sh`                                                      | 0    | passed                                              |
| `git diff --check`                                                                      | 0    | clean                                               |
| `GET /healthz` on `:8790`                                                               | 200  | `{"status":"ok"}`                                   |
| `node scripts/demo/run-all.ts`                                                          | 2    | DF1–DF5 mock **BLOCKED**                            |
| `node scripts/demo/df3-claim.ts --mode stellar`                                         | 2    | **BLOCKED**                                         |
| `node -e` root `demo:offline` check                                                     | 2    | script **absent** on current `main`                 |

The generated JSON evidence for the last two runs records commit `391ea4d`; the
files are git-ignored. No API key, secret, claim token or full address is
stored.

## What changed

- **DF4** — `assertExactlyTwoPayoutAttemptsThenRefund` uses the published
  `Event.snapshot` legs, not the fixture fail count. It requires exactly two
  `leg.failed` events whose snapshots carry a failed payout leg on the routed
  provider with **distinct `Leg.externalRef` values** (attempt 1 and retry 2
  when the provider reference encodes them), followed by `payment.refunded`, no
  `payment.paid`, no later `leg.failed`, and no successful payout leg. A missing
  snapshot, legs array or `externalRef` is **BLOCKED**, not PASS.
- **DF5** — both the eligible ZA bank quote and the 422 crypto refusal must
  carry a reason matching crypto, the company recipient kind, and an exclusion
  phrase. A non-empty generic reason now fails.
- **DF3 Stellar** — `verifyVaultRelease` checks both transactions from RPC:
  - the lock invokes `create_payout` on `FP_PAYOUT_VAULT_ID`, with external id
    `sha256("<payment id>:1")`, and its result meta returns payout id P;
  - the release invokes `claim(P, …, recipient)` on the same vault, paying
    `FP_RECIPIENT_A_ADDRESS`;
  - both are `SUCCESS`, distinct hashes, on the configured testnet passphrase. A
    missing pre-accept lock reference is **BLOCKED**; a successful but unrelated
    hash fails.
- **Route preflight** — OpenAPI publishes A0 stubs that CC3 has not mounted. An
  `OPTIONS` probe now distinguishes a mounted route (200) from a stub (catch-all
  404), so the flows report the real route dependency as BLOCKED instead of
  reaching a 404.
- **feeMode** — every demo quote sends an explicit `PayerPays` from
  `scripts/seed/fixtures/flows.json`; `QuoteInput.feeMode` has no default and a
  missing fixture value is rejected. Settle quotes must echo the requested mode;
  no-settle quotes must echo `null` (CCR-8).

## Runtime result

The integrated API at `8ce753c` mounts only `/healthz`, `/v1/corridors` and
`/v1/recipients`. All DF flows stop in preflight. The current missing routes
are:

`POST /v1/endpoints`, `POST /v1/quotes`, `POST /v1/payments`,
`POST /v1/payments/{id}/fund`, `GET /v1/payments/{id}`, `GET /v1/events`,
`GET /v1/claims/{token}`, `POST /v1/claims/{token}/accept`,
`POST /v1/sandbox/fail-next`, `POST /v1/batches`, `GET /v1/batches/{id}`.

DF1–DF5 therefore remain **NOT VERIFIED**. No DF4, DF5 or DF3 assertion executed
against the API; their evidence rules are covered by self-tests only.

## Blockers

| Blocker                                                                                                                                      | Owner                              |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| CC3a/CC3b routes above are not mounted                                                                                                       | Csaba (CC3a/CC3b)                  |
| CC2 must publish `Event.snapshot` legs including the failed payout `externalRef`; it must expose the pre-accept settle `externalRef` for DF3 | Csaba (CC2)                        |
| D2 #27 is not on `main`; root `npm run demo:offline` is absent                                                                               | Cursor (D2 integration)            |
| Stellar acceptance needs the real routes and a testnet run; static/replay proof is not a settlement                                          | caller / Csaba (integration) + SC2 |

## D2 handoff

`csenge-cursor/integrate-d2` contains root
`"demo:offline": "node scripts/demo/offline.ts"`. Current `main` does not. It
was therefore not executed here; reset/replay under external network isolation
remains **BLOCKED** until D2 #27 is integrated. No D2 file was edited or
duplicated.

## Next run

1. Integrate D2 #27, then verify `npm run demo:offline`, `seed reset`, seed and
   replay with external networking denied.
2. Land `POST /v1/endpoints` and the CC2 orchestrator, then rerun DF1–DF5 mock.
3. Confirm the DF4 event snapshot carries the two failed payout refs; then the
   exact-two assertion can PASS instead of BLOCK.
4. Run DF3 Stellar online with `FP_PAYOUT_VAULT_ID`, RPC, passphrase and Worker
   A address; keep the generated evidence.
