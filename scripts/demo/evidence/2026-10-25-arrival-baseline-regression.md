# Arrival-baseline regression report — H3 branch

**Result: PASS (no regression detected)** for the checks executed on
`event/csenge-freebuff/h3-df1-df2` at `abee07b`. Existing arrival evidence is
reused only where the tested implementation is unchanged; freshly executed
checks are listed separately.

| Item              | Value                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------- |
| Expected baseline | `9d9c039`                                                                             |
| Arrival tag       | local and remote `arrival` = `9d9c039`; not moved                                     |
| Current `main`    | `abee07b`                                                                             |
| Docs-only delta   | `9d9c039..abee07b` changes only `README.md`, `docs/DEV_PLAN.md`, `docs/EVENT_PLAN.md` |
| Tested tree       | `abee07b` plus H3 demo/test changes on the task branch                                |
| Runtime           | Node `24.21.0`, npm `11.12.1`, macOS arm64                                            |

The H3 branch does not edit `apps/api`, `apps/web`, `packages/adapter-stellar`,
`packages/adapters-sim`, `packages/domain`, `packages/web-lib`, the Prisma
schema or the contract. All changed source files are under `scripts/demo` and
`tests/e2e`.

## Freshly executed on 25 October 2026

| Check                                            | When (UTC) | Result             | Notes                           |
| ------------------------------------------------ | ---------- | ------------------ | ------------------------------- |
| `npm test --workspace @flexipay/api`             | `11:45`    | PASS 50/50         | 9 files                         |
| `npm test --workspace @flexipay/domain`          | `11:45`    | PASS 72/72         | 5 files                         |
| `npm test --workspace @flexipay/adapters-sim`    | `11:45`    | PASS 85/85         | 10 files                        |
| `npm test --workspace @flexipay/adapter-stellar` | `11:45`    | PASS 17, skipped 5 | testnet tests opt-in            |
| `npx vitest run tests/e2e/*.test.ts`             | `11:45`    | PASS 78/78         | includes 22 Stellar-proof tests |
| `npm run typecheck --workspaces --if-present`    | `11:43`    | PASS               | all workspaces                  |
| `npx tsc -p scripts/demo/tsconfig.json`          | `11:45`    | PASS               | demo scripts                    |
| `npx prettier --check` changed files             | `11:45`    | PASS               | 7 files                         |
| `git diff --check`                               | `11:45`    | PASS               | no whitespace errors            |

Live H3 checks on the unchanged baseline vault:

| Flow                   | When (UTC)            | Result                                   |
| ---------------------- | --------------------- | ---------------------------------------- |
| DF2 one-off PH bank    | `11:29:23`–`11:29:38` | PASS, decoded lock/release/transfer      |
| DF1 three-worker batch | `11:37:01`–`11:37:43` | PASS, two cross-border locks, no US lock |
| DF1 first attempt      | `11:30:59`–`11:31:29` | FAIL, client timeout at 30 s; excluded   |

The first DF1 attempt is recorded as a harness failure, not a product assertion
failure. The API completed both payments after the client timed out; the clean
rerun at a 90 s client timeout is the acceptance run. Details are in
`2026-10-25-h3-df1-df2-stellar.md`.

## Reused arrival evidence

These checks were not rerun. They ran at the arrival baseline on code that this
branch does not modify.

| Area                                | Evidence                                 | Reused because                                                |
| ----------------------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| DF1–DF5 mock and Stellar acceptance | `2026-10-23-d1-d2-final-acceptance.md`   | no API, adapter, domain, web or contract change               |
| DF3/DF4 decoded chain proof         | `2026-10-23-d1-d2-final-acceptance.md`   | adapter and demo decoder inputs unchanged except H3 additions |
| CCR-11 restart on Stellar           | `2026-10-23-ccr11-restart-stellar.md`    | no API, DB schema, seal or web change                         |
| UI suite 34/34                      | `2026-10-23-d1-d2-final-acceptance.md`   | no web or UI test change                                      |
| Seed/reset and offline launcher     | `2026-10-23-d1-d2-final-acceptance.md`   | seed code unchanged                                           |
| DF4/DF5 evidence                    | `df4-*.json`, `df5-*.json` (git-ignored) | no route, provider or pricing change                          |

The H3 branch also replayed the CCR-11 lock/release read-only through the new
decoder. That is a decoder cross-check, not a new restart acceptance.

## Why these fresh runs are sufficient for H3

H3 changes only the demo-side proof library and the DF1/DF2/DF3 call sites. It
does not alter the API, orchestrator, settlement adapter, web UI or contract.
The relevant regression surface is therefore:

1. the demo library's typecheck and unit/e2e tests;
2. the API/domain/simulator/Stellar adapter test suites that own the data H3
   consumes;
3. live DF1 and DF2 against the baseline vault, including the decoded chain
   evidence.

All three passed. A full UI, mock DF1–DF5 and restart rerun would add runtime
without exercising H3 or any changed file; they remain valid arrival evidence
until API/web/adapter code changes.

## Isolation and environment

- API: `http://127.0.0.1:3211`, fresh embedded Postgres on `54329`.
- Settlement: `FP_SETTLEMENT=stellar`; baseline
  `scripts/testnet/testnet-ids.env`.
- Vault: `CCG232ACW63XVUQGMMA6SWV46W2HIVR2ZSB5ENXHOIIITQBXUBHHIUMN`.
- Asset: `CCZAEMZPSOOZLAZTN3KQVLXYVMJGEI7BDRVNMRM5TSQTHTX4EITONUGT`.
- The API used a local, git-ignored secrets copy and a fresh seal key. Neither
  is recorded.
- No concurrent E1 payer transaction overlapped the H3 windows.
- No push, merge or deployment was performed during the run.

## Gaps

- DF7 is not run; it needs the agreed API/UI contract and Cursor's anchor
  lifecycle.
- Stellar fee-drift recovery remains **NOT VERIFIED**.
- H3 acceptance covers first-attempt `PayerPays` DF1/DF2 only.
- Testnet settlement does not prove fiat bank receipt.
