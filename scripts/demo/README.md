# Demo flows (lane D, D1)

One script per acceptance flow from `tests/e2e/SCENARIOS.md` and ARCHITECTURE
§15. Each script calls the same API the UI calls, prints the route, the legs and
the result, and exits non-zero on failure. Fixtures are neutral: Demo Platform
and Worker A to Worker D (Worker D is the ZA company that DF5 needs).

## Status (23 Oct 2026)

**Reconciled with CCR-11–14 and exercised, not yet passing end to end.** The
acceptance work is merged with `main` at `e6429fe` (contracts from #36
`b3d77a7`). The integrated API still mounts only `healthz`, `corridors` and
`recipients`: OPTIONS probes of every DF route return the catch-all 404 with no
`Allow` header, so the quote/payment/batch/claim/endpoint/sandbox handlers are
not mounted. A run therefore ends as **BLOCKED** with the missing item and its
owner, never as PASS. See `scripts/demo/evidence/2026-10-23-d3-acceptance.md`
for the latest run and blockers. Per-run JSON evidence is written to the same
folder and git-ignored.

DF1 takes the domestic explanation from `Quote.reasons` (no batch-row reason
field is invented). DF4 proves the single retry from the published `Leg.attempt`
values in `Event.snapshot` legs, not from provider refs or the fixture's fail
count. DF3 reads `settle.externalRef` as the vault **payoutId** (CCR-12) and
verifies `lockTxRef` / `releaseTxRef` separately. The settle leg's status after
a refund is still not asserted.

| Flow                   | Script              | Mock    | Stellar                         |
| ---------------------- | ------------------- | ------- | ------------------------------- |
| DF1 three-worker batch | `df1-batch.ts`      | BLOCKED | —                               |
| DF2 quote to paid      | `df2-one-off.ts`    | BLOCKED | —                               |
| DF3 claim link         | `df3-claim.ts`      | BLOCKED | BLOCKED (routes; RPC reachable) |
| DF4 retry then refund  | `df4-failure.ts`    | BLOCKED | —                               |
| DF5 ZA company         | `df5-za-company.ts` | BLOCKED | —                               |

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

# every mock flow, plus DF3 on Stellar
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
- `lib/api.ts` — the only seam that may build a request body. It refuses to
  return a client while A0 is absent, so no field is guessed.
- `lib/contract-gaps.ts` — blocked seams for evidence A0 has not defined.
- `lib/stellar-proof.ts` — testnet RPC verification of the lock and release,
  including CCR-13 accounting.
- `scripts/seed/fixtures/` — neutral workers, endpoints and per-flow
  amounts/expectations.
- `scripts/demo/evidence/` — committed blocker/review records, plus one
  generated JSON per run: commit, command, exit code, steps, blockers. No key,
  token, account number or address.

## CCR-11 restart acceptance (prepared, blocked on CC2/CC3)

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
or full address. This procedure has not run: the claim routes are not mounted
and CC2 does not yet persist the seal (see blockers in the D3 evidence).

## Known integration needs (owner: Csaba)

1. A0 schemas under `packages/domain/src/api`, exported for scripts.
2. CC3a/CC3b routes from ARCHITECTURE §10, reflected in `apps/api/openapi.json`.
   The claim accept route is `POST /v1/claims/{token}/accept`, which is what
   `openapi-stubs.ts` and ARCHITECTURE §10 publish.
3. `/v1/sandbox/fail-next` accepting a count, so DF4's retry can fail
   deterministically.
4. A refund that works without waiting for ledger time (cancel before expiry,
   CCR-5 §5).
5. `FP_API_URL` and `FP_API_KEY` names in the root `.env.example`.
6. SC2's adapter and `FP_SETTLEMENT` wiring for DF3 on Stellar.
7. Event snapshots must carry the payment's legs, including durable `attempt`
   (CCR-14) and `lockTxRef`/`releaseTxRef` (CCR-12); DF3 also needs the
   pre-accept settle `externalRef` (payoutId). These are published contract
   fields; no new API field is needed.
8. CC2 must persist the sealed claim secret and `vaultClaimHashHex` (CCR-11);
   CC3 must decrypt only inside the API host for release.
9. The settle leg's status after a vault refund is still not defined; DF4 does
   not assert it.
10. No stable refusal-reason code exists; DF5 asserts the explanation's meaning
    across `reasons[]` instead of a code.
