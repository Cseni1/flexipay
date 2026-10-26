# M2 acceptance (passkey) — 2026-10-26

**Verdict: PARTIAL** — hard stop **08:45Z**; no passkey release. Crypto-wallet claim (Payment B) separately **PASS** (see `2026-10-26-claim-release-crypto.md`).

## Runtime

| Item | Value |
|------|--------|
| Commit | `42e95a24a9c0a82e4e3aad4d9539a1a0fef9f577` |
| Checkout | `/Users/csenike/Library/FlexiPay-private/final-wt-42e95a2` |
| API / web | `127.0.0.1:56639` / `127.0.0.1:56640` |
| Evidence PR | https://github.com/Cseni1/flexipay/pull/85 (not merged) |

## Payment C (intended passkey attempt)

| Field | Value |
|-------|--------|
| paymentId | `pay_b98829d7054454c21cd68b49` |
| Claim expires | `2026-10-26T08:36:36.268Z` |
| Hard stop | `2026-10-26T08:45:00Z` |
| Deposit `fundTxRef` / op | `16b97ee8787b05097af85476eeca74d217c9b4d801f4b6beb84fcf34c5e69b5e` / `0` (fee `8648`) |
| Lock `lockTxRef` | `49a907016e0f616ec761d63e70aac880af30a6dd009154ddd02070beee290b78` (fee `599075`) |
| `lockAttempt` | **1** (exactly one deposit) |
| Final payment status | **failed** |
| Claim link | **expired** |
| Settle | **failed** (`refund_failed` in API after expiry path; see on-chain note) |
| Payout id | `61` |

### Passkey path (not exercised)

| Check | Result |
|-------|--------|
| `/v1/passkey/deploy` / `prepare` / `submit` | **none** |
| `PasskeyClaimPrepare` rows | **0** |
| Deploy / bind / prepare / submit | **none** |
| On-page | WebAuthn UI error: “The passkey wallet could not be used on this device.” (client-side; no API hit). Truncated claim URLs also produced `Claim not found` / 404. |

### Request log (this token only, selected)

```
GET  /v1/claims/c2543851… 200   (page opens)
GET  /v1/claims/c2543851…%E2%80%A6… 404   (truncated token with ellipsis)
GET  /v1/claims/c2543851… 200 6260ms     (post-expiry lazy path ~10:03Z)
```

### On-chain after expiry

| Field | Value |
|-------|--------|
| `releaseTxRef` | `8a7c7bb92c08ce58ca806ed388491f8c47101b6d751840f33846a4a6e1710caf` |
| RPC decode | vault **`refund(61)`** (not `claim`) — Horizon `successful`, fee `5509` |
| API `errorCode` | `refund_failed` (`fetch failed`) despite on-chain refund SUCCESS |

## Earlier Payment A (same day, not passkey)

`pay_eff515fa21856ba6c7ab8dfb` was **paid** via crypto-wallet `POST …/accept` to `GAAN53…` (release `2f6a93cf…` = vault `claim`), not passkey. Documented previously; not M2 passkey VERIFIED.

## Honesty

- **M2 passkey acceptance is not VERIFIED.**
- Fund/lock under patched kit + ceiling worked for Payment C; human passkey Create never reached deploy.
- Hard stop honored: no further payments created after 08:45Z.
