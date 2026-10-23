# CC2/CC3 stack test — 23 October 2026 (branch, disposable)

**Integrator note (post-merge):** Freebuff evidence retained. Node-24
`vault-client.js` resolution is fixed on main by aligning
`@flexipay/adapter-stellar` relative imports to `.ts` (same as domain).
Endpoints/batches and orphan lock-on-fee-drift remain blockers.


**Status: BLOCKED.** The available CC2/CC3 stack boots and serves routes, but no
DF flow can start: `POST /v1/endpoints` (and batches) is not mounted. Nothing
here is acceptance on merged `main`; results are from a disposable worktree.

## Tested stack

| Part                                     | Ref                        |
| ---------------------------------------- | -------------------------- |
| PR #32 `csaba-cursor/CC2-orchestrator`   | `3bf2e31` (base `b3d77a7`) |
| PR #39 `csaba-cursor/CC3a-payments-api`  | `f8cdeba` (base `e6429fe`) |
| PR #41 `csaba-cursor/CC3b-claim-sandbox` | `4418b89` (base `e6429fe`) |
| merged `main` at test time               | `4189fd5`                  |

`f8cdeba` descends from the older CC2 tip `2e50f43`, not from `3bf2e31`, so the
fund fix and the routes were joined in a disposable branch:

- `/tmp/fp-cc3-stack`, branch `d3-stack-test`
- `23b90fa` — merge of `3bf2e31` onto `4418b89` (clean, no conflicts)
- `c49ce67` — merge of `4189fd5` (current lane-D/D2 scripts) onto `23b90fa`
  (clean)
- **tested commit: `c49ce67`** (no API/domain code changed by the second merge)

No branch was rewritten, no existing worktree touched, nothing pushed or merged.

## Runtime

Documented start does not work on Node 24:

```
npm run dev --workspace @flexipay/api
→ ERR_MODULE_NOT_FOUND
  packages/adapter-stellar/src/vault-client.js (imported from src/index.ts)
```

`apps/api/src/settlement.ts` imports `@flexipay/adapter-stellar` eagerly; that
package ships `.ts` files with `.js` specifiers, which Node's type stripping
does not rewrite. The same import exists on `main` (`4189fd5`), so this predates
the CC2/CC3 branches. For this run only, the API was started with a test-only
loader that maps existing `.js` specifiers to sibling `.ts` files (no repo
change):

- embedded Postgres `54329` (persistent dir under the worktree), migrations
  `20261022185818_init` + `20261023151500_ccr_11_14` applied
- `FP_SETTLEMENT=mock`, `FP_CLAIM_SEAL_KEY` generated locally, `PORT=3199`
- one demo org and sandbox API key provisioned directly in the disposable DB
  (the API has no key-creation route); the key value is not recorded here
- `GET /healthz` → 200

## Executed

| Command                                                                                               | Result                                                                                        |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `node scripts/seed/seed.ts`                                                                           | **exit 2 BLOCKED** — reset 200, four recipients created, `GET /v1/endpoints` 404              |
| `node scripts/demo/df1-batch.ts`                                                                      | **exit 2 BLOCKED** — missing `POST /v1/endpoints`, `POST /v1/batches`, `GET /v1/batches/{id}` |
| `node scripts/demo/df2-one-off.ts`                                                                    | **exit 2 BLOCKED** — missing `POST /v1/endpoints`                                             |
| `node scripts/demo/df3-claim.ts`                                                                      | **exit 2 BLOCKED** — missing `POST /v1/endpoints`                                             |
| `node scripts/demo/df4-failure.ts`                                                                    | **exit 2 BLOCKED** — missing `POST /v1/endpoints`                                             |
| `node scripts/demo/df5-za-company.ts`                                                                 | **exit 2 BLOCKED** — missing `POST /v1/endpoints`                                             |
| `npx vitest run test/orchestrator.test.ts test/cc3a-payments.test.ts test/cc3b-claim-sandbox.test.ts` | **12 passed** (3 files)                                                                       |
| `POST /v1/quotes` (PH bank, 25000 USD, PayerPays)                                                     | **201** — 5-leg route, frozen `flexiPayFee` 24567633 USDC, `simulated: true`                  |

Run artefacts (JSON per flow, commit + exit code + blockers) are outside the
repo at `/tmp/fp-cc3-evidence`; they contain no key, token or account detail.

## Known defects

| Defect                         | State                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| RecipientPays funds P only     | fixed in `3bf2e31` and asserted by `CCR-13` orchestrator test; **not** exercised over HTTP |
| PayerPays funds P + frozen fee | same commit/test; **not** exercised over HTTP                                              |
| `locked.fee` equals quoted fee | runtime throw in `executeSettle`; unit test passes; **not** exercised over HTTP            |

The three remain open as acceptance items because every flow needs the endpoint
route before a payment can be created.

## Blocker

`POST/GET /v1/endpoints` and `POST/GET /v1/batches` have no A0 request/response
contract (PR #41 says so explicitly); seed and DF1–DF5 all stop there. Owner:
Csaba (A0/CC3b). The Node-24 start failure is a separate API wiring defect
(owner: CC3/SC2 integration).

Mock claim acceptance never ran, so the restart check (same DB and seal key) and
online DF3 on Stellar were not executed.
