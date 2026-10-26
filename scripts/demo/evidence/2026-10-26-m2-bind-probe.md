# M2 Bind probe (PARTIAL — not acceptance)

**Status:** **PARTIAL.** This is a **throwaway on-device Bind probe only**. It is **not** an M2 acceptance run and must not be cited as M2 VERIFIED.

**Commit under test:** `95c2a7ca11cfc85153a60c0ac20deefe2f2105e7`  
**Network:** Stellar testnet  
**Recorded:** 2026-10-26

## Deployed wallet (from attempt-2 Create/deploy)

| Field | Value |
|---|---|
| Contract id | `CAY6BMHLHZ3NEH53UURI3MOT5MY325DMCIMSI6RNNNIJMGZTRWWVZMXP` |
| Deploy tx | `8e799b265a609c804380952522cb7e0bf142d414484005f9f1f2015c47b6616e` |

## Probe results (Chrome · `http://localhost` · real WebAuthn)

1. **Unpatched passkey-kit 0.19.1**  
   `confirmWalletCreation` OK → passkey prompt OK → `connectWallet` **FAIL**  
   `TypeError: Cannot read properties of null (reading 'toString')` (no DOMException).  
   Signer expiry slot `values[1][0]` is `null` (SDK Option::None); kit treated it as defined.

2. **Probe-only patched kit** (`expiration !== undefined && expiration !== null`) **plus** `allowedOrigins` including the Create origin  
   `confirmWalletCreation` OK → passkey prompt OK → `connectWallet` **OK**  
   (`RESULT: patched Bind works`)

## Allowed-origin note

Genesis binding was created on app origin `http://localhost:56640`. A probe on `http://localhost:56750` with only the probe origin in `allowedOrigins` failed after WebAuthn with `WalletOwnershipError` **2004** (`Wallet signer binding record is invalid`). Including Create origin `http://localhost:56640` (and probe origin) in `allowedOrigins`, `rpId: localhost`, allowed Bind to succeed on the probe. Same-origin Create+Bind on the app would not need a second origin.

## Scope reminder

Probe code lived under `/tmp/fp-m2-private/bind-probe/` (outside the repo). Original `node_modules/passkey-kit` in the checkout was **not** modified. No claim release, prepare/submit, or M2 acceptance was completed on these probes.
