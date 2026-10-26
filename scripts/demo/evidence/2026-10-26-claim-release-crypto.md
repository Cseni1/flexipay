# Claim release — crypto wallet (Payment B) — 2026-10-26

**Verdict: PASS**

## Runtime

| Item | Value |
|------|--------|
| Commit | `42e95a24a9c0a82e4e3aad4d9539a1a0fef9f577` |
| Checkout | `/Users/csenike/Library/FlexiPay-private/final-wt-42e95a2` |
| API / web | `127.0.0.1:56639` / `127.0.0.1:56640` |
| Vault | `CCG232ACW63XVUQGMMA6SWV46W2HIVR2ZSB5ENXHOIIITQBXUBHHIUMN` |

## Payment

| Field | Value |
|-------|--------|
| paymentId | `pay_f7e802ab84717aeaec400c61` |
| Final status | **paid** |
| Settle status | **succeeded** |
| `lockAttempt` | **1** (exactly one deposit) |
| Destination G | `GAAN53RQP4YMHJCBSSPBRSX77HWEWHUL5AFOUSOJBNIKVR6VS63RPRX5` |
| Payout id (`externalRef`) | `59` |
| Settle amount | `19702970` USDC (minor) |

## Fund / lock / release

| Stage | tx hash | Horizon `fee_charged` |
|-------|---------|------------------------|
| Deposit (`fundTxRef`, op `0`) | `42c05118eb86de8414c735bdd754d40c4e4348fa1c82ac3b28bf9f32ff580e84` | `8648` |
| Lock (`lockTxRef`) | `7a1f53aa8970845bf5d2037ae89af9c5b8f877f62d93d460450daf15eb0443bf` | `599075` |
| Release (`releaseTxRef`) | `c66def20356e0a9a4b60d573662048169ea5c813e6d5af9822b10252a24a5354` | `12059` |

No `fee_ceiling_*` / `fee_construction_invalid`.

## Request log (claim)

```
2026-10-26T07:45:19.903Z GET  /v1/claims/59652e15… 200
2026-10-26T07:45:31.339Z POST /v1/claims/59652e15…/accept 502   (first attempt; proxy/transient)
2026-10-26T07:45:52.402Z POST /v1/claims/59652e15…/accept 200   (success; ~5.2s)
```

Subsequent `anchor/indicative-price` 502s are unrelated to this crypto release (no M1/anchor in scope). Later accept 400s were wrong-shaped diagnostic probes after paid.

## Release decode (RPC `getTransaction`)

Hash `c66def20356e0a9a4b60d573662048169ea5c813e6d5af9822b10252a24a5354` — status `SUCCESS`.

| Field | Value |
|-------|--------|
| Contract | `CCG232ACW63XVUQGMMA6SWV46W2HIVR2ZSB5ENXHOIIITQBXUBHHIUMN` |
| Function | **`claim`** |
| Args | payout id `59`; claim secret (bytes); destination **`GAAN53RQP4YMHJCBSSPBRSX77HWEWHUL5AFOUSOJBNIKVR6VS63RPRX5`** |
| Amount received | `19702970` USDC (from settle `amountOut`; classic G destination) |
