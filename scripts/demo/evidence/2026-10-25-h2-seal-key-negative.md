# H2 — different-seal-key negative control (25 Oct 2026)

**Status: PASS** (isolated DB + Stellar vault; API restarted between steps)

| Step | Result |
| --- | --- |
| Fund with seal key A | payment `pay_60ba57817d4545c75f9fef4f` locked; payoutId `45`; lockTxRef `d0d00f396d6fde0a3b1fbf971dd4a9a5e2b135cb2644bcc9c064a546a7677033` |
| Restart API with **wrong** seal key B; accept same claim | HTTP **502** code `release_failed`; payment **processing**; **no** `releaseTxRef`; claim not accepted |
| Restart API with **original** seal key A; accept **same** claim | payment **paid**; same payoutId; releaseTxRef `01f2efdf976b4d35e2dea8016da46cb0909a798a0784e38ca63fd9eec2eeabca` |

## Isolation

- Embedded Postgres data dir: `apps/api/.pgdata-h2-seal` (port 54341) — not the default demo DB
- Settlement: `stellar` vault `CCG232ACW63XVUQGMMA6SWV46W2HIVR2ZSB5ENXHOIIITQBXUBHHIUMN`
- No claim token / seal key / secret in this file

## Safety checks

- Wrong-key error body did not include claim token, sealed ciphertext, or env key names
- Wrong-key path did not set `releaseTxRef` or mark payment paid

## Machine-readable summary

```json
{
  "milestone": "H2",
  "title": "different-seal-key negative control",
  "commitHint": "event/csenge-cursor/E1-anchor-cashout (run from working tree; push with evidence)",
  "settlement": "stellar",
  "vaultId": "CCG232ACW63XVUQGMMA6SWV46W2HIVR2ZSB5ENXHOIIITQBXUBHHIUMN",
  "isolatedDb": true,
  "pgPort": 54341,
  "apiPort": 8791,
  "paymentId": "pay_60ba57817d4545c75f9fef4f",
  "payoutId": "45",
  "lockTxRef": "d0d00f396d6fde0a3b1fbf971dd4a9a5e2b135cb2644bcc9c064a546a7677033",
  "releaseTxRef": "01f2efdf976b4d35e2dea8016da46cb0909a798a0784e38ca63fd9eec2eeabca",
  "wrongKeyAccept": {
    "httpStatus": 502,
    "code": "release_failed",
    "messageSafe": true,
    "paymentStatusAfter": "processing",
    "releaseTxRefAfter": null,
    "claimNotAccepted": true
  },
  "restoredKeyAccept": {
    "httpStatus": 200,
    "paymentStatus": "paid",
    "samePayoutId": true,
    "releaseTxRef": "01f2efdf976b4d35e2dea8016da46cb0909a798a0784e38ca63fd9eec2eeabca"
  },
  "notes": [
    "Seal keys generated for this run only; never logged or committed.",
    "Claim token kept under /tmp/fp-e1-private only; deleted after evidence write.",
    "Baseline vault used (H2 is seal custody, not anchor asset)."
  ],
  "completedAt": "2026-10-25T11:38:17.692Z"
}
```
