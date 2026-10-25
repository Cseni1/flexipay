# H1 — Stellar fee-drift / CCR-15 (25 Oct 2026)

**Status: PASS** (isolated DB; baseline vault untouched)  
**Label:** configuration drift between vaults (quote @ baseline **100** bps → fund @ H1 **50** bps) — not an on-chain fee change of the baseline vault.

| Step | Result |
| --- | --- |
| Quote/create @ baseline CCG232ACW63XVUQGMMA6SWV46W2HIVR2ZSB5ENXHOIIITQBXUBHHIUMN (100 bps) | payment `pay_9aabd5f48eb0157f6293dda4`; frozen flexiPayFee `197029` |
| Restart @ H1 vault `CDJTQB6AO7DWGF6PE47GPYLZOJA5QHPSELVXV6BYEMGODP5RPTHVOTWX` (50 bps) → fund | **409** `fee_drift` |
| After drift | payment **refunded**; settle **failed**/`fee_drift`; payoutId `3` |
| Claim accept | **409** `settle_failed`; claim stays **open** |
| Lock tx | `59db344b9d21a1977ba0c417d632349f119f38eb55cb5d0912884f7587bf0c3d` (`create_payout`, amount 19702970, mode PayerPays) |
| Cancel/refund tx | `e9d0418c629761e9a2fb30fcfdc75181d4b2971e27c8ddc2f74292035ebd1be5` (`cancel`) |
| Conservation | vault balance before fund `39799998` → after refund `59699997` (no shrink; lock fee not retained) |
| Replay fund/accept | 200 refunded / 409 settle_failed; refs unchanged |

## Decoded (same vault + payoutId path)

```json
{
  "lock": {
    "hash": "59db344b9d21a1977ba0c417d632349f119f38eb55cb5d0912884f7587bf0c3d",
    "status": "SUCCESS",
    "ledger": 5381229,
    "functionName": "create_payout",
    "contractId": "CDJTQB6AO7DWGF6PE47GPYLZOJA5QHPSELVXV6BYEMGODP5RPTHVOTWX",
    "args": [
      "GA3VFDLARJMD7IBYZ2EW3SDQBAIASVSFLFKKBLCNI4D3KDMWDQJX6D6F",
      {
        "type": "Buffer",
        "data": [
          113,
          31,
          55,
          155,
          129,
          96,
          205,
          193,
          116,
          198,
          222,
          118,
          157,
          244,
          67,
          90,
          127,
          162,
          218,
          29,
          75,
          118,
          102,
          221,
          167,
          98,
          209,
          220,
          5,
          142,
          136,
          56
        ]
      },
      {
        "type": "Buffer",
        "data": [
          82,
          45,
          19,
          6,
          100,
          229,
          90,
          186,
          146,
          83,
          5,
          146,
          230,
          26,
          73,
          172,
          15,
          196,
          216,
          142,
          29,
          132,
          250,
          151,
          143,
          151,
          15,
          155,
          216,
          148,
          26,
          108
        ]
      },
      "19702970",
      [
        "PayerPays"
      ],
      "1792929835"
    ]
  },
  "refund": {
    "hash": "e9d0418c629761e9a2fb30fcfdc75181d4b2971e27c8ddc2f74292035ebd1be5",
    "status": "SUCCESS",
    "ledger": 5381231,
    "functionName": "cancel",
    "contractId": "CDJTQB6AO7DWGF6PE47GPYLZOJA5QHPSELVXV6BYEMGODP5RPTHVOTWX",
    "args": [
      "3"
    ]
  }
}
```

## Machine-readable

