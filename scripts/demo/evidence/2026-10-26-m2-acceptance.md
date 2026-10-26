# M2 acceptance (Payment A / passkey) — 2026-10-26

**Verdict: PARTIAL** — payment funded and released, but **passkey path was not exercised**. Claim completed via crypto-wallet `POST …/accept` to a G address (same as Payment B), not Create/Bind/Prepare/Submit.

## Runtime

| Item | Value |
|------|--------|
| Commit | `42e95a24a9c0a82e4e3aad4d9539a1a0fef9f577` |
| Checkout | `/Users/csenike/Library/FlexiPay-private/final-wt-42e95a2` |
| API / web | `127.0.0.1:56639` / `127.0.0.1:56640` |

## Payment A

| Field | Value |
|-------|--------|
| paymentId | `pay_eff515fa21856ba6c7ab8dfb` |
| Final status | **paid** |
| Settle | **succeeded** |
| `lockAttempt` | **1** |
| Deposit `fundTxRef` / op | `33edc223cb93ed2de960ca22a4939461d77c5effe0346af69b7195577bf0b11b` / `0` (fee `8648`) |
| Lock `lockTxRef` | `33e2949870561eb3700232c1a7f5984a8e5ea53ca7e34d23c4cbf0d08e01d23c` (fee `599075`) |
| Release `releaseTxRef` | `2f6a93cf0ff41e25d4436acd3a871cbf239f6391e9838252dcafae14df94954a` (fee `12059`) |
| Payout id | `60` |

## Passkey evidence (absent)

| Check | Result |
|-------|--------|
| `/v1/passkey/*` request-log lines | **none** |
| `PasskeyClaimPrepare` rows | **0** |
| Deploy tx | **none** |
| Bind / prepare / submit | **none** |

## What actually ran (request log)

```
2026-10-26T07:48:00.074Z GET  /v1/claims/ebee0bb3… 200
2026-10-26T07:48:35.613Z POST /v1/claims/ebee0bb3…/accept 200   (~9.9s)
```

## Release decode (RPC)

Hash `2f6a93cf0ff41e25d4436acd3a871cbf239f6391e9838252dcafae14df94954a` — `SUCCESS`.

| Field | Value |
|-------|--------|
| Contract | `CCG232ACW63XVUQGMMA6SWV46W2HIVR2ZSB5ENXHOIIITQBXUBHHIUMN` |
| Function | **`claim`** |
| Destination | **`GAAN53RQP4YMHJCBSSPBRSX77HWEWHUL5AFOUSOJBNIKVR6VS63RPRX5`** (classic G, not a smart-wallet contract) |
| Payout id | `60` |
| Amount | `19702970` USDC minor (settle `amountOut`) |

## Honesty

- Crypto release path works on this build (see also Payment B PASS).
- **M2 passkey acceptance is not VERIFIED** on this payment: no passkey UI/API steps ran before the claim was consumed.
- **No new payment created** after this outcome — awaiting operator decision.
