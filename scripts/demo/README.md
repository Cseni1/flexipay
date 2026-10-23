# Demo flows (lane D, D1)

One script per acceptance flow from `tests/e2e/SCENARIOS.md` and ARCHITECTURE
§15. Each script calls the same API the UI calls, prints the route, the legs and
the result, and exits non-zero on failure. Fixtures are neutral: Demo Platform
and Worker A to Worker D (Worker D is the ZA company that DF5 needs).

## Status (23 Oct 2026)

**D1/D2 acceptance: PASS. CCR-11 restart acceptance: PASS on Stellar testnet.**
On integrated HEAD `b48bfe3` plus lane-D changes committed as `939a2f9`, all
five flows pass on the mock API and against Stellar testnet, the offline stack
runs under a network-denied sandbox, seed/replay pass, the DF2/DF3/DF5 browser
flows pass against the real loopback stack, and a funded claim survives an API
restart and releases its existing lock through the UI. The exact commands,
results, transaction hashes and screenshots are in
`scripts/demo/evidence/2026-10-23-d1-d2-final-acceptance.md` and
`scripts/demo/evidence/2026-10-23-ccr11-restart-stellar.md`. Per-run JSON
evidence is written to the same folder and git-ignored.

DF1 takes the domestic explanation from `Quote.reasons` (no batch-row reason
field is invented). DF4 proves the single retry from the published `Leg.attempt`
values in `Event.snapshot` legs, not from provider refs or the fixture's fail
count. DF3 reads `settle.externalRef` as the vault **payoutId** (CCR-12) and
verifies `lockTxRef` / `releaseTxRef` separately. The settle leg's status after
a refund is still not asserted.

| Flow                   | Script              | Mock | Stellar testnet |
| ---------------------- | ------------------- | ---- | --------------- |
| DF1 three-worker batch | `df1-batch.ts`      | PASS | PASS            |
| DF2 quote to paid      | `df2-one-off.ts`    | PASS | PASS            |
| DF3 claim link         | `df3-claim.ts`      | PASS | PASS (verified) |
| DF4 retry then refund  | `df4-failure.ts`    | PASS | PASS (verified) |
| DF5 ZA company         | `df5-za-company.ts` | PASS | PASS (no chain) |

## Run

```bash
# offline: embedded Postgres + API + web, mock settlement, loopback only
npm run demo:offline -- --no-seed
# or, without the root script:
node scripts/demo/offline.ts --no-seed

# one flow
FP_API_URL=http://127.0.0.1:3000 FP_API_KEY=... node scripts/demo/df2-one-off.ts

# DF3 on Stellar (needs Worker A's published address and a testnet RPC)
FP_API_URL=... FP_API_KEY=... FP_SETTLEMENT=stellar \
FP_RECIPIENT_A_ADDRESS=G... FP_STELLAR_RPC_URL=https://... \
FP_STELLAR_NETWORK_PASSPHRASE='Test SDF Network ; September 2015' \
FP_PAYOUT_VAULT_ID=C... \
node scripts/demo/df3-claim.ts --mode stellar

# every flow against Stellar testnet
node scripts/demo/run-all.ts --stellar
```

Prerequisites are read from the environment; nothing is committed.

| Variable                        | Purpose                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `FP_API_URL`                    | Base URL of the integrated API                                     |
| `FP_API_KEY`                    | Sandbox API key for the Demo Platform organization (never printed) |
| `FP_SETTLEMENT`                 | `mock` or `stellar`; DF3's `--mode` overrides it for one run       |
| `FP_OPENAPI_PATH`               | Route inventory, default `apps/api/openapi.json`                   |
| `FP_HTTP_TIMEOUT_MS`            | Per-request timeout, default 15000                                 |
| `FP_RECIPIENT_A_ADDRESS`        | Worker A's published testnet address; DF3 claim destination        |
| `FP_STELLAR_RPC_URL`            | Public testnet RPC used to verify the release hash                 |
| `FP_STELLAR_NETWORK_PASSPHRASE` | Expected testnet passphrase, checked against the RPC               |
| `FP_PAYOUT_VAULT_ID`            | Public payout_vault contract id the lock/release must invoke       |

DF3 does not take a vault fee from its own environment. On Stellar it reads the
deployed fee recorded in `scripts/testnet/testnet-ids.env` (the same public
evidence the API validates against on-chain `config()`) and refuses to run if
that file names a different vault. Mock mode checks frozen-quote vault-math
identities only. A separate caller `FP_VAULT_FEE_BPS` is not an acceptance
input.

`FP_API_URL` and `FP_API_KEY` are missing from the root `.env.example`; that
file is owned by the integrator. Until they are added, pass them inline or
export them.

