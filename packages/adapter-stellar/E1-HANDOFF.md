# E1 handoff — reference anchor + vault #2 (for Claude / Csaba / Freebuff)

**Branch:** `event/csenge-cursor/E1-anchor-cashout`  
**PR:** https://github.com/Cseni1/flexipay/pull/61  
**Owner (this package):** Csenge Cursor — `packages/adapter-stellar`, `scripts/testnet/setup-anchor-vault.sh`, **`testnet-ids-anchor-vault.env`**  
**Not owned here:** API routes, claim UI (Csaba); DF7 / H3 (Freebuff).

M1 bank payout is **reference-anchor simulation** on SDF `testanchor.stellar.org`, not a real bank receipt. Vault release and anchor payment are recorded as **separate** hashes.

**Unit PASS ≠ M1 PASS.**  
**Package path (25 Oct):** deposit credit + vault #2 lock/release + classic memo withdraw → SEP-24 `completed` — see `scripts/demo/evidence/2026-10-25-e1-deposit-vault-withdraw.md`.  
**Integrated M1:** still **PARTIAL** until Csaba claim API/UI journey works.

## Shared accounts / tx windows

See `scripts/testnet/EVENT-TX-WINDOWS.md`. Coordinate LOCK/UNLOCK on payer vs recipient A before live submissions. Cursor owns the event ids file; Freebuff consumes it — do not regenerate without notice.

## Exported client (DF7 + deposit funding)

Import from `@flexipay/adapter-stellar`:

| Method / helper | Input | Output / behaviour |
| --- | --- | --- |
| `loadAnchorToml(homeDomain)` | domain | endpoints + currencies |
| `new ReferenceAnchorClient({ homeDomain, networkPassphrase, asset, fetch? })` | full `StellarAssetIdentity` | client |
| `connect()` | — | TOML network + asset listed |
| `authenticate(keypair)` | classic `Keypair` | SEP-10; JWT **on instance only** |
| `hasSession` / `clearSession` | — | — |
| `indicativeWithdrawPrice({ sellAmount, buyFiat? })` | — | `{ indicative: true, context: "sep6", … }` |
| **`startDepositInteractive({ amount, type? })`** | 1–10 USDC | hosted deposit session (`kind: "deposit"`) |
| **`startWithdrawInteractive({ amount, type? })`** | — | hosted withdraw session (`kind: "withdrawal"`) |
| `getTransaction` / `waitForTerminal` | id | status + memo/account fields |
| `paymentExpectationFromTx(tx)` | withdraw tx | amount, destination, memo, asset |
| **`submitClassicPaymentWithMemo({ source, expectation, networkPassphrase })`** | Keypair + expectation | `{ txHash, … }` Horizon payment **with memo** to anchor |
| `assertSuccessfulWithdraw({ tx, expected })` | — | requires status **`completed`** + field match |
| `evidenceSafeTx` / `sanitiseHostedUrl` | — | no JWT; memo presence only |

**Errors:** `AnchorClientError.code` — `not_connected`, `not_authenticated`, `network_mismatch`, `asset_not_listed`, `sep10_*`, `sep38_price_failed`, `sep24_*`, `classic_payment_failed`, `amount_mismatch`, …

**M1 PASS:** `completed` + verified amount, asset (code+issuer+network), destination, memo; plus separate vault release hash and anchor `stellar_transaction_id` / classic `txHash`.

### End-to-end stages (what is implemented vs not)

| Stage | Implemented in adapter? | Notes |
| --- | --- | --- |
| Discover TOML / asset identity | **Yes** | |
| SEP-10 classic | **Yes** | |
| SEP-38 indicative price | **Yes** | `sep6` only |
| SEP-24 **deposit** interactive | **Yes** | funds classic account with GBBD47 USDC |
| Hosted deposit completion | **Manual / UI** | open `url` server-side; poll `waitForTerminal` |
| Vault #2 deploy + ids file | **Script** | `setup-anchor-vault.sh` |
| Vault #2 `deposit` (Soroban) | **Existing** `StellarSettlementAdapter.fundVault` once env points at event vault | needs funded classic SAC balance |
| SEP-24 **withdraw** interactive | **Yes** | |
| Classic payment + memo to anchor | **Yes** | `submitClassicPaymentWithMemo` |
| Poll to `completed` + assert | **Yes** | |
| API routes / claim UI | **No — Csaba** | |
| DF7 script | **No — Freebuff** | consumes this client |

## Configuration (CCR-20 — proposed)

| Name | Role |
| --- | --- |
| `FP_ANCHOR_HOME_DOMAIN` | `testanchor.stellar.org` |
| `FP_ANCHOR_USDC_ASSET` | `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| `FP_ANCHOR_USDC_CONTRACT_ID` | SAC C… |
| `FP_EVENT_PAYOUT_VAULT_ID` | vault #2 |
| `FP_EVENT_VAULT_FEE_BPS` | must match on-chain |
| `FP_EVENT_TREASURY_ADDRESS` | treasury |
| Baseline `FP_PAYOUT_VAULT_ID` / `FP_USDC_*` | **unchanged** |

Public: `scripts/testnet/testnet-ids-anchor-vault.env` (Cursor-owned).  
Secrets overlay (gitignored): `.env.secrets-anchor-vault`.

**Isolated setup does not wait on CCR-20 HTTP fields** — only on Claude accepting env **names** if Csaba must load them in the API process. Script/file generation can proceed with the proposed names.

## Asks for Csaba (API / UI)

1. Server-side handlers holding SEP-10 JWT; never send token to the browser.
2. Claim UI: indicative price label; open withdraw `url`; after memo fields appear, either call backend to `submitClassicPaymentWithMemo` (custodial) or show instructions.
3. Optional persist anchor tx id + classic payment hash + vault release hash.
4. Provider registration when ready — no routing rewrite from Cursor.

## Asks for Freebuff

- DF7: deposit may already be done by Cursor; if not, coordinate LOCK on payer first.
- Withdraw path: LOCK recipient A → authenticate → interactive → classic memo payment → `waitForTerminal` → `assertSuccessfulWithdraw`.
- Record vault release vs anchor payment separately; `urlSanitised` only in evidence.

## H1 — Claude approval required (not executed)

Same-token second vault at `fee_bps=50`, baseline vault untouched; quote on baseline (100) → restart API env to H1 vault → fund → expect `409 fee_drift` + refund + claim refuse via **public API**. Details in prior section of PR #61 / below.

1. Deploy H1 vault: baseline token (GBBO6N SAC), fee 50, distinct id.  
2. Process A: baseline env → claim_link payment. Isolated DB.  
3. Process B: same DB, env → H1 vault (verifyConfig OK).  
4. Fund → drift path. Restore baseline env.

## H2 — Cursor later

Isolated DB + dedicated claim; wrong seal key → fail, no release; restore key → **same claim** accepts.

## Sunday 17:30 Lisbon

Price + sanitised hosted URL minimum; else M1 PARTIAL.
