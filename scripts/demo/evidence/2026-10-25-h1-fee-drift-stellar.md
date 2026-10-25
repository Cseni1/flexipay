# H1 — Stellar fee-drift / CCR-15 (25 Oct 2026)

**Status: PASS** (isolated DB; baseline vault untouched)

**Label:** configuration drift between vaults (quote @ baseline **100** bps →
fund @ isolated **50** bps) — not an on-chain fee change of the baseline vault.

| Item        | Value                                                       |
| ----------- | ----------------------------------------------------------- |
| Base commit | `5bd347d`                                                   |
| Source      | H1 driver/evidence commit in this PR                        |
| Run         | one execute attempt, `12:20:24`–`12:20:46Z`; no retry       |
| API         | `http://127.0.0.1:8793`, isolated embedded Postgres `54343` |

| Step                                                                                          | Result                                                                                                       |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Quote/create @ baseline CCG232ACW63XVUQGMMA6SWV46W2HIVR2ZSB5ENXHOIIITQBXUBHHIUMN (100 bps)    | payment `pay_608dab015802009b2e7bcd95`; principal `19702970`; frozen flexiPayFee `197029`                    |
| Restart @ H1 vault `CDJTQB6AO7DWGF6PE47GPYLZOJA5QHPSELVXV6BYEMGODP5RPTHVOTWX` (50 bps) → fund | **409** `fee_drift`                                                                                          |
| After drift                                                                                   | payment **refunded**; settle **failed**/`fee_drift`; payoutId `4`                                            |
| Decoded lock                                                                                  | `create_payout` amount `19702970`, fee `98514`, locked `19801484`, status `Refunded`                         |
| Decoded refund                                                                                | `cancel` payout `4` on the same vault                                                                        |
| Claim accept                                                                                  | **409** `settle_failed`; claim stays **open**                                                                |
| Lock tx                                                                                       | `770268850f99f709e6e4c82f9eac0adec2cde334fe7d6cde3d74086a9ad69995`                                           |
| Refund tx (`releaseTxRef`)                                                                    | `8a623c063fd3743718299c98a74dfb779a4af15b51e2db81935a2b21d97ffc93`                                           |
| Conservation                                                                                  | before fund `59699997` + deposit `19899999` = before lock `79599996` = after refund `79599996`; no fee taken |
| Replay fund/accept                                                                            | 200 refunded / 409 settle_failed; refs unchanged; `payout_by_external` = `4`                                 |

## Durable state after the API stopped

Read-only query of the isolated database used by both API processes:

| Item         | Value                                                                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment      | `pay_608dab015802009b2e7bcd95`, status `refunded`, `lockAttempt=1`                                                                                             |
| Quote        | `quo_35920317f641e4f1`                                                                                                                                         |
| Settle leg   | `leg_c1004db9e47dee83b40cb3e7`, status `failed`, attempt `1`, `errorCode=fee_drift`                                                                            |
| Durable refs | payout `4`, lock `770268850f99f709e6e4c82f9eac0adec2cde334fe7d6cde3d74086a9ad69995`, refund `8a623c063fd3743718299c98a74dfb779a4af15b51e2db81935a2b21d97ffc93` |
| Stored error | `lock fee drift: locked.fee=98514 USDC != quoted flexiPayFee=197029 USDC (CCR-13)`                                                                             |
| Events       | one lock `payment.onchain`, one refund `payment.onchain`, one `leg.failed`, one `payment.refunded`, **zero** `payment.paid`                                    |
| Claim        | stays `open`                                                                                                                                                   |

The settle leg keeps its payout id, lock hash and refund hash after the failure;
they are not cleared. This is the durable-failure evidence, read from the
stopped API's database rather than inferred from one HTTP response.

## Reconciliation of submitted transactions

The H1 vault already held payouts `1`–`3` from Cursor's earlier run
(`12:00`–`12:02Z`). All three are `Refunded` with fee `98514` and locked
`19801484`; they are separate payments and are not part of this acceptance. This
run's payment used payout `4` and exactly three payer transactions:

