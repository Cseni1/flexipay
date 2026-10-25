# H3 decoded RPC evidence — DF1 and DF2

**Result: PASS** for H3 on DF1 and DF2 against the unchanged baseline testnet
vault. Each cross-border settlement was decoded independently from Stellar RPC
and tied to the paid payment, frozen quote, vault, asset, amount, operation and
recipient. The domestic DF1 row was proved to have no vault payout and no settle
leg.

DF2 produced the first H3 result: **PASS** at `2026-10-25T11:29:38.424Z`. DF1
produced **PASS** at `2026-10-25T11:37:43.797Z`.

| Item                  | Value                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| Base commit           | `abee07b` (`main`; docs-only changes after arrival `9d9c039`)                                               |
| H3 source commit      | `b9409ce` (the run printed `abee07b` because the H3 changes were uncommitted)                               |
| Arrival baseline      | `9d9c039`; local and remote tag `arrival` still point there                                                 |
| Branch                | `event/csenge-freebuff/h3-df1-df2`                                                                          |
| Runtime               | Node `24.21.0`, npm `11.12.1`, macOS arm64                                                                  |
| API                   | `http://127.0.0.1:3211`, `FP_SETTLEMENT=stellar`, embedded Postgres `54329`, fresh database                 |
| Network               | Stellar testnet, passphrase checked through RPC `getNetwork`                                                |
| Vault                 | `CCG232ACW63XVUQGMMA6SWV46W2HIVR2ZSB5ENXHOIIITQBXUBHHIUMN`                                                  |
| Asset                 | `CCZAEMZPSOOZLAZTN3KQVLXYVMJGEI7BDRVNMRM5TSQTHTX4EITONUGT`                                                  |
| On-chain vault config | token = asset above; treasury = `GDH7WGAQJQUBQBYNN3SO4QWWWXRYR6GWQTM5BZ3RCGXFDCOI4QTUHHXR`; `fee_bps = 100` |
| Payer                 | `GA3VFDLARJMD7IBYZ2EW3SDQBAIASVSFLFKKBLCNI4D3KDMWDQJX6D6F`                                                  |
| Intended recipient    | Worker A `GAAN53RQP4YMHJCBSSPBRSX77HWEWHUL5AFOUSOJBNIKVR6VS63RPRX5`                                         |
| Frozen fee mode       | `PayerPays` for every H3 row                                                                                |

No claim token, claim secret, API key, JWT, signed envelope or database URL is
recorded here.

## What H3 verifies

The verifier is in `scripts/demo/lib/stellar-proof.ts`; the tests are in
`tests/e2e/stellar-proof.test.ts`.

For each paid cross-border row:

1. The API payment is `paid`, its settle leg is `succeeded` with attempt `1`,
   and its frozen settle `amountIn`/`amountOut` equal the reference quote's.
2. `getTransaction` returns `SUCCESS` for both the lock and release, with
   distinct hashes, envelopes and result metadata. `getNetwork` equals the
   configured testnet passphrase.
3. The lock envelope has exactly one `invokeHostFunction`; it invokes
   `create_payout` on the configured vault. Its external id is
   `sha256("<paymentId>:1")`, its principal and fee mode equal the frozen
   values, and its return value equals `settle.externalRef` (the payout id).
4. The release envelope invokes `claim` on the same vault with that payout id.
   `sha256(secret)` equals the lock's claim hash, and the destination argument
   is the configured Worker A address.
5. The release return value equals the frozen net. The release result metadata
   contains a token-transfer event for the vault's token, from the vault, to
   Worker A, for exactly that net. A missing transfer event is `BLOCKED`
   (`NOT VERIFIED`), never a pass; a transfer for another asset, destination or
   amount is `FAIL`.
6. The vault's `config()` token equals the published asset contract id. The
   frozen quote fee equals `floor(principal * on-chain fee_bps / 10_000)`, and
   the frozen net follows the fee mode. `FP_VAULT_FEE_BPS` is not used as the
   fee authority.

The domestic DF1 row has no settle leg, no `payment.onchain` event, and
`payout_by_external(payer, sha256("<paymentId>:1"))` returns no payout.

DF2 uses the quote that created the payment. The batch API returns payment IDs,
not a quote view, so DF1 uses a reference quote created immediately before the
batch for the expected fee and amount, plus the payment's own frozen settle
amounts and refs. H3 recomputes the fee and net from the principal and the
vault's on-chain `fee_bps`; a pricing drift between the reference quote and the
batch row therefore fails the check. The batch row's internal `quoteId` is not
read, because no `GET /v1/quotes/{id}` route exists.

## DF2 — one-off PH bank payment

Command (values supplied through the environment; none printed):

```
FP_SETTLEMENT=stellar FP_HTTP_TIMEOUT_MS=30000 node scripts/demo/df2-one-off.ts
```

| Item                  | Value                                                              |
| --------------------- | ------------------------------------------------------------------ |
| Payment               | `pay_640e944c65e729e954e2a30d`                                     |
| Payout id             | `40`                                                               |
| Lock                  | `3867769dca108303cc4536a1d906130b7ede6fd197d577d8638c4afe65936e42` |
| Release               | `80f9edef7bb266eb06211643b326857b449bcddc711c1dc95f571e60f4ca8e6a` |
| Principal / fee / net | `2456763366` / `24567633` / `2456763366` minor units               |
| Vault fee             | `100` bps, read from `config()`                                    |
| Release transfer      | vault → Worker A, asset above, `2456763366`                        |
| Result                | **PASS**                                                           |

The treasury received `24567633` in the same release metadata, in addition to
Worker A's net transfer. That transfer is not substituted for the recipient
proof.

## DF1 — three-worker batch

Command:

