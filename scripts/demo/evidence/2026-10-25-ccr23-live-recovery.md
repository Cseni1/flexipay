# CCR-23 live recovery evidence (not M2 acceptance)

**Status:** recovery proof only. **M2 remains NOT VERIFIED.**  
**Checkout:** `95c2a7ca11cfc85153a60c0ac20deefe2f2105e7`  
**Ceiling:** `FP_SOROBAN_TX_FEE_CEILING_STROOPS=20000000`  
**Network:** Stellar testnet · vault `CCG232ACW63XVUQGMMA6SWV46W2HIVR2ZSB5ENXHOIIITQBXUBHHIUMN`  
**Payment (record only — do not replay):** `pay_783bfbd00e9f9a17e8a149b7`  
**Recorded:** 2026-10-25 (operator: Csenge’s Cursor)

This file documents a **live CCR-23 deposit-recovery / lost-lock-response** path. It is **not** passkey claim acceptance and must not be cited as M2 VERIFIED.

---

## What was proven

1. Exactly **one** vault `deposit` for the payment; pending `fundTxRef` then confirmed identity (`fundOpIndex` 0).
2. Resumed `/fund` after process death **did not** create a second deposit; `lockAttempt` stayed **1**.
3. `create_payout` reached the chain; a later `/fund` recovered via `findLock` → `externalRef=51` without a new lock.
4. Assembled lock fee (`fee_charged` 599 075) is far below historical double-counted ~1e9+ / uint32-overflow figures.

---

## Deposit

| Field | Value |
|---|---|
| `fundTxRef` | `9dcab1080ec7a249c76e4d2ceb0b1444aa7999a827bef0a457de8e7aa0ab586d` |
| `fundOpIndex` | `0` |
| Network / vault | `stellar` / `CCG232AC…UMN` |
| Amount | `19899999` USDC minor (PayerPays principal + fee) |
| Horizon | successful · `2026-10-25T22:53:52Z` · `fee_charged=8648` · 1 op |
| Decode | `deposit(GA3VFD…6D6F, 19899999)` |
| Legs with this hash | **1** |

Events: `payment.onchain` phase `fund_pending` (22:53:53.042Z) → phase `fund` with `fundOpIndex=0` (22:53:53.157Z).

---

## Lock (on-chain) and DB recovery

| Field | Value |
|---|---|
| Lock tx | `544703d0d9ce7d8fe1fa91ef2e11037dc8eca92ded5d801dd85b231a4e3659e4` |
| Horizon / RPC | successful / `SUCCESS` · `2026-10-25T22:54:47Z` · `fee_charged=599075` |
| Decode | `create_payout` · amount `19702970` · mode `PayerPays` · `expires_at=1792968949` |
| `external_id` | matches `externalIdFor(pay_783…, 1)` (prefix `f8b3264659c98e78…`) |
| `payoutByExternal(…, attempt 1)` | **51** |
| DB `externalRef` | `51` |
| DB `lockTxRef` | **null** (see limitation below) |
| `lockAttempt` | **1** (never bumped) |

Decoded args match attempt-1 external id, settle amount, and fee mode.

---

## Event timeline (payment `pay_783…`)

| UTC | Event | Notes |
|---|---|---|
| 22:53:49.389 | `payment.created` | |
| 22:53:49.393 | `claim.opened` | claim/quote expiry **22:55:49.339Z** (~120 s — see ops note) |
| 22:53:49.406 | `payment.funded` | |
| 22:53:49.409 | `payment.processing` | |
| 22:53:49.437 | `leg.succeeded` | collect |
| 22:53:49.443 | `leg.succeeded` | convert |
| 22:53:53.042 | `payment.onchain` | phase `fund_pending` |
| 22:53:53.157 | `payment.onchain` | phase `fund`, `fundOpIndex=0` |

No further on-chain phases were persisted for lock (process death); lock hash retained from Horizon evidence.

---

## Row counts

| Table | After stranded deposit binds | After this payment |
|---|---|---|
| Payment | 5 | **6** |
| Leg | 15 | **18** |
| Event | 44 | **52** |
| AuditRow | 60 | **68** |

Delta +1 / +3 / +8 / +8 matches one new payment’s create/fund audit trail. Stranded `pay_b61…` / `pay_a254…` unchanged.

---

## Three process deaths / runner notes

1. **Combined API+`/fund` worker** (`start-m2-95c2a7c-accept.mjs`): last log “funding…”; DB already had confirmed fund identity; process reaped with **no** `uncaughtException` — after deposit, before `/fund` completion / `lockTxRef` write.
2. **Resume worker** (`resume-fund-783.mjs` under `nohup`): last log `POST /fund resume`; on-chain `create_payout` `544703d0…` at 22:54:47Z; process reaped again before durable `lockTxRef` write.
3. **Detached API** (`api-only-95c2a7c.mjs`, port **56639**, log `/tmp/fp-m2-private/api-only.log`) + **separate `curl` client** `/fund`: HTTP 200; `findLock` set `externalRef=51`; still no `lockTxRef` (expected given findLock limitation). API left running.

Conclusion: reaping mid-lock is a **runner** problem, not a vault/CCR-23 code defect. Later runs must keep the API detached and drive `/fund` only from a separate client.

---

## Known limitation: `lockTxRef` after findLock recovery

Recovery via `findLock` restores the **payout id** (`externalRef`) but the adapter **cannot** recover the originating transaction hash. The lock is real on-chain; the hash is in this evidence (`544703d0…`).  

- Documented behaviour for lost lock-response recovery — **not** treated as a blocker for recovery proof.  
- A normal uninterrupted lock path still persists `lockTxRef`.  
- Automatic hash backfill is **post-hackathon** follow-up.

---

## Ops note (claim window — not part of recovery proof)

This payment’s claim/quote validity was **~120 seconds** (`expiresAt` = create + 2 min), from repo `config/fees.json` → `quoteValiditySeconds: 120` (claim `expiresAt` copies `quote.validUntil`). Earlier stranded payments used a **~30 minute** window. Passkey ceremony cannot complete in 120 s; the next acceptance payment must use the **30-minute** default (change requires Claude confirmation if config still forces 120).

Claim is expired; **do not** reopen or `/fund` this payment. Permissionless vault refund after payout expiry returns locked funds to the payer balance — no special handling.

---

## Explicit non-claims

- Not M2 passkey acceptance.  
- No release/claim to a passkey contract wallet in this evidence.  
- M1 / DF7 unchanged and still gated / paused.  
- M2 status: **NOT VERIFIED**.