| Step    | Transaction                                                        | Amount                            |
| ------- | ------------------------------------------------------------------ | --------------------------------- |
| Deposit | `6351e6a6e7f1054d86b26e890cab8feae26fad93510d1baf33be94721c42bc70` | `19899999`                        |
| Lock    | `770268850f99f709e6e4c82f9eac0adec2cde334fe7d6cde3d74086a9ad69995` | `19702970` principal, `98514` fee |
| Refund  | `8a623c063fd3743718299c98a74dfb779a4af15b51e2db81935a2b21d97ffc93` | `19801484` locked returned        |

There is no pending H1 payout. The run used one execute attempt and no retry.

## Baseline isolation

- Baseline ids file was not modified.
- Baseline vault `CCG232AC…` still reports token `CCZAEMZP…`, treasury
  `GDH7WGA…` and **100** bps.
- Baseline payer vault balance stayed `2025424998` across the run.
- The H1 vault `CDJTQB6A…` is distinct and reports the same token, same treasury
  and **50** bps.

## Decoded

```json
{
	"lock": {
		"hash": "770268850f99f709e6e4c82f9eac0adec2cde334fe7d6cde3d74086a9ad69995",
		"status": "SUCCESS",
		"ledger": 5381450,
		"functionName": "create_payout",
		"contractId": "CDJTQB6AO7DWGF6PE47GPYLZOJA5QHPSELVXV6BYEMGODP5RPTHVOTWX",
		"args": [
			"GA3VFDLARJMD7IBYZ2EW3SDQBAIASVSFLFKKBLCNI4D3KDMWDQJX6D6F",
			{
				"type": "Buffer",
				"data": [
					115, 227, 185, 133, 216, 56, 199, 163, 63, 63, 208, 163, 127, 205,
					114, 79, 117, 147, 156, 53, 220, 84, 48, 28, 84, 219, 196, 6, 78, 230,
					244, 176
				]
			},
			{
				"type": "Buffer",
				"data": [
					40, 74, 234, 162, 118, 222, 29, 202, 180, 143, 161, 124, 63, 74, 0,
					179, 13, 66, 79, 212, 44, 10, 254, 184, 134, 143, 199, 216, 250, 108,
					49, 118
				]
			},
			"19702970",
			["PayerPays"],
			"1792930947"
		]
	},
	"refund": {
		"hash": "8a623c063fd3743718299c98a74dfb779a4af15b51e2db81935a2b21d97ffc93",
		"status": "SUCCESS",
		"ledger": 5381451,
		"functionName": "cancel",
		"contractId": "CDJTQB6AO7DWGF6PE47GPYLZOJA5QHPSELVXV6BYEMGODP5RPTHVOTWX",
		"args": ["4"]
	},
	"payout": {
		"id": "4",
		"payer": "GA3VFDLARJMD7IBYZ2EW3SDQBAIASVSFLFKKBLCNI4D3KDMWDQJX6D6F",
		"externalId": {
			"type": "Buffer",
			"data": [
				115, 227, 185, 133, 216, 56, 199, 163, 63, 63, 208, 163, 127, 205, 114,
				79, 117, 147, 156, 53, 220, 84, 48, 28, 84, 219, 196, 6, 78, 230, 244,
				176
			]
		},
		"claimHash": {
			"type": "Buffer",
			"data": [
				40, 74, 234, 162, 118, 222, 29, 202, 180, 143, 161, 124, 63, 74, 0, 179,
				13, 66, 79, 212, 44, 10, 254, 184, 134, 143, 199, 216, 250, 108, 49, 118
			]
		},
		"gross": "19702970",
		"fee": "98514",
		"net": "19702970",
		"locked": "19801484",
		"expiresAt": "1792930947",
		"status": "Refunded"
	}
}
```

## Machine-readable

