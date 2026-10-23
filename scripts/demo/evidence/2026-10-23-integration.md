# Integration evidence — 23 October 2026

Integrator worktree: `flexipay-integrate` / branch `csenge-cursor/integrate-2026-10-23`.  
Final `main`: **`7517424`** (`Merge pull request #22`).

## Merged PRs (merge commits)

| PR | Title | Merge commit |
| --- | --- | --- |
| #18 | A0 API contract | `f985cee` |
| #19 | SC2 Stellar adapter | `0547047` |
| #21 | CF0 web shell | `cea28ee` |
| #20 | D1 demo scripts | `1bc3e6e` |
| #22 | FP_SETTLEMENT wiring + D1↔A0 binding | `7517424` |

## Checks at 7517424

| Command | Result |
| --- | --- |
| `npm test --workspace @flexipay/domain` | 45 passed |
| `npm test --workspace @flexipay/adapter-stellar` | 16 passed (testnet skipped offline) |
| `npm test --workspace @flexipay/api -- settlement-factory openapi` | 10 passed |
| `npx vitest run tests/e2e/*.test.ts` | 19 passed |
| `npm run build --workspace @flexipay/web` | pass |
| `bash scripts/check-separation.sh` | pass |
| `npm test --workspace @flexipay/api` (embedded Postgres) | **BLOCKED** — dyld missing `libicudata.77.dylib` |
| `npm run demo:offline` | **NOT PRESENT** (D2 not started) |
| `node scripts/demo/run-all.ts` (mock) | DF1–DF5 **BLOCKED** (API down + missing CC3 routes) |
| `df3-claim.ts --mode stellar` | **BLOCKED** (same) |
| Playwright CF0 / smoke | after one `playwright install` retry — see run log |

## A0 questions (closed without new fields)

See `scripts/demo/lib/a0-answers.ts`.

## Overall

**NOT COMPLETE / PARTIALLY VERIFIED.** Weakest mandatory criteria: DF1–DF5 acceptance, DF3 Stellar vault release, offline launch — all **BLOCKED/NOT VERIFIED** pending CC1–CC3 and local Postgres.

## Next exact task

Implement **CC1 route selection → CC2 orchestrator → CC3a/CC3b routes** (including `POST /v1/endpoints` and batches), then re-run DF1–DF5 mock, DF3 stellar with RPC proof, and add `demo:offline` (D2).