### Offline launcher (D2)

The launcher starts the same development commands a person would run:

- `npm run dev --workspace @flexipay/api` — embedded Postgres, migrations, API;
- `npm run dev --workspace @flexipay/web` — Vite;
- `FP_SETTLEMENT=mock` and the simulated providers in `config/`;
- loopback only, no Docker, no second database, no queue.

| Variable                    | Purpose                               |
| --------------------------- | ------------------------------------- |
| `FP_API_PORT`               | API port, default 8788                |
| `FP_WEB_PORT`               | Vite port, default 5173               |
| `FP_OFFLINE_API_TIMEOUT_MS` | API readiness timeout, default 120000 |
| `FP_OFFLINE_WEB_TIMEOUT_MS` | Web readiness timeout, default 60000  |

It waits for `GET /healthz` and the Vite page before reporting ready, then runs
`scripts/seed/seed.ts` when `FP_API_KEY` is set. `--no-seed` skips that step;
`--print-plan` prints the loopback plan without starting anything. The root
`demo:offline` script is the integrator's one-line wiring; see the D2 evidence.

## Exit codes

| Code | Meaning                                                                              |
| ---- | ------------------------------------------------------------------------------------ |
| 0    | PASS — every assertion held                                                          |
| 1    | FAIL — the API answered but a rule was broken                                        |
| 2    | BLOCKED — a prerequisite is missing (route, A0 contract, adapter, address, API down) |

BLOCKED is never treated as a pass, and `run-all.ts` exits 2 unless every run
passed.

## What each flow proves

- **DF1** — three rows in one JSON batch; per-payment funding; US row has
  exactly `collect` and `payout` on `sim_bank_us_ach`, no convert/settle and no
  on-chain event; PH and BR rows have the five-leg stablecoin route with their
  payout rails. The domestic explanation is blocked on A0: reasons belong to a
  quote, and no batch-row reason field is defined.
- **DF2** — quote exposes route, fee breakdown, FX, expected receive and
  validity; the payment is created `awaiting_funding` with legs pending; after
  funding every leg succeeds in order and the paid route equals the quote.
- **DF3** — funding locks but does not release; the claim view is public;
  accepting releases, the payment becomes paid, the route has no payout leg.
  CCR-12: `settle.externalRef` is the vault **payoutId** before and after
  acceptance and must not change; `lockTxRef` and `releaseTxRef` carry the
  transaction hashes. Mock mode requires labelled mock references; Stellar mode
  verifies both hashes through the configured testnet RPC: the lock must be
  `create_payout` on `FP_PAYOUT_VAULT_ID` with `sha256("<payment id>:1")` and a
  claim hash, the release must be `claim` of that payout id to
  `FP_RECIPIENT_A_ADDRESS`, and the release secret must hash to the lock's claim
  hash. It also checks CCR-13: lock principal = quoted settle `amountIn`,
  `feeMode` = quote, `fee` = `f(P)` at the deployed fee in
  `scripts/testnet/testnet-ids.env` (Stellar) or quote-identity vault math
  (mock), release net = `P` (PayerPays) or `P - f(P)` (RecipientPays), and
  PayerPays `P = floor(A * 10000 / (10000 + bps))`. Both transactions must be
  successful, distinct and in non-decreasing ledger order. A 64-hex string alone
  is never treated as proof, and `--mode` only says what was requested.
- **DF4** — `fail-next` makes the first payout and its retry fail; the payout
  stays failed, collect and convert reverse, and the payment is refunded.
  CCR-14: the two attempts are proven from the durable `Leg.attempt` in two
  `leg.failed` snapshots (exactly 1 and 2, on the routed payout provider),
  followed by one `payment.refunded`. Provider refs may be repeated or cleared,
  so equal or missing refs are not evidence against a retry. A third attempt, a
  successful payout or a refund before the failures fails the flow; a payout
  without `attempt` or a snapshot without legs fails acceptance (it is a
  contract defect, not a missing route).
- **DF5** — ZA company quote takes `collect → convert → payout` on
  `sim_bank_za_eft` with no settle leg, and a crypto quote is refused with 422.
  In both cases the `reasons[]` must carry the meaning: crypto, the company
  recipient kind and an exclusion. The facts may be spread over several reasons
  (no exact sentence or single item is required), while empty or generic prose
  fails. Exact wording remains free and no stable reason code exists yet. The
  paid payment has no on-chain event.

## Structure

- `lib/` — environment, HTTP, preflight, assertions, fixture loading, reporting
  and evidence.