```json
{
	"milestone": "H1",
	"title": "Stellar fee-drift / CCR-15 public API (configuration drift between vaults)",
	"status": "PASS",
	"label": "configuration drift between vaults (quote @ baseline 100 bps → fund @ isolated 50 bps); not an on-chain fee change of the baseline vault",
	"baselineVaultId": "CCG232ACW63XVUQGMMA6SWV46W2HIVR2ZSB5ENXHOIIITQBXUBHHIUMN",
	"h1VaultId": "CDJTQB6AO7DWGF6PE47GPYLZOJA5QHPSELVXV6BYEMGODP5RPTHVOTWX",
	"sameToken": "CCZAEMZPSOOZLAZTN3KQVLXYVMJGEI7BDRVNMRM5TSQTHTX4EITONUGT",
	"baselineFeeBps": 100,
	"h1FeeBps": 50,
	"frozenPrincipal": "19702970",
	"frozenFlexiPayFee": "197029",
	"paymentId": "pay_608dab015802009b2e7bcd95",
	"payoutId": "4",
	"lockTxRef": "770268850f99f709e6e4c82f9eac0adec2cde334fe7d6cde3d74086a9ad69995",
	"refundTxRef": "8a623c063fd3743718299c98a74dfb779a4af15b51e2db81935a2b21d97ffc93",
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
	"decodedLock": {
		"functionName": "create_payout",
		"amount": "19702970",
		"feeMode": "PayerPays",
		"fee": "98514",
		"locked": "19801484",
		"net": "19702970",
		"status": "Refunded",
		"contractId": "CDJTQB6AO7DWGF6PE47GPYLZOJA5QHPSELVXV6BYEMGODP5RPTHVOTWX"
	},
	"conservation": {
		"balanceBeforeFund": "59699997",
		"depositPayerPays": "19899999",
		"balanceBeforeLock": "79599996",
		"balanceAfterRefund": "79599996",
		"exactEquality": true,
		"noFeeTaken": true
	},
	"replay": {
		"fundStatus": 200,
		"fundPaymentStatus": "refunded",
		"acceptStatus": 409,
		"acceptCode": "settle_failed",
		"refsUnchanged": true,
		"payoutByExternal": "4",
		"noSecondLock": true
	},
	"decoded": {
		"lock": {
			"hash": "770268850f99f709e6e4c82f9eac0adec2cde334fe7d6cde3d74086a9ad69995",
			"status": "SUCCESS",
			"ledger": 5381450,
			"functionName": "create_payout",
			"contractId": "CDJTQB6AO7DWGF6PE47GPYLZOJA5QHPSELVXV6BYEMGODP5RPTHVOTWX",
			"args": [
				"GA3VFDLARJMD7IBYZ2EW3SDQBAIASVSFLFKKBLCNI4D3KDMWDQJX6D6F",
				{
					"type": "Buffer",
					"data": [
						115, 227, 185, 133, 216, 56, 199, 163, 63, 63, 208, 163, 127, 205,
						114, 79, 117, 147, 156, 53, 220, 84, 48, 28, 84, 219, 196, 6, 78,
						230, 244, 176
					]
				},
				{
					"type": "Buffer",
					"data": [
						40, 74, 234, 162, 118, 222, 29, 202, 180, 143, 161, 124, 63, 74, 0,
						179, 13, 66, 79, 212, 44, 10, 254, 184, 134, 143, 199, 216, 250,
						108, 49, 118
					]
				},
				"19702970",
				["PayerPays"],
				"1792930947"
			]
		},
		"refund": {
			"hash": "8a623c063fd3743718299c98a74dfb779a4af15b51e2db81935a2b21d97ffc93",
			"status": "SUCCESS",
			"ledger": 5381451,
			"functionName": "cancel",
			"contractId": "CDJTQB6AO7DWGF6PE47GPYLZOJA5QHPSELVXV6BYEMGODP5RPTHVOTWX",
			"args": ["4"]
		}
	},
	"completedAt": "2026-10-25T12:20:46.104Z"
}
```
