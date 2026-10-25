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
| Cancel/refund tx | `e9d0418c629761e9a2fb30fcfdc75181d4b2971e27c8ddc2f74292035ebd1be5` (`cancel` payoutId `3`) |
| Conservation | **VERIFIED** — (2)==(3); funding credit `19899999`; fee not retained (see below) |
| Replay fund/accept | fund HTTP 200/`refunded`; accept HTTP 409/`settle_failed`; refs unchanged; **0** new vault txs on replay |

## Conservation (clarified — existing txs only; no rerun)

“No shrink” alone is insufficient. Required identity: **(2) == (3)** with no fee retained after cancel.

| Step | Balance | Source |
| --- | --- | --- |
| (1) before funding | `39799998` | measured `vault.balance` before fund |
| (2) after funding, immediately before lock | `59699997` | reconstructed: (1) + fundAmount |
| (3) after refund | `59699997` | measured `vault.balance` after cancel |

**Funding credit (exact):** PayerPays `fundVault = P + frozenFlexiPayFee(100 bps)` = `19702970 + 197029` = **`19899999`**.

| Check | Result |
| --- | --- |
| deposit tx | `f147ddee9f90d09fb48f458c8493c8c5172a901ef8eb39a64cff41ffeb031237` |
| deposit args | payer `GA3VF…`, amount **`19899999`** (matches fundAmount) |
| (3) − (1) | `19899999` (= funding credit) |
| (2) == (3) | **true** (`59699997`) |
| fee retained after cancel | **false** (full credit still in vault balance) |
| lock fee @ 50 bps (would-have) | `98514` vs frozen quote fee `197029` (drift cause; cancel restores full lock) |
| treasury classic transfers on lock/cancel ops | none visible in Horizon op records (weak alone; conservation rests on (2)==(3) + deposit decode) |

**Verdict: CONSERVATION_VERIFIED** from existing Horizon/Soroban evidence (deposit + create_payout + cancel). No additional chain submit required.

## Lock / cancel hashes + payoutId match

| Role | Full hash | Decoded |
| --- | --- | --- |
| deposit (fund) | `f147ddee9f90d09fb48f458c8493c8c5172a901ef8eb39a64cff41ffeb031237` | `deposit(GA3VF…, 19899999)` ledger `5381227` |
| lock | `59db344b9d21a1977ba0c417d632349f119f38eb55cb5d0912884f7587bf0c3d` | `create_payout` P=`19702970` `PayerPays` vault `CDJTQB6A…` ledger `5381229` |
| cancel | `e9d0418c629761e9a2fb30fcfdc75181d4b2971e27c8ddc2f74292035ebd1be5` | `cancel(3)` same vault ledger `5381231` |

Evidence `payoutId` **`3`** == cancel arg **`3`**. Same vault for lock and cancel.

## Replay event / transaction counts

| Layer | Count / observation |
| --- | --- |
| Vault txs for this payment path | **3** (deposit → create_payout → cancel); distinct hashes above |
| New vault txs on API replay | **0** expected; no second create_payout/cancel for payoutId `3` on chain |
| API replay (evidence machine block) | fund status **200** / payment **`refunded`**; accept status **409** / code **`settle_failed`**; settle refs **unchanged** |
| Durable `/v1/events` rows | **not retained** (isolated DB destroyed after run) — HTTP statuses + unchanged refs + chain hash set are the durable proof |

Prior aborted H1 attempts on the same vault (payoutId `1`/`2`) are out of scope for this payment; the PASS path is payoutId **`3`** only.

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
    "verdict": "CONSERVATION_VERIFIED",
    "balance_1_before_funding": "39799998",
    "balance_2_after_funding_before_lock": "59699997",
    "balance_3_after_refund": "59699997",
    "equality_2_equals_3": true,
    "fundingCredit": "19899999",
    "fundingCreditFormula": "PayerPays fundVault = principal + frozenFlexiPayFee(100bps)",
    "depositTxRef": "f147ddee9f90d09fb48f458c8493c8c5172a901ef8eb39a64cff41ffeb031237",
    "depositAmount": "19899999",
    "feeRetainedAfterCancel": false,
    "noShrinkAfterRefund": true,
    "note": "noShrink alone insufficient; identity is (2)==(3) with full funding credit restored after cancel"
  },
  "replay": {
    "fundStatus": 200,
    "fundPaymentStatus": "refunded",
    "acceptStatus": 409,
    "acceptCode": "settle_failed",
    "refsUnchanged": true,
    "vaultTxCountPaymentPath": 3,
    "newVaultTxsOnReplay": 0,
    "durableApiEventRowsRetained": false
  },
  "payoutIdMatch": {
    "evidence": "3",
    "cancelArg": "3",
    "match": true
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
