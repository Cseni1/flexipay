# Handoff — Safari/Android hybrid: create OK, get focus fail

**To:** Csaba / Claude  
**Commit under test:** f5af666 (`flexipay-m2-accept`)  
**M2 status:** NOT VERIFIED  
**Do not delete** any local/Android saved passkeys from this attempt.

## Proven by same-origin sink (`/__fp_wa_diag`)

1. Origin/RP ID: `http://localhost:56640` / `localhost`
2. `credentials.create` → **ok** (hybrid QR → Android; ~16:24:40Z start → 16:33:43Z ok)
3. Immediately: `credentials.get` (kit Genesis binding proof) → **fail**
4. DOM: `NotAllowedError` / "The document is not focused."
5. Kit: `ValidationError` code 8003 / "WebAuthn authentication failed"
6. Flags: `createOk: true`, `getOk: false`
7. **Not** attestation/RPC/`api.deploy` (those stages never reached)
8. DB: no passkeyContractId / deploy hash / pending seal; claim later expired

## Product implication (for Csaba — do not weaken UV)

After a successful create (esp. cross-device), kit runs a **second** WebAuthn `get` without a fresh focused user gesture. Safari lost focus across the Android return path.

**Requested UI fix (Csaba):** explicit user action to run binding verification, **reusing the already-created credential** — do not force recreate. Cursor will not patch web/API for this.

## Next lane (Cursor)

One Chrome localhost Mac-local attempt on a new funded claim; no further Safari/Android retry unless Csaba asks.

## Follow-up — Chrome retry blocked on vault fund

`POST /fund` → 409: Total fee (baseFee * operations + resourceFee) exceeds uint32 (Got **5261104576**), repeated. No lockTx. Payer unlocked. Chrome Mac-local UVPAA true on localhost, but attempt deferred until lock works.
