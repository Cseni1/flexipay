# M2 fee-overflow diagnosis (read-only) — for Claude

**Tested commit:** `f5af6669495fa9c243117f0e9896fc2f7e601713`  
**Diagnosed at:** 2026-10-25T~17:05Z (UTC)  
**Network:** Stellar testnet · RPC `https://soroban-testnet.stellar.org`  
**Baseline vault:** `CCG232ACW63XVUQGMMA6SWV46W2HIVR2ZSB5ENXHOIIITQBXUBHHIUMN`  
**Invoker (payer):** `GA3VFDLARJMD7IBYZ2EW3SDQBAIASVSFLFKKBLCNI4D3KDMWDQJX6D6F`  
**No transactions submitted by this diagnosis.** Full machine JSON: `/tmp/fp-m2-private/fee-overflow-diagnosis.json`  
**Worktree/DB/passkey evidence preserved.** Payer window unlocked (no authorised retry). Freebuff paused.

---

## Exact failing stage

| Step | Result |
|------|--------|
| `deposit` | **OK** — simulate `minResourceFee ≈ 13442`, assembled `builtFee ≈ 13542`. Horizon shows successful low-fee invokes (~8648) immediately before each failed fund. |
| `create_payout` | **FAIL at fee assembly / sign path** — simulate succeeds contract-side but `minResourceFee = 2820986533`, assembled `builtFee = 2820986633`. API `POST /fund` returns **409** `invalid_state`: *Total fee (baseFee × operations + resourceFee) exceeds uint32 (4294967295). Got **5261104576**.* |

Settle orchestration (`fundAndRun`) always **`fundVault` (deposit) then `lock` (`create_payout`)**. Failed payments leave settle `processing` with **no `lockTxRef`**, while deposits already landed (duplicate-funding risk on naive retry).

`Got 5261104576` was recorded from the API error string alongside script `minResourceFee=2820986533` / `builtFee=2820986633`. Client `AssembledTransaction` after first simulate already carries `builtFee` 2.82e9 (fits uint32); overflow appears on the submit/prepare path used by `signAndSend`, not on deposit.

> **CORRECTION (2026-10-25 Assignment 1 — see `2026-10-25-m2-fee-rent-matched.md`):** An earlier draft of this paragraph claimed `Got ≈ 2820986533 + 2440118043` (speculative “second addend” / restore composition). **That split is withdrawn** — `2440118043` was not an RPC/SDK field. Measured SDK behavior: `AssembledTransaction.sign()` rebuilds with `fee: built.fee` then adds `resourceFee` again (`total ≈ assembled + R`). Diagnosis-time `assembled + R = 5641973166 ≠ 5261104576`; historical Got remains an API string not fully reproduced from those diagnosis-time fees. Historical measured numbers above are preserved.

---

## Re-simulation (baseline vault, no send)

**Method:** `create_payout` (and `deposit` for contrast) via `@stellar/stellar-sdk` `contract.Client` (same stack as adapter).  
**Latest ledger (at sim):** `5384852`  
**Arg shape (sanitised):**

```json
{
  "payer": "GA3VFD…D6F",
  "amount": "19702970",
  "mode": "PayerPays",
  "expires_at": "<unix+3600>",
  "external_id": { "byteLength": 32 },
  "claim_hash": { "byteLength": 32, "present": true }
}
```

(`claim_hash` in the probe was a random 32-byte placeholder for shape-only sim — not a real claim secret.)

| Field | `deposit` | `create_payout` |
|-------|-----------|-----------------|
| minResourceFee | 13442 | **2820986533** |
| txData resourceFee | 13442 | **2820986533** |
| restorePreamble | none | none (on this probe) |
| footprint (parsed) | RO 1 / RW 1 | RO 1 / RW 1 *(parser may under-count XDR accessors)* |
| instructions/read/write bytes | extraction unreliable in probe | same |
| Contract error | none | none on baseline (sim “success”) |

Prior **successful** locks already charged enormous fees (stroops): `1192645291`, `1473232975`, `1799186462` — fee pressure has been rising through the day; overflow is the next step of that curve, not a one-off RPC flake.

---

## On-chain reconcile

**Payer vault balance (baseline):** `2164724991` minor USDC (~216.47) — consistent with **multiple deposits without matching locks**.

**`payoutByExternal(payer, sha256(paymentId:1))`:**

| paymentId | payoutId | Notes |
|-----------|----------|--------|
| `pay_b61ffbac…` (failed fund) | **null** | deposit likely on-chain; no lock |
| `pay_a2549b83…` (failed fund) | **null** | same |
| `pay_e23930ba…` | **50** | locked then claim expired/refunded |
| `pay_6978ce37…` | **49** | locked (WebAuthn attempt) |
| `pay_3b65e248…` | **48** | locked |

**Confirmed lock tx (Horizon successful):**

| hash | created | fee_charged |
|------|---------|-------------|
| `ac28835f…aa7` | 14:53Z | 1192645291 |
| `7638a08d…20c` | 15:22Z | 1473232975 |
| `a8194d7e…ce0` | 15:57Z | 1799186462 |

Paired low-fee invokes (~8648) immediately before locks = **deposits**.

---

## M1 — anchor vault #2 (read-only)

**Vault:** `CA5SYMIWGCUGG6OVTL3KBFNOWVEF46UILNKG7D7JMAD7XVQWX2W3ETMS`  
**Asset:** `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`  
**Planned amount:** 1 USDC (`10000000` minor), PayerPays  
**Payer balance in anchor vault:** `0`  
**No anchor funding performed.**

| Method | Result |
|--------|--------|
| `deposit` simulate | OK · minResourceFee ≈ 13438 |
| `create_payout` simulate | **Contract error #5 `InsufficientBalance`** (expected with zero vault balance) · no resource-fee overflow observed |

---

## WebAuthn (already captured — Csaba owns fix)

Safari/Android hybrid on localhost: **`credentials.create` ok** → automatic binding **`credentials.get`** failed with **`NotAllowedError: The document is not focused.`** (kit `ValidationError` 8003). No deploy.  
Handoff: `scripts/demo/evidence/2026-10-25-m2-passkey-create-ok-get-focus-fail.md` and `/tmp/fp-m2-private/handoff-create-ok-get-focus-fail/`.  
**Explicit “Bind wallet” user action reusing the created credential — Csaba.** No more user attempts from Cursor on this.

---

## Minimal recommendation (Claude only)

1. **Treat failing stage as `create_payout` resource-fee / fee-assembly**, not deposit. Do **not** fee-cap or truncate; find why `minResourceFee` for `create_payout` on baseline vault is ~2.8e9 (and why submit path reports ~5.26e9).  
2. **Do not** `POST /fund` again on `pay_b61…` / `pay_a254…` or mint replacements that call `deposit` first — vault balance already holds stranded deposits; use `payoutByExternal` / balance reads before any lock retry.  
3. Any retry must be Claude-reviewed, **LOCK payer**, and demonstrably **skip re-deposit** when balance already covers `locked`, same `external_id` / attempt rules (no duplicate lock).  
4. M1 anchor path is a separate insufficient-balance sim until funded; not the uint32 overflow.  
5. Integrate/merge only after root-causing resource-fee growth (contract footprint, TTL/state rent, SDK assemble/signAndSend double-count). **No deployment from this lane.**

**M2 acceptance:** NOT VERIFIED · **Freebuff:** paused · **Chrome retry:** deferred until lock path is safe.
