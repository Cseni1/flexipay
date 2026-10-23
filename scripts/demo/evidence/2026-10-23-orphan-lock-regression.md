# Orphan-lock regression check — 23 October 2026

**Status: defect reproduced; regression check prepared for the API owner. No
API/domain change made.** This is branch evidence, not acceptance on `main`.

**Follow-up:** on `main` `286d044` the duplicate-lock half is fixed (refs are
persisted before the drift throw and replay never re-locks). CCR-15 durable
failure/refund recovery is still open, and a drifted lock can still be paid
through claim accept. See `2026-10-23-orphan-lock-286d044.md`.

- Tested tree: lane-D `csenge-freebuff/D3-acceptance` at **`1a34c9f`** (merge of
  `origin/main` **`b06a814`**). API/domain files are identical to `b06a814`; the
  merge only reconciled lane-D files.
- Mode: `FP_SETTLEMENT=mock`, embedded Postgres on `127.0.0.1:54329`, API on
  `127.0.0.1:3199`, Node **v24.21.0**, one locally provisioned Demo Platform
  key.
- No testnet call, no real funds, no new endpoint, no API code change.

## The defect

A lock can succeed and then be rejected for fee drift **before its identifiers
are persisted**, so the successful lock becomes unreachable and a retry locks
again.

`apps/api/src/orchestrator/run.ts`:

- L494 derives the external id from `payment.lockAttempt + 1`;
- L528 funds the vault, L530–540 `settlement.lock(...)` succeeds;
- L541–547 throws `lock fee drift` when `locked.fee` differs from the frozen
  `quote.fees.flexiPayFee`;
- L549–555 persist `externalRef = locked.payoutId` and
  `lockTxRef = locked.txRef` **only after** that throw.

Consequences:

1. The payment is not marked paid, but it stays `processing` with no durable
   error and no lock event — stuck rather than failed.
2. `Leg.externalRef` / `Leg.lockTxRef` remain null, so the payout cannot be
   recovered through `SettlementAdapter.status`/`refund` even though both
   adapters implement `findLock` (`packages/adapters-sim/src/settlement.ts:108`,
   `packages/adapter-stellar/src/settlement.ts:136`). `findLock` is never called
   by `apps/api/src` — the recovery primitive exists but is unused.
3. A retry increments `Payment.lockAttempt` and therefore derives a **new**
   external id (`sha256("<payment>:2")`). The vault does not raise
   `DuplicateExternalId`, so a second payout is created. Both are pending and
   both ids are lost.
4. `Leg.attempt` is not advanced for settle locks: after the retry the durable
   row shows `Payment.lockAttempt = 2` while `Leg.attempt = 1`. Anything that
   recovers by `Leg.attempt` would look up the wrong external id. CCR-14 names
   `Leg.attempt` as the durable source of truth, so this divergence needs an
   owner decision.

The existing unit test `CCR-13: rejects settle when locked.fee drifts…`
(`apps/api/test/orchestrator.test.ts:472`) currently **asserts the bug**: it
expects `externalRef` and `lockTxRef` to be null after the drift (L520–522).
That file was not edited by lane D.

## Runtime reproduction through the public API only

Injection is safe and uses no invented surface: make the vault fee differ from
the frozen quote by restarting the API with a different `FP_VAULT_FEE_BPS`
between quote and fund. This is the real config-drift case CCR-13 describes, on
mock only.

1. API with `FP_VAULT_FEE_BPS=100`, same DB and seal key:
   - `POST /v1/recipients` 201
   - `POST /v1/quotes` (PH crypto, PayerPays, 100000 USD) 201
     - settle `amountIn` = **9826856435 USDC**, frozen `flexiPayFee` =
       **98268564 USDC** (100 bps), remainder 1
   - `POST /v1/payments` (`claim_link`) 201, status `awaiting_funding`
2. Restart the API with `FP_VAULT_FEE_BPS=50` (same `DATABASE_URL`, `.pgdata`,
   seal key): `POST /v1/payments/{id}/fund` → **409** `invalid_state`,
   `lock fee drift: locked.fee=49134282 USDC != quoted flexiPayFee=98268564 USDC (CCR-13)`.
