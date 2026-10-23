# SC2 adapter testnet verification — 23 October 2026

**Package-level only.** Integrated DF3 remains **BLOCKED** (no CC3 payment/claim routes).

| Item | Value |
| --- | --- |
| `main` | `c9baefe` |
| Worktree | `flexipay-sc2-verify` (detached `origin/main`) |
| Unit / typecheck | 16 passed (6 skipped offline); typecheck PASS |
| `FP_TESTNET=1` vitest | **5/5 passed** (~88s), one retry with `--disable-console-intercept` to capture hashes |

## Fee modes

| Mode | Unit (`payoutAmounts`) | Testnet (vault + adapter) |
| --- | --- | --- |
| `PayerPays` | PASS | PASS (lock → release; cancel/refund) |
| `RecipientPays` | PASS | **NOT RUN** — no existing testnet case |

## Public ids (from `scripts/testnet/testnet-ids.env`)

| Role | Id |
| --- | --- |
| Vault | `CCG232ACW63XVUQGMMA6SWV46W2HIVR2ZSB5ENXHOIIITQBXUBHHIUMN` |
| USDC contract | `CCZAEMZPSOOZLAZTN3KQVLXYVMJGEI7BDRVNMRM5TSQTHTX4EITONUGT` |
| USDC issuer | `GBBO6NQEGSK2F7FRGQSRHJK4FD465H5DVALNTCT6XZJIZHKJRSPKEIY2` |
| Fee bps | `100` |
| Payer demo | `GA3VFDLARJMD7IBYZ2EW3SDQBAIASVSFLFKKBLCNI4D3KDMWDQJX6D6F` |
| Worker A (intended recipient) | `GAAN53RQP4YMHJCBSSPBRSX77HWEWHUL5AFOUSOJBNIKVR6VS63RPRX5` |
| Treasury | `GDH7WGAQJQUBQBYNN3SO4QWWWXRYR6GWQTM5BZ3RCGXFDCOI4QTUHHXR` |

## Adapter run hashes (`sc2_adapter_1792764067450`, `PayerPays`, gross 1.0000000 USDC)

| Step | tx hash |
| --- | --- |
| fund | `d72045e0098d5763ba08a6e1ef3f104de1ae9645375c31a816264565df699bdd` |
| lock | `fea674cd06c42b3ba895e2d5e1a7aa16603b54e25aa5a5b8d4fd0a2829d051e4` |
| release | `5f4f94d685c5bd6b5644ac7c882ae30af6bde69e7e33c83718d00159a2090618` |

Vault-level companion run (`sc2_1792764067450`): deposit `d0d5f82a…`, lock `1091e427…`, release `0d972658…`, cancel `7cb1fb3d…`.

## Horizon balance effects on adapter **release** (public)

`GET https://horizon-testnet.stellar.org/transactions/5f4f94d685c5bd6b5644ac7c882ae30af6bde69e7e33c83718d00159a2090618/effects`

| Effect | Account | Contract | Asset | Amount |
| --- | --- | --- | --- | --- |
| `contract_debited` | Worker A | **vault** `CCG232…` | USDC (issuer GBBO6…) | `1.0000000` |
| `account_credited` | **Worker A** | — | USDC | `1.0000000` |
| `contract_debited` | Worker A (fee path) | **vault** `CCG232…` | USDC | `0.0100000` |
| `account_credited` | **Treasury** | — | USDC | `0.0100000` |

Matches `PayerPays` at 100 bps: net 1.0 USDC to intended recipient, fee 0.01 USDC to treasury, from our vault contract. Release tx source account = Worker A (claim authorisation). Lock tx source = payer demo.

Payout id is returned by the adapter/`get_payout` (not always present as a Horizon classic effect field); assert via adapter `status(payoutId)` / vault `get_payout` when available.

## Freebuff: verify a vault release from existing tx data

1. Take `release.txRef` from adapter evidence (64-char hex).
2. `curl -s https://horizon-testnet.stellar.org/transactions/<txRef>` → `successful: true`.
3. `curl -s https://horizon-testnet.stellar.org/transactions/<txRef>/effects` → confirm:
   - `contract` = `FP_PAYOUT_VAULT_ID`
   - `account_credited` to intended recipient address for USDC net amount
   - fee credit to `FP_TREASURY_ADDRESS` when fee > 0
   - `asset_code=USDC` and issuer matches `FP_USDC_ASSET`
4. Optional: stellar.expert testnet tx page for the same hash (explorer UI).
5. Do **not** use secrets; public ids are enough.

## Gaps / defects (lane B unless noted)

1. **No testnet `RecipientPays` case** — unit math only. Add a lane-B testnet it if product needs both modes proven on-chain before DF3.
2. Tests assert adapter `received` / vault `getPayout` amounts; they do **not** themselves call Horizon effects (integrator did that separately for this evidence).
3. **DF3 integrated** still **BLOCKED** on CC3 + claim/payment routes — package PASS ≠ flow PASS.
4. Shared: CC3 must pass `feeMode` from quote and `settlementSimulated` from `FP_SETTLEMENT` (not adapter defects).

## Commands (bounded)

```bash
git worktree add flexipay-sc2-verify origin/main
# place git-ignored scripts/testnet/.env.secrets (never commit / never log)
npm ci --ignore-scripts --workspace @flexipay/adapter-stellar
npm run typecheck --workspace @flexipay/adapter-stellar
npm test --workspace @flexipay/adapter-stellar
FP_TESTNET=1 npx vitest run test/testnet.test.ts --reporter=verbose --disable-console-intercept
```
