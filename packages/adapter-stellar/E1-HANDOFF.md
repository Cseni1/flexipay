# E1 handoff — reference anchor + vault #2 (for Claude / Csaba / Freebuff)

**Branch:** `event/csenge-cursor/E1-anchor-cashout`  
**Owner (this package):** Csenge Cursor — `packages/adapter-stellar`, `scripts/testnet/setup-anchor-vault.sh`  
**Not owned here:** API routes, claim UI (Csaba); DF7 / H3 (Freebuff).

M1 bank payout is **reference-anchor simulation** on SDF `testanchor.stellar.org`, not a real bank receipt. Vault release and anchor payment are recorded as **separate** hashes.

## Exported client (ready for DF7)

Import from `@flexipay/adapter-stellar`:

| Method / helper | Input | Output / behaviour |
| --- | --- | --- |
| `loadAnchorToml(homeDomain)` | domain string | endpoints + listed currencies |
| `new ReferenceAnchorClient({ homeDomain, networkPassphrase, asset, fetch? })` | full `StellarAssetIdentity` (code+issuer+network[+SAC]) | client |
| `connect()` | — | validates TOML network + asset listed |
| `authenticate(keypair)` | classic `Keypair` | SEP-10; JWT **held only on the instance** |
| `hasSession(account)` / `clearSession()` | G-address | boolean / void |
| `indicativeWithdrawPrice({ sellAmount, buyFiat? })` | amount string, USD\|CAD | `{ indicative: true, context: "sep6", … }` |
| `startWithdrawInteractive({ amount, type? })` | — | `{ id, url, urlSanitised, type }` — use `url` only server-side |
| `getTransaction(id)` / `waitForTerminal(id)` | id | status + payment fields |
| `paymentExpectationFromTx(tx)` | tx view | amount, destination, memo, asset |
| `assertSuccessfulWithdraw({ tx, expected })` | — | throws unless status `completed` **and** amount/destination/memo match |
| `evidenceSafeTx(tx)` | — | sanitised snapshot (memo presence only; no JWT) |
| `sanitiseHostedUrl` / `isSep24Success` | — | evidence helpers |

**Errors:** `AnchorClientError` with `code` (`not_connected`, `not_authenticated`, `network_mismatch`, `asset_not_listed`, `sep10_*`, `sep38_price_failed`, `sep24_*`, `amount_mismatch`, …).

**M1 PASS rule:** `isSep24Success(status)` (`completed` only) **plus** verified payment amount, asset identity, destination, memo. `error` / `expired` / etc. are terminal failures, not PASS. `pending_*` is not PASS.

## Configuration names (proposed — see CCR-20)

| Name | Role |
| --- | --- |
| `FP_ANCHOR_HOME_DOMAIN` | e.g. `testanchor.stellar.org` |
| `FP_ANCHOR_USDC_ASSET` | **`USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`** (full issuer) |
| `FP_ANCHOR_USDC_CONTRACT_ID` | SAC C… for that asset |
| `FP_EVENT_PAYOUT_VAULT_ID` | second vault (anchor token) |
| `FP_EVENT_VAULT_FEE_BPS` | must match on-chain config of vault #2 |
| `FP_EVENT_TREASURY_ADDRESS` | treasury for vault #2 |
| Baseline `FP_PAYOUT_VAULT_ID` / `FP_USDC_*` | **unchanged** (`testnet-ids.env`) |

Public file after setup: `scripts/testnet/testnet-ids-anchor-vault.env`.  
Secrets overlay (ignored): `scripts/testnet/.env.secrets-anchor-vault`.

## Asks for Csaba (API / UI) — do not implement here

1. Server-side route(s) that hold SEP-10 JWT and call this client (browser never sees the token).
2. Claim UI: open `url` from `startWithdrawInteractive`; show indicative SEP-38 price labelled **indicative**.
3. Optional: persist anchor tx id next to payment/claim for DF7.
4. Wire provider id for “reference anchor” via existing `ProviderAdapter` when ready — no routing rewrite required from Cursor.

Resolve any new HTTP fields via `docs/CONTRACT_CHANGES.md` **before** binding.

## Asks for Freebuff (DF7)

- Drive: connect → authenticate (custodial recipient key) → indicative price → interactive → (after hosted + classic payment) `waitForTerminal` → `assertSuccessfulWithdraw`.
- Assert vault **release** tx and anchor **stellar_transaction_id** separately in evidence.
- Use `urlSanitised` / `evidenceSafeTx` only in committed evidence.
- Do not claim M1 PASS on non-`completed` terminals.

## H1 proposal for Claude (**do not execute until approved**)

**Not yet a validated reproduction.** Startup validation (`PayoutVault.verifyConfig`) requires env token/treasury/`FP_VAULT_FEE_BPS` to match the vault pointed to by `FP_PAYOUT_VAULT_ID`. Quotes freeze `fees.flexiPayFee` from `settlement.feeBps()` at quote time (`apps/api/src/routes/quotes.ts`). Lock compares `locked.fee` to that frozen fee (`orchestrator/run.ts`).

**Exact isolated setup to approve:**

1. Deploy a **dedicated H1 vault** with the **same baseline token** (`FP_USDC_CONTRACT_ID` from `testnet-ids.env`, issuer GBBO6N…) but **`fee_bps=50`** (baseline remains 100). Distinct contract id; **do not** call `FP_REDEPLOY_VAULT` on the baseline alias; **do not** change baseline on-chain config.
2. Process A: `FP_SETTLEMENT=stellar` + baseline vault env → create claim_link payment (frozen fee at 100 bps). Isolated DB.
3. Stop A. Process B: same DB; env overlay so `FP_PAYOUT_VAULT_ID` / `FP_VAULT_FEE_BPS` / matching token+treasury point at the **H1 vault** (verifyConfig passes for B).
4. `POST .../fund` → expect lock fee drift → `409 fee_drift`, settle failed, vault refund on H1 vault, claim accept `409 settle_failed`.
5. Restore baseline env. Evidence via **public API**, not an adapter-only unit test.

Reject alternatives that bypass `verifyConfig`, weaken fee assertions, or mutate the baseline vault.

## H2 (later branch; design locked)

Isolated persistent DB + dedicated claim. Wrong `FP_CLAIM_SEAL_KEY` → accept fails, no on-chain release. Restore original key → **same claim** accepts successfully.

## Sunday 17:30 Lisbon

Checkpoint: indicative price + hosted interactive URL reached (sanitised in evidence). If withdraw not `completed`, M1 **PARTIAL** with furthest stage; keep documented fallback.
