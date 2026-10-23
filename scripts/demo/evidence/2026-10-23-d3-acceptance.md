# D3 acceptance evidence — 23 October 2026 (CCR-11–14 reconciliation)

Lane-D worktree `/Users/csenike/Projects/FlexiPay/flexipay-laned`, branch
`csenge-freebuff/D3-acceptance`. The branch is merged with `origin/main` at
**`e6429fe`**, which carries the CCR-11–14 contracts from #36 (`b3d77a7`); the
tested tree is commit **`9e38c9c`** (this evidence commit follows it). This file
is committed after the run; per-run JSON records the tested commit.

D2 #27 stays integrated. This worktree did not edit D2-owned files:
`scripts/demo/offline.ts`, `scripts/seed/**` (except the lane-D fixture
`scripts/seed/fixtures/`), `tests/e2e/{offline,seed}.test.ts`. No API, contract,
Prisma or adapter source was changed.

## Contracts read and applied

Read from `origin/main`:
`packages/domain/src/api/{common,quotes,payments,claims,events}.ts`,
`openapi-stubs.ts`, `apps/api/openapi.json`, `docs/CONTRACT_CHANGES.md`
(CCR-11–14), `apps/api/prisma/schema.prisma` (`ClaimLink`, `Leg`).

- **CCR-12** — `Leg.externalRef` on a settle leg is the vault `payoutId`
  (positive decimal); `lockTxRef` and `releaseTxRef` are separate nullable
  hashes. Provider refs stay provider refs.
- **CCR-13** — every `PlannedLeg` has frozen `amountIn`/`amountOut`;
  `FeeBreakdown.settleUnlockedRemainder` is money or null; `Quote.feeMode` is
  nullable and copied unchanged. PayerPays principal is
  `P = floor(A * 10000 / (10000 + bps))`.
- **CCR-14** — `Leg.attempt` is durable; one retry keeps `processing`,
  increments attempt to 2, may clear provider/settle refs, and attempt 3 is
  forbidden.
- **CCR-11** — claim secret sealed at rest (`FP_CLAIM_SEAL_KEY`,
  `secretSealed`/`secretSealedNonce`, `vaultClaimHashHex`); never returned by
  the API.
- **Claim routes** — `GET /v1/claims/{token}` and
  `POST /v1/claims/{token}/accept` (ARCHITECTURE §10 and `openapi-stubs.ts`);
  accept body `{ endpoint }`, response `{ claim, paymentId, paymentStatus }`,
  view field `allowedDestinationTypes`.

## What changed in lane D

- **DF3** — `settle.externalRef` is read as the payoutId before and after
  acceptance and must not change. `lockTxRef`/`releaseTxRef` are required for
  the chain proof. `verifyVaultRelease` now also checks CCR-13: lock principal =
  quoted settle `amountIn`, lock `feeMode` = quote,
  `fee = floor(P * bps / 10000)`, release net = `P` or `P - f(P)`, and release
  return value. A new `expectPayerPaysSizing` checks
  `P = floor(A * 10000 / (10000 + bps))` from the leg before settle. The claim
  accept call now uses the published `POST /v1/claims/{token}/accept` path.
- **DF4** — `assertExactlyTwoPayoutAttemptsThenRefund` reads durable
  `Leg.attempt` from every `Event.snapshot` leg. It requires attempts 1 and 2,
  rejects attempt 3 anywhere, allows cumulative snapshots, and no longer needs
  distinct provider refs: repeated or cleared refs pass. A payout without
  `attempt`, or a `leg.failed` without snapshot legs, fails acceptance as a
  contract defect instead of being inferred or reported as a missing route.
- **DF5** — `expectReasons` matches the meaning across all `reasons[]` items
  (crypto, company kind, exclusion). Fragmented reasons are accepted; empty or
  generic prose fails. Harness cases prove both directions.
- **Preflight** — OPTIONS alone no longer decides a route is mounted. The probe
  reads the `Allow` header: catch-all 404 + no Allow + `code: not_found` is
  missing; Allow without the needed method is a separate method mismatch; 401,
  403, 405, 5xx, application-level 404s and proxy answers without Allow are
  treated as mounted so auth/method/application defects surface as FAIL, not as
  a missing-route BLOCKED.
- **Tests** — harness self-tests rewritten for `attempt`-based DF4 evidence (no
  distinct-ref assumption), plus new CCR-12 (`payoutId`) and CCR-13 (frozen
  amounts, fee modes, remainder, sizing) cases; preflight tests cover the new
  classification.

## Checks