```
FP_SETTLEMENT=stellar FP_HTTP_TIMEOUT_MS=90000 node scripts/demo/df1-batch.ts
```

| Row         | Payment                        | Payout | Lock                                                               | Release                                                            |
| ----------- | ------------------------------ | ------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| PH e-wallet | `pay_91f29dc04b78614789ff462d` | `43`   | `61317d9ce7b4f8c4e29c48da252a61d4dd7e6229d96f64891700b6a89b408510` | `8f1fa240e6d68757aeb13de3ac665f133b76b0c970c472eb6f43fefc3bbf3a2c` |
| BR bank     | `pay_86bfd8a92b50deb2f52adc42` | `44`   | `54fcbf168ca75e9f2f4e6986465cd007a6ab53ca8b2661388086035f2729906a` | `199327040c0343ab2fa1cacdb50548280e3705ca10125e49b8babf6449db5a72` |
| US domestic | `pay_a5a41fb5509dcb3ec007c801` | none   | none                                                               | none                                                               |

| Row         | Principal    | Fee        | Net          | Recipient transfer          |
| ----------- | ------------ | ---------- | ------------ | --------------------------- |
| PH e-wallet | `1474077722` | `14740777` | `1474077722` | vault → Worker A, exact net |
| BR bank     | `1965371287` | `19653712` | `1965371287` | vault → Worker A, exact net |

Batch `bat_cc715abc466e5a26a7acae64` completed with all three rows paid. Both
cross-border rows emitted `payment.onchain`; the US row did not. The US
`payout_by_external` lookup returned no id. The batch therefore produced exactly
two vault locks and no domestic lock.

Result: **PASS**.

## Fee evidence

| Source                     | Value                                                                 | Use                                                     |
| -------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------- |
| Vault `config().fee_bps`   | `100`                                                                 | authority for the chain/fee check                       |
| Quote fee                  | `24567633` (DF2 quote), `14740777`, `19653712` (DF1 reference quotes) | compared with `floor(P * 100 / 10000)`                  |
| Process `FP_VAULT_FEE_BPS` | `100`                                                                 | adapter startup configuration only; not an H3 authority |

There was **no mismatch** between the frozen quote fee, the on-chain vault fee
and the decoded amounts. The deployed vault configuration was not changed.

## Shared-payer window

H3 sends transactions only from the shared baseline payer. Cursor's E1 run had
no payer transaction after `2026-10-25T11:22:32Z`; its last note was saved at
`11:25Z`. The H3 windows were:

| Run               | UTC window            | Result                          |
| ----------------- | --------------------- | ------------------------------- |
| DF2               | `11:29:23`–`11:29:38` | PASS                            |
| DF1 first attempt | `11:30:59`–`11:31:29` | FAIL (client timeout; excluded) |
| DF1 rerun         | `11:37:01`–`11:37:43` | PASS                            |

No E1 transaction overlapped these windows. The first DF1 attempt was a harness
timeout at a 30 s client limit during the second `fund`; the API later completed
both payments and their chain releases. It is not counted as H3 acceptance. The
rerun used a 90 s client timeout and passed. No assertion was weakened.

## Read-only decoder cross-check (reused evidence)

The same decoder was replayed read-only against the existing CCR-11 acceptance
transactions, without sending a transaction:

| Item              | Value                                                                |
| ----------------- | -------------------------------------------------------------------- |
| Lock              | `5967fd610160b526f1dbc90ed2f6b2076578bddf2ae28ec4788ba0f2888b9c86`   |
| Release           | `bc455c6ee69ee75024cbe12300fc62baedbb62c05ad291a9681158c64d43e9fb`   |
| Payout            | `39`                                                                 |
| Function / return | `create_payout` → `39`; `claim` → `1179222772`                       |
| Release transfers | `1179222772` to Worker A and `11792227` to the treasury, asset above |
| Vault config      | token, treasury and `100` bps matched this run                       |

This validates the decoder against an independently produced acceptance run. It
is not counted as a new DF1/DF2 H3 execution.

## Checks

| Command                                          | Exit | Result                                |
| ------------------------------------------------ | ---- | ------------------------------------- |
| `npx vitest run tests/e2e/*.test.ts`             | 0    | 78/78                                 |
| `npm test --workspace @flexipay/api`             | 0    | 50/50                                 |
| `npm test --workspace @flexipay/domain`          | 0    | 72/72                                 |
| `npm test --workspace @flexipay/adapters-sim`    | 0    | 85/85                                 |
| `npm test --workspace @flexipay/adapter-stellar` | 0    | 17 passed, 5 skipped (opt-in testnet) |
| `npm run typecheck --workspaces --if-present`    | 0    | all workspaces clean                  |
| `npx tsc -p scripts/demo/tsconfig.json`          | 0    | clean                                 |
| `npx prettier --check` on changed files          | 0    | clean                                 |
| `git diff --check`                               | 0    | clean                                 |

Evidence JSON (git-ignored, local run):

- `df2-stellar-2026-10-25T11-29-38-424Z.json` — PASS.
- `df1-stellar-2026-10-25T11-37-43-797Z.json` — PASS.
- `df1-stellar-2026-10-25T11-30-59-900Z.json` — FAIL (excluded client timeout).

## What remains open

- **DF7 anchor lifecycle is not run.** Scaffolding against the published E1
  handoff can proceed; API/UI binding waits for the agreed contract. A
  package-only run would not be integrated M1.
- H1/H2 and anchor implementation remain Cursor's lane.
- **Stellar fee-drift recovery remains NOT VERIFIED.** No fee drift was
  manufactured and the deployed vault was not changed.
- H3 covers first-attempt `PayerPays` DF1/DF2 on the baseline vault only. It
  does not prove fiat bank receipt: the PH/BR payout rails are simulated.
- No push, merge or deployment was performed for this evidence run.