3. `GET /v1/payments/{id}` → **200**:
   - payment `status: processing` (not `paid`);
   - settle leg `status: processing`, `attempt: 1`, `externalRef: null`,
     `lockTxRef: null`, `error: null`;
   - events stop at `payment.processing` + two `leg.succeeded`; no
     `payment.onchain` lock event and no `leg.succeeded` for settle.
4. Retry `POST …/fund` with the same drifted fee → **409 drift again, not
   `DuplicateExternalId`**. Under RULES.md the second call used
   `sha256("<payment>:2")` and therefore created a second payout. Direct DB read
   of the disposable database confirms `Payment.lockAttempt = 2`,
   `Leg.attempt = 1`, settle `externalRef`/`lockTxRef` null.
5. The mock vault is in-process, so a process restart cannot preserve payouts to
   observe them; restart-based proof must use a persistent vault (Stellar) or
   the backend test below, which holds one adapter/vault across a fresh adapters
   bundle.

## Exact backend regression check for CC2 (Cursor)

Replace the assertions at `apps/api/test/orchestrator.test.ts:520–522` (they
encode the defect) and add the retry/recovery assertions below. It uses only
existing fixtures and helpers (`seedQuote`, `cryptoClaimRoute`, `fundAndRun`,
`getPaymentView`) — no new harness, endpoint or production code.

```ts
it("CCR-13 orphan lock: drift keeps payoutId/lockTxRef; retry after restart does not re-lock", async () => {
	sim.controls.reset()
	const fee = "98268564"
	let lockCalls = 0
	const drifting = new MockSettlementAdapter({
		token: "USDC",
		treasury: "GDEMOTREASURY0000000000000000000000000000000000000000",
		feeBps: 100,
		now: () => clock.now,
	})
	const origLock = drifting.lock.bind(drifting)
	drifting.lock = async (req) => {
		lockCalls += 1
		const locked = await origLock(req)
		// The lock succeeds on-chain; only the returned fee is wrong.
		return { ...locked, fee: money("1", "USDC") }
	}

	const { orgId } = await t.newOrg("Demo Platform")
	const { recipientId, quoteId } = await seedQuote(orgId, {
		feeMode: "PayerPays",
		route: cryptoClaimRoute,
		fees: {
			legs: [
				{ kind: "collect", rail: "sim_bank_us_ach", fee: money("0", "USD") },
				{ kind: "convert", rail: "sim_fx", fee: money("125", "USD") },
				{ kind: "settle", rail: "stellar_usdc", fee: money(fee, "USDC") },
			],
			flexiPayFee: money(fee, "USDC"),
			total: money("125", "USD"),
			settleUnlockedRemainder: money("1", "USDC"),
		},
		destination: {
			type: "crypto_wallet",
			currency: "USDC",
			country: "PH",
			recipientKind: "individual",
		},
	})
	const { paymentId } = await createPaymentFromQuote(db, {
		organizationId: orgId,
		recipientId,
		quoteId,
		delivery: "claim_link",
		profile: "one_off",
	})

	await expect(
		fundAndRun(db, paymentId, { ...adapters(), settlement: drifting }),
	).rejects.toThrow(/lock fee drift/i)
	expect(lockCalls).toBe(1)

	// Nothing may report success, and the successful lock must stay recoverable (CCR-12).
	const afterDrift = await getPaymentView(db, paymentId)
	expect(afterDrift.status).not.toBe("paid")
	const firstSettle = afterDrift.legs.find((l) => l.kind === "settle")!
	expect(firstSettle.externalRef).toBe("1") // mock payout id, not a hash
	expect(firstSettle.lockTxRef).toMatch(/^mock-tx-/)
	expect(await drifting.status(firstSettle.externalRef!)).toMatchObject({
		state: "pending",
	})

	// A fresh adapters bundle over the same DB and payout vault models a restart.
	// The lock already exists, so the retry must recover it, not lock again.
	await fundAndRun(db, paymentId, { ...adapters(), settlement: drifting })
	expect(lockCalls).toBe(1)
	const afterRetry = await getPaymentView(db, paymentId)
	const retrySettle = afterRetry.legs.find((l) => l.kind === "settle")!
	expect(retrySettle.externalRef).toBe("1")
	expect(afterRetry.status).not.toBe("paid")

	// Published recovery contract (RULES.md): cancel/refund the pending payout;
	// neither outcome may mark the payment paid.
	await drifting.refund("1") // cancel before expiry (payer-authorised)
	expect((await drifting.status("1")).state).toBe("refunded")
	expect((await getPaymentView(db, paymentId)).status).not.toBe("paid")
})
```