```json
{
  "milestone": "H1",
  "title": "Stellar fee-drift / CCR-15 public API (config drift between vaults)",
  "status": "PASS",
  "label": "configuration drift between vaults (quote@baseline 100 bps → fund@H1 50 bps); not an on-chain fee change of the baseline vault",
  "baselineVaultId": "CCG232ACW63XVUQGMMA6SWV46W2HIVR2ZSB5ENXHOIIITQBXUBHHIUMN",
  "h1VaultId": "CDJTQB6AO7DWGF6PE47GPYLZOJA5QHPSELVXV6BYEMGODP5RPTHVOTWX",
  "sameToken": "CCZAEMZPSOOZLAZTN3KQVLXYVMJGEI7BDRVNMRM5TSQTHTX4EITONUGT",
  "baselineFeeBps": 100,
  "h1FeeBps": 50,
  "frozenFlexiPayFee": "197029",
  "quotedPrincipal": "19702970",
  "decodedLock": {
    "functionName": "create_payout",
    "amount": "19702970",
    "feeMode": "PayerPays",
    "impliedFeeAt50Bps": "98514",
    "frozenFlexiPayFee100Bps": "197029",
    "contractId": "CDJTQB6AO7DWGF6PE47GPYLZOJA5QHPSELVXV6BYEMGODP5RPTHVOTWX"
  },
  "paymentId": "pay_9aabd5f48eb0157f6293dda4",
  "payoutId": "3",
  "lockTxRef": "59db344b9d21a1977ba0c417d632349f119f38eb55cb5d0912884f7587bf0c3d",
  "refundTxRef": "e9d0418c629761e9a2fb30fcfdc75181d4b2971e27c8ddc2f74292035ebd1be5",
  "fundHttp": {
    "status": 409,
    "code": "fee_drift"
  },
  "paymentStatus": "refunded",
  "claimAccept": {
    "status": 409,
    "code": "settle_failed"
  },
  "claimStatus": "open",
  "conservation": {
    "balanceBeforeFund": "39799998",
    "balanceAfterRefund": "59699997",
    "noShrinkAfterRefund": true
  },
  "replay": {
    "fundStatus": 200,
    "fundPaymentStatus": "refunded",
    "acceptStatus": 409,
    "acceptCode": "settle_failed",
    "refsUnchanged": true
  },
  "decoded": {
    "lock": {
      "hash": "59db344b9d21a1977ba0c417d632349f119f38eb55cb5d0912884f7587bf0c3d",
      "status": "SUCCESS",
      "ledger": 5381229,
      "functionName": "create_payout",
      "contractId": "CDJTQB6AO7DWGF6PE47GPYLZOJA5QHPSELVXV6BYEMGODP5RPTHVOTWX",
      "args": [
        "GA3VFDLARJMD7IBYZ2EW3SDQBAIASVSFLFKKBLCNI4D3KDMWDQJX6D6F",
        {
          "type": "Buffer",
          "data": [
            113,
            31,
            55,
            155,
            129,
            96,
            205,
            193,
            116,
            198,
            222,
            118,
            157,
            244,
            67,
            90,
            127,
            162,
            218,
            29,
            75,
            118,
            102,
            221,
            167,
            98,
            209,
            220,
            5,
            142,
            136,
            56
          ]
        },
        {
          "type": "Buffer",
          "data": [
            82,
            45,
            19,
            6,
            100,
            229,
            90,
            186,
            146,
            83,
            5,
            146,
            230,
            26,
            73,
            172,
            15,
            196,
            216,
            142,
            29,
            132,
            250,
            151,
            143,
            151,
            15,
            155,
            216,
            148,
            26,
            108
          ]
        },
        "19702970",
        [
          "PayerPays"
        ],
        "1792929835"
      ]
    },
    "refund": {
      "hash": "e9d0418c629761e9a2fb30fcfdc75181d4b2971e27c8ddc2f74292035ebd1be5",
      "status": "SUCCESS",
      "ledger": 5381231,
      "functionName": "cancel",
      "contractId": "CDJTQB6AO7DWGF6PE47GPYLZOJA5QHPSELVXV6BYEMGODP5RPTHVOTWX",
      "args": [
        "3"
      ]
    }
  },
  "completedAt": "2026-10-25T12:02:25.106Z"
}
```
