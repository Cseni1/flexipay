# D3 acceptance evidence — 23 October 2026

Lane-D worktree `/Users/csenike/Projects/FlexiPay/flexipay-laned`, branch
`csenge-freebuff/D3-acceptance`, rebased onto current `main` **`0f7ca41`**.
Tested lane-D commit: **`05739cc`** (`Strengthen lane-D acceptance evidence for
DF3-DF5`). This file is committed after the run; per-run JSON records the tested
commit.

D2 #27 is integrated into `main`. This worktree did not edit D2-owned files:
`scripts/demo/offline.ts`, `scripts/seed/**` (except the lane-D fixture
`scripts/seed/fixtures/flows.json`, which D2 #27 does not own) and
`tests/e2e/{offline,seed}.test.ts`.

## Checks

| Command                                                                                 | Exit | Result                                                              |
| --------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------- |
| `npx tsc -p scripts/demo/tsconfig.json`                                                 | 0    | clean                                                               |
| `npx vitest run tests/e2e/*.test.ts`                                                    | 0    | **50 passed** (harness 21, stellar 15, preflight 6, offline 4, seed 4) |
| `npx prettier --check "scripts/demo/**/*.ts" "scripts/seed/**/*.json" "tests/e2e/*.ts"` | 0    | clean                                                               |
| `bash scripts/check-separation.sh`                                                      | 0    | passed                                                              |
| `git diff --check`                                                                      | 0    | clean                                                               |
| `FP_API_PORT=8792 FP_WEB_PORT=5174 npm run demo:offline -- --print-plan`                | 0    | loopback plan, mock settlement, no key in the plan                  |
| `FP_API_PORT=8792 FP_WEB_PORT=5174 npm run demo:offline -- --no-seed`                   | —    | API `/healthz` 200 and Vite 200; both servers stayed up             |
| `FP_API_KEY=… FP_API_PORT=8792 FP_WEB_PORT=5174 npm run demo:offline`                   | —    | same startup, then seed ran and was **BLOCKED**; servers stayed up  |
| `sandbox-exec` probe (`deny network-outbound`, allow `localhost:*`)                      | 0    | loopback 200; `https://example.com` denied                          |
| `node scripts/seed/seed.ts reset` (sandboxed)                                           | 2    | **BLOCKED** — `POST /v1/sandbox/reset` is not mounted               |
| `node scripts/seed/seed.ts` (sandboxed)                                                 | 2    | **BLOCKED** — same reset route; no fixtures created                 |
| `node scripts/demo/run-all.ts` (sandboxed)                                              | 2    | DF1–DF5 mock **BLOCKED** in route preflight                          |
| `node scripts/demo/df3-claim.ts --mode stellar` (sandboxed)                             | 2    | **BLOCKED** — routes plus missing chain inputs                      |

The offline run used ports 8792/5174 because the integration worktree owns 8788.
The root `demo:offline` command was exercised twice: without a key (`--no-seed`)
and with `FP_API_KEY` set, which reached `/v1/sandbox/reset` and reported
BLOCKED while leaving both servers up. It was then stopped through the
launcher's SIGTERM path; ports 8792, 5174 and 54329 were free afterwards.

The seed runs used a local Demo Platform organization and API key inserted
directly into this worktree's ephemeral embedded Postgres. There is still no API
route that creates an organization or key; the key was never printed, committed
or written to evidence.

Generated JSON evidence for the last runs records commit `05739cc` and is
git-ignored. A scan of those files found no `fp_test_` value.

## What changed in this step

- **DF4** — `assertExactlyTwoPayoutAttemptsThenRefund` now:
  - reads every `leg.failed` event's published `Event.snapshot` legs and takes
    the union of failed payout `externalRef` values on the routed provider;
  - requires exactly **two** distinct attempts, allows a cumulative snapshot,
    rejects a reused ref, a third ref in any snapshot, a third final payout leg,
    a successful payout in any snapshot, a refund before the failures and more
    than one `payment.refunded`;
  - requires the final payout legs to be failed, on the routed provider, and to
    have snapshot evidence. A snapshot without legs or a ref is **BLOCKED**;
  - if provider refs encode an attempt number, requires exactly attempts 1 and 2
    and rejects mixed numbered/unnumbered refs.
- **DF5** — `expectReasonExplaining` requires **one** reason string to match all
  of: crypto, the company recipient kind, and an exclusion phrase. Previously
  the patterns were matched across the joined list, so three unrelated fragments
  could pass. Both the eligible ZA bank quote and the 422 crypto refusal use the
  new check.
- **DF3 Stellar** — `verifyVaultRelease` still checks the lock is
  `create_payout` on `FP_PAYOUT_VAULT_ID` with external id
  `sha256("<payment id>:1")` and the release is `claim` of that payout id to
  `FP_RECIPIENT_A_ADDRESS`. It now also checks the release secret hashes to the
  lock's `claim_hash` argument, both transactions are in a ledger, and the
  release ledger is not before the lock ledger. The DF3 script also checks both
  references are 64-hex before asking the RPC.
- **A0 answers / README** — corrected the lock/release note: both transactions
  must be distinct and successful; a single shared hash is not a release proof.

## Runtime result

The integrated API at `05739cc` mounts only `/healthz`, `/v1/corridors` and
`/v1/recipients`. The DF flows stop in preflight; the seed stops at reset. The
missing routes are:

`POST /v1/endpoints`, `POST /v1/quotes`, `POST /v1/payments`,
`POST /v1/payments/{id}/fund`, `GET /v1/payments/{id}`, `GET /v1/events`,
`GET /v1/claims/{token}`, `POST /v1/claims/{token}/accept`,
`POST /v1/sandbox/fail-next`, `POST /v1/sandbox/reset`, `POST /v1/batches`,
`GET /v1/batches/{id}`.

No DF4, DF5 or DF3 assertion executed against the API. Their evidence rules are
covered by the 36 focused self-tests; that is not flow acceptance.

## Blockers

| Blocker                                                                                                                                                            | Owner                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| CC3a/CC3b routes above are not mounted, including `/v1/sandbox/reset`                                                                                              | Csaba (CC3a/CC3b)                  |
| CC2 must publish `Event.snapshot` legs including each failed payout `externalRef`; DF3 also needs the pre-accept settle `externalRef`                              | Csaba (CC2)                        |
| Stellar acceptance needs the routes, `FP_PAYOUT_VAULT_ID`, RPC URL/passphrase and Worker A's address, then a real testnet run; static/replay proof is not settlement | caller / Csaba (integration) + SC2 |
| The settle leg's status after a vault refund is still undefined; DF4 does not assert it                                                                            | CC2 / A0                           |

## D2 handoff

D2 #27 is integrated. The root `demo:offline` command started embedded Postgres,
the API and Vite with mock settlement, and both readiness probes returned 200.
With `--no-seed`, startup did not require a key. Reset and seed remain blocked on
the missing `/v1/sandbox/reset`, so the external-network-denied replay is
recorded as **BLOCKED**, not PASS. No D2 file was edited or duplicated.

## Next run

1. Land `POST /v1/endpoints`, `/v1/sandbox/reset` and the CC2 orchestrator, then
   rerun seed/reset and DF1–DF5 offline with external networking denied.
2. Confirm the DF4 event snapshots carry the two failed payout refs; then the
   exact-two assertion can PASS instead of BLOCK.
3. Run DF3 Stellar online with the vault id, RPC, passphrase and Worker A
   address; keep the generated evidence and confirm the lock and release are
   distinct successful transactions.