| Command                                                                           | Exit | Result                                                                            |
| --------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------- |
| `npx tsc -p scripts/demo/tsconfig.json`                                           | 0    | clean                                                                             |
| `npx vitest run tests/e2e/{harness,preflight,stellar-proof,offline,seed}.test.ts` | 0    | **67 passed** (harness 29, stellar 18, preflight 12, offline 4, seed 4)           |
| `npx prettier --check "scripts/demo/**/*.ts" "tests/e2e/*.ts"`                    | 0    | clean                                                                             |
| `git diff --check`                                                                | 0    | clean                                                                             |
| RPC `getNetwork` on `soroban-testnet.stellar.org`                                 | 0    | HTTP 200, passphrase `Test SDF Network ; September 2015` (outbound network works) |
| `OPTIONS` on the eight DF routes at `http://127.0.0.1:8788`                       | —    | 404, no `Allow` header: only the catch-all answered                               |
| `node scripts/demo/df3-claim.ts --mode stellar` (online local API)                | 2    | **BLOCKED** on eight unmounted routes; never reached the RPC                      |
| `node scripts/demo/run-all.ts` (mock)                                             | 2    | DF1–DF5 **BLOCKED** in route preflight                                            |

The DF3 Stellar attempt used the public testnet values from
`scripts/testnet/testnet-ids.env` (RPC, passphrase, vault id, 100 bps, Worker A
address) and a clearly non-secret placeholder in `FP_API_KEY`. It stopped at
route preflight, so no authenticated request, quote or chain call was made. The
live API was left running; it was not restarted or modified.

## Runtime result

The integrated API at `http://127.0.0.1:8788` (PID 65994 at the time) answers
`/healthz` 200 and mounts `/healthz`, `/v1/corridors`, `/v1/recipients` only.
Every DF route below returns the catch-all 404 with no `Allow` header:

`POST /v1/endpoints`, `POST /v1/quotes`, `POST /v1/payments`,
`POST /v1/payments/{id}/fund`, `GET /v1/payments/{id}`, `GET /v1/events`,
`GET /v1/claims/{token}`, `POST /v1/claims/{token}/accept`,
`POST /v1/sandbox/fail-next`, `POST /v1/batches`, `GET /v1/batches/{id}`.

No DF assertion executed against the API. The 67 self-tests prove the acceptance
rules and their failure modes; they are not flow acceptance.

## CCR-11 restart acceptance — prepared, not run

Uses the same database and the same seal key; never asks the API to reveal a
secret.

1. Start with a persistent data directory and `FP_CLAIM_SEAL_KEY` set. Create
   and fund a `claim_link` payment; the settle leg locks (`externalRef` =
   payoutId, `lockTxRef` set, payment not paid). Record payment id, payoutId and
   hashes privately.
2. Stop the API (SIGTERM); keep or restart the database from the same data
   directory.
3. Start the API with the same `DATABASE_URL` and `FP_CLAIM_SEAL_KEY`.
4. Re-open the original claim URL: the view must still be `open` with the same
   amount and the payment still waiting (token hash and sealed secret survived).
5. Accept: paid, same payoutId, successful `releaseTxRef`, no payout leg. Verify
   privately from chain data that `claim` used that payoutId, paid the intended
   address and hashed to the lock's claim hash.
6. Negative control: restart with a different seal key; acceptance must fail
   without releasing (no `releaseTxRef`, not paid) and must not expose the
   secret.

Evidence keeps ids, hashes, statuses and masked addresses only: no claim token,
secret, API key or full address. Blocked until CC2 persists the seal and CC3
mounts accept.

## Blockers

| Blocker                                                                                                                                               | Owner                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| CC3a/CC3b routes above are not mounted (including claim accept and sandbox reset)                                                                     | Csaba (CC3a/CC3b)                  |
| CC2 must persist `secretSealed`/`vaultClaimHashHex`, write `lockTxRef`/`releaseTxRef`, set `Leg.attempt`, and publish `Event.snapshot` legs with them | Csaba (CC2)                        |
| CC1 must price PayerPays with `P = floor(A * 10000 / (10000 + bps))` and copy frozen quote amounts into payment legs                                  | Csaba (CC1)                        |
| Stellar acceptance needs the routes, an API key and the vault/RPC/address values; the RPC itself is reachable                                         | caller / Csaba (integration) + SC2 |
| The settle leg's status after a vault refund is still undefined; DF4 does not assert it                                                               | CC2 / A0                           |
| CCR-11 restart run needs CC2 seal persistence and the accept route                                                                                    | CC2 / CC3                          |

## Next run

1. Mount endpoints/quotes/payments/fund/read/events/claims/accept and sandbox
   controls, then rerun seed and DF1–DF5 mock.
2. Rerun DF4 and confirm `Event.snapshot` legs carry `attempt` 1 and 2 and
   `payment.refunded`; refs may be cleared.
3. Run DF3 Stellar with a real key and the published vault/RPC/address; keep the
   lock and release evidence, verify `releaseTxRef` and net `P`.
4. Run the CCR-11 restart steps with the same database and seal key, plus the
   wrong-key negative control.
