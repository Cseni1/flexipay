# E1 evidence — deposit credit, vault #2 lock/release, anchor withdraw (25 Oct 2026)

**PR:** https://github.com/Cseni1/flexipay/pull/61  
**Network:** Stellar testnet / SDF `testanchor.stellar.org`  
**Asset identity:** `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` (SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`)  
**Event vault #2:** `CA5SYMIWGCUGG6OVTL3KBFNOWVEF46UILNKG7D7JMAD7XVQWX2W3ETMS` (fee 100 bps)  
**Baseline vault:** untouched  
**Hosted UI evidence:** `urlSanitised` only — `https://anchor-ref-ui-testanchor.stellar.org/` (no session tokens in this file)

**CCR-20 rename note (post-run annotation only):** At execution time the public ids file used proposed names `FP_EVENT_PAYOUT_VAULT_ID` / `FP_EVENT_VAULT_FEE_BPS` / `FP_EVENT_TREASURY_ADDRESS` / `FP_EVENT_VAULT_PURPOSE`. Accepted replacements are `FP_ANCHOR_VAULT_ID` / `FP_ANCHOR_VAULT_FEE_BPS` / `FP_ANCHOR_VAULT_TREASURY_ADDRESS` / `FP_ANCHOR_VAULT_PURPOSE`. This evidence does **not** claim the renamed keys were present in the executed commands.

**Package-level E1 path:** PASS for deposit → vault release → classic memo payment → SEP-24 `completed`.  
**Integrated M1:** PARTIAL until Csaba claim API/UI journey works.

---

## 1. Deposit credit

| Field | Value |
| --- | --- |
| SEP-24 id | `8eea20eb-4dab-40db-9fe6-9ffff7d335dd` |
| Status | `completed` |
| amount_in / amount_out | `5` USD → `4.5` USDC |
| Destination (payer) | `GA3VFDLARJMD7IBYZ2EW3SDQBAIASVSFLFKKBLCNI4D3KDMWDQJX6D6F` |
| Stellar tx | `b313c0774f0ad7a15fd4670c1144f400b2c2ef9b2ef540766388e2b04e2240be` |
| Horizon | successful, ledger `5380721`, `2026-10-25T11:19:52Z` |
| Payer classic balance after | **4.5000000** `USDC:GBBD47…` (full issuer identity verified) |

---

## 2. Vault #2 fund → lock → release

| Field | Value |
| --- | --- |
| Vault | `CA5SYMIW…W3ETMS` (event only) |
| Amount / mode | 1 USDC, `PayerPays` (fund 1.01) |
| Recipient (classic) | `GAAN53RQP4YMHJCBSSPBRSX77HWEWHUL5AFOUSOJBNIKVR6VS63RPRX5` |
| payoutId | `2` |
| Fund tx | `2da1392db47240a0e447d43800ccc5c315a1799a84f8fb619e94b39b5fe2773c` |
| Lock tx | `e9f6fc338adc5267132cb6c3254946c2d10609622de4899cdb237107a76a87d2` |
| Release tx | `f1d2119dff7ea61c12c980a267ddb09684013443c526041f4b0cfd4811065f2d` |
| Status after claim | `claimed` |
| Recipient A balance after | **1.0000000** `USDC:GBBD47…` |

**Ops note:** first release attempt on payout `1` failed simulation — treasury lacked GBBD47 trustline (Contract `#13`). Trustline added (`2ff351dc…70cd`); setup script now includes `fp-treasury`. Leftover pending payout `1` remains (expires ~12:21Z); successful evidence is payout `2`.

Decoded: each vault hash is Horizon `successful` + `invoke_host_function`.

---

## 3. Anchor payment (classic memo, once)

| Field | Value |
| --- | --- |
| SEP-24 withdraw id | `0f81ded4-6559-4e5d-8576-df478c589137` |
| Status at payment | `pending_user_transfer_start` |
| amount_in | `1` USDC (`USDC:GBBD47…`) |
| Destination | `GBN4NNCDGJO4XW4KQU3CBIESUJWFVBUZPOKUZHT7W7WRB7CWOA7BXVQF` |
| Memo | `2304272553721027745` (`id`) |
| Classic payment tx | `20c9ae9e776677302a11f9ef2b725aa8b6d07a10642cba521ac1b53b0244674d` |
| Submitted | **once** (no retry) |

Decoded payment op: `payment` 1.0000000 USDC GBBD47 from recipient A → anchor account; memo id present.

---

## 4. Final anchor status

| Field | Value |
| --- | --- |
| Status | **`completed`** |
| amount_in / amount_out | `1.0000000` USDC → `0.9` USD |
| `stellar_transaction_id` | `20c9ae9e776677302a11f9ef2b725aa8b6d07a10642cba521ac1b53b0244674d` (matches classic payment) |
| Poll | `waitForTerminal` within 120s (completed ~10s) |

Vault release hash ≠ anchor payment hash (recorded separately, as required).

---

## Csaba handoff (API/UI — do not implement in this package)

Precise wiring only; Cursor does not own claim routes/UI.

1. **Env (CCR-20 accepted):** load `scripts/testnet/testnet-ids-anchor-vault.env` for anchor vault (`FP_ANCHOR_VAULT_*` + `FP_ANCHOR_HOME_DOMAIN` / `FP_ANCHOR_USDC_*`); keep baseline `FP_PAYOUT_VAULT_ID` / `FP_USDC_*` for non-M1 paths. (See rename note above for names used during this run.)
2. **Server-only:** SEP-10 JWT on `ReferenceAnchorClient` instance; never return interactive `url` token query to the browser — open hosted URL from server or a one-time redirect that does not log the token.
3. **Claim cash-out sequence:** after vault release to custodial recipient → `startWithdrawInteractive` → wait until `withdraw_anchor_account` + `withdraw_memo` + `amount_in` → `submitClassicPaymentWithMemo` **once** → `waitForTerminal` → persist `{ vaultReleaseTx, classicPaymentTx, sep24Id, status }` separately.
4. **Duplicate guard:** if poll times out, reconcile Horizon by `classicPaymentTx` / SEP-24 `stellar_transaction_id` before any second submit.
5. **UI:** show indicative SEP-38 price as indicative; show asset as code+issuer; do not claim real bank settlement (reference-anchor simulation).

---

## Claude (separate from this evidence)

- CCR-20 env/interface name approval still outstanding.
- H1 fee-drift reproduction still awaits approval — **not** run in this session.
