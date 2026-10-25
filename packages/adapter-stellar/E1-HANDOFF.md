# E1 handoff — reference anchor + vault #2 (for Claude / Csaba / Freebuff)

**Branch:** `event/csenge-cursor/E1-anchor-cashout`  
**PR:** https://github.com/Cseni1/flexipay/pull/61  
**Owner (this package):** Csenge Cursor — `packages/adapter-stellar`, `scripts/testnet/setup-anchor-vault.sh`, **`testnet-ids-anchor-vault.env`**  
**Not owned here:** API routes, claim UI (Csaba); DF7 / H3 (Freebuff).

M1 bank payout is **reference-anchor simulation** on SDF `testanchor.stellar.org`, not a real bank receipt. Required UI wording: **“reference anchor on testnet, pays a US-dollar bank account in a sandbox”**.

Persist **three** distinct references: SEP-24 **anchor transaction id**, **anchor payment hash** (classic memo / `stellar_transaction_id`), and **vault release hash**.

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
| Vault #2 `deposit` (Soroban) | **Existing** `StellarSettlementAdapter.fundVault` once env points at anchor vault | needs funded classic SAC balance |
| SEP-24 **withdraw** interactive | **Yes** | |
| Classic payment + memo to anchor | **Yes** | `submitClassicPaymentWithMemo` |
| Poll to `completed` + assert | **Yes** | |
| API routes / claim UI | **No — Csaba** | |
| DF7 script | **No — Freebuff** | consumes this client |

## Configuration (CCR-20 — **accepted**)

| Name | Role |
| --- | --- |
| `FP_ANCHOR_HOME_DOMAIN` | `testanchor.stellar.org` |
| `FP_ANCHOR_USDC_ASSET` | `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| `FP_ANCHOR_USDC_CONTRACT_ID` | SAC C… |
| `FP_ANCHOR_VAULT_ID` | vault #2 (was proposed `FP_EVENT_PAYOUT_VAULT_ID`) |
| `FP_ANCHOR_VAULT_FEE_BPS` | must match on-chain (was `FP_EVENT_VAULT_FEE_BPS`) |
| `FP_ANCHOR_VAULT_TREASURY_ADDRESS` | treasury (was `FP_EVENT_TREASURY_ADDRESS`) |
| `FP_ANCHOR_VAULT_PURPOSE` | marker (was `FP_EVENT_VAULT_PURPOSE`) |
| Baseline `FP_PAYOUT_VAULT_ID` / `FP_USDC_*` | **unchanged** |

Public: `scripts/testnet/testnet-ids-anchor-vault.env` (Cursor-owned).  
Secrets overlay (gitignored): `.env.secrets-anchor-vault`.

## Asks for Csaba (API / UI) — server calls only; he proposes shapes

1. **Indicative price** — server calls `indicativeWithdrawPrice`; label indicative in UI.
2. **Start withdrawal / hosted URL** — server calls `startWithdrawInteractive`; open `url` server-side; never put JWT/query token in browser logs or evidence (`urlSanitised` only).
3. **Poll status** — server calls `getTransaction` / `waitForTerminal` until terminal; then classic memo payment once if custodial.
4. Persist three refs: anchor tx id, anchor payment hash, vault release hash.
5. UI copy: “reference anchor on testnet, pays a US-dollar bank account in a sandbox”.
6. Provider registration when ready — no routing rewrite from Cursor. **No additional CCR wait** for these three calls.

## Asks for Freebuff

- DF7: deposit may already be done by Cursor; if not, coordinate LOCK on payer first.
- Withdraw path: LOCK recipient A → authenticate → interactive → classic memo payment → `waitForTerminal` → `assertSuccessfulWithdraw`.
- Record vault release vs anchor payment separately; `urlSanitised` only in evidence.

## H1 — Claude **approved** (run gated)

Exact reproduction: **`scripts/demo/H1-REPRODUCTION.md`**.  
Driver: `scripts/demo/h1-fee-drift-stellar.ts` with `FP_H1_CLAUDE_APPROVED=1` + `FP_H1_EXECUTE=1`.

Configuration drift between vaults (baseline 100 → isolated same-token 50), not an on-chain fee change of the baseline vault.

## Interface reuse (product direction)

Hackathon stays Stellar-first. Anchor/H2/H1 code uses existing settlement + provider interfaces; chain-specific SEP/Soroban details remain in this package and `contracts/`. Do not add another ecosystem adapter this weekend.

## H2 — PASS (25 Oct)

Isolated DB + dedicated claim; wrong seal key → fail, no release; restore key → **same claim** accepts.  
Evidence: `scripts/demo/evidence/2026-10-25-h2-seal-key-negative.md` (script: `scripts/demo/h2-seal-key-negative.ts`). Baseline vault; not the anchor vault #2 path.

## Sunday 17:30 Lisbon

Price + sanitised hosted URL minimum; else M1 PARTIAL.