- `lib/api.ts` — the only seam that may build a request body. Every body and
  success response is parsed by the published Zod schema, so no field is
  guessed.
- `lib/contract-gaps.ts` — acceptance rules that depend on published evidence
  (`Leg.attempt`, event snapshots, retry/refund order).
- `lib/stellar-proof.ts` — testnet RPC verification of the lock and release,
  including CCR-13 accounting.
- `scripts/seed/fixtures/` — neutral workers, endpoints and per-flow
  amounts/expectations.
- `scripts/demo/evidence/` — committed blocker/review records, plus one
  generated JSON per run: commit, command, exit code, steps, blockers. No key,
  token, account number or address.

## CCR-11 restart acceptance (Stellar testnet PASS)

Claim secrets are sealed at rest with `FP_CLAIM_SEAL_KEY` (32 bytes, 64 hex
chars). Restart acceptance must use the **same database** and the **same key**
across restarts; it never asks the API to reveal a secret.

1. Start with a persistent data directory and the seal key set. Create and fund
   a `claim_link` payment: the settle leg locks, `externalRef` is the payoutId,
   `lockTxRef` is set, the payment is not paid. Record the payment id, payoutId
   and hashes privately.
2. Stop the API (SIGTERM). Leave the database running, or restart it from the
   same data directory.
3. Start the API again with the same `DATABASE_URL` and `FP_CLAIM_SEAL_KEY`.
4. Re-open the original claim URL: the view must still be `open` with the same
   amount, and the payment must still be waiting. This proves the token hash and
   sealed secret survived the restart.
5. Accept the claim. It must become paid with the same payoutId, a successful
   `releaseTxRef`, and no payout leg. Verify on testnet that `claim` used that
   payoutId, paid the intended address and hashed to the lock's claim hash —
   read from the transaction's own calldata, never from the API.
6. Negative control: restart with a different seal key; acceptance must fail
   without releasing (no `releaseTxRef`, payment not paid) and must never expose
   the secret.

Evidence records ids, hashes and statuses only: no claim token, secret, API key
or full address.

**Attempt status: PASS on Stellar testnet** for payment
`pay_130322f594bcf3c64330e80c`. The API stopped with the database left running
and restarted on the same `DATABASE_URL` and `FP_CLAIM_SEAL_KEY`. In a new
browser context the original claim stayed `open` and `processing`; accepting it
released the **same payout `39`** and **same lock hash**, paid Worker A, and set
the payment to `paid`. There was one lock and one funding event before and
after. See `2026-10-23-ccr11-restart-stellar.md` for the transaction hashes,
restart timestamps, UI network trace and screenshot links.

A mock-mode attempt still fails because that vault is in-memory: the claim stays
`open`, but accept returns **502 `release_failed` / `PayoutNotFound`** after the
payout state is lost. That result is not a pass; mock restart needs a persistent
vault. CCR-11's Stellar path does not.

## Integration items resolved in this acceptance

1. A0 schemas are exported from `packages/domain/src/api` and parsed by the demo
   client.
2. CC3a/CC3b routes are mounted, including endpoints, batches, claims, events
   and sandbox controls.
3. `/v1/sandbox/fail-next` accepts a count; DF4's two attempts are
   deterministic.
4. Refund/cancel works before expiry (CCR-5 §5); DF4 reaches `refunded`.
5. `FP_API_URL` and `FP_API_KEY` are documented in the root `.env.example`.
6. SC2's adapter and `FP_SETTLEMENT` wiring are active; DF1–DF4 settle on
   Stellar testnet.
7. Event snapshots carry legs with durable `attempt`, `lockTxRef` and
   `releaseTxRef`; DF3/DF4 assertions pass against them.
8. The sealed claim secret survives an API restart: the claim view stayed
   `open`, and the Stellar release decrypted it and released the original lock
   after restart. Mock release still needs a persistent vault (see above).

## Remaining caveats (not blockers for D1/D2)

1. The settle leg's status after a vault refund is still not defined; DF4 does
   not assert it. The on-chain `cancel` was verified separately for the recorded
   DF4 run.
2. No stable refusal-reason code exists; DF5 asserts the explanation's meaning
   across `reasons[]` instead of a code.
3. DF1/DF2 prove successful testnet settlement through the API and events, but
   only DF3/DF4 independently decode the contract invocation from RPC.
4. The browser flow cannot request a ZA crypto destination because the web form
   only offers bank accounts for ZA; the 422 crypto refusal is covered by DF5 at
   the API level, while the browser covers the eligible bank route.
5. CCR-11 passes on Stellar testnet. Mock-mode restart remains unsupported by
   the in-memory mock vault; that is a mock limitation, not a Stellar gap.