(Call `getPaymentView`/`createPaymentFromQuote` from the existing imports;
`drifting.refund` uses RULES.md `cancel` before expiry. The mock vault is fresh
in this test, so the payout id is `"1"`.)

Current behaviour: fails at `expect(firstSettle.externalRef).toBe("1")` (actual
`null`). With only that line relaxed, the retry step rejects with the same drift
instead of resolving: the retry reaches `lock()` a second time (`lockCalls = 2`)
because `externalRef` was lost, which is the duplicate lock. After a fix that
persists the id, the retry resolves, `lockCalls` stays `1`, and `externalRef`
stays `"1"`.

**Acceptance for the fix (owner CC2):**

- Persist `payoutId`/`lockTxRef` as soon as `lock()` returns, before any
  fee/quote check, or recover via `findLock(payer, paymentId, attempt)` on retry
  using the attempt that produced the lock.
- Do not advance the lock attempt until the previous attempt is known not to
  have locked (or reuse the current attempt for `findLock`).
- Keep `payment.status !== "paid"`; record a durable failure/event for the drift
  so a stuck `processing` payment can be found; do not silently retry a drifted
  lock.
- Decide and document the recovery outcome (cancel/refund via the adapter, per
  RULES.md) and whether retrying after recovery is allowed with a new attempt
  id.
- Keep `Leg.attempt` consistent with the attempt used for the external id, or
  document that `Payment.lockAttempt` is the lock-attempt source of truth
  (CCR-14 says `Leg.attempt`).

## Checks run on this tree

| Check                                                 | Command                                                                           | Exit                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Prisma client current with schema                     | `npx prisma generate` (apps/api)                                                  | 0                                                               |
| CCR-13 unit tests (incl. the bug-encoding assertions) | `npx vitest run test/orchestrator.test.ts -t "CCR-13"`                            | 0 — 2 passed                                                    |
| Lane-D types                                          | `npx tsc -p scripts/demo/tsconfig.json`                                           | 0                                                               |
| Lane-D harness/seed/offline/proof tests               | `npx vitest run tests/e2e/{harness,preflight,seed,offline,stellar-proof}.test.ts` | 0 — 72 passed                                                   |
| API boot on Node 24                                   | `node scripts/dev-db.ts serve`, `GET /healthz`                                    | 0 — 200                                                         |
| Seed                                                  | `node scripts/seed/seed.ts` (reset + 4 recipients)                                | 2 — BLOCKED at `POST /v1/endpoints`                             |
| Seed/reset replay                                     | same command a second time                                                        | 2 — reset 200, same 4 recipient ids, same endpoint blocker      |
| DF1–DF5 mock                                          | `node scripts/demo/run-all.ts`                                                    | 2 — all BLOCKED at `POST /v1/endpoints`; DF1 also needs batches |

Online DF3 Stellar was **not** run: the endpoint/batch routes are still absent,
the accounting fix is not accepted on `main`, and no testnet prerequisites were
verified. Restart acceptance (same DB, same seal key) was **not** run: it
requires a working mock claim acceptance, which is unreachable without
`POST /v1/endpoints`.

## Next blockers

1. **CC2 (Cursor):** apply the fix and replace the bug-encoding assertions with
   the check above. This is the only lane-D unblock that does not need a new
   contract.
2. **A0/CC3b (Csaba/Cursor):** `POST/GET /v1/endpoints` and `POST /v1/batches`,
   `GET /v1/batches/{id}` still have no accepted request/response schema; PR #43
   is PARTIAL and adds none. Seed and DF1–DF5, restart acceptance and online DF3
   remain blocked on it.
3. **Claim:** `ClaimView`/`ClaimAccept` are published and mounted; DF3 already
   uses the claim token, view and crypto accept. No lane-D change is warranted
   until endpoints exist. Fiat accept and `details` keys remain uncontracted and
   are rejected by the API.
