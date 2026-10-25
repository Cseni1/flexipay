# DF7 — reference-anchor lifecycle scaffold (25 Oct 2026)

**Status: SCAFFOLD READY — CLASSIC-PAYMENT STAGE IMPLEMENTED, LIFECYCLE NOT
VERIFIED.** No live anchor session, classic payment, Horizon reconciliation,
Stellar transaction or API/UI run was performed.

**Base:** `main` at `21aeac7` (after #63). **Branch:**
`event/csenge-freebuff/df7-anchor-lifecycle`.

## Existing DF7 work

**None found.** Before adding files, `find` over `scripts`, `packages`, `apps`,
`docs` and `tests`, `git log --all --grep=DF7`, and branch search found no DF7
script, evidence file, branch or commit. The only references were:

- `docs/EVENT_PLAN.md` §3/§10 and the root coordinator §10 (Stellar-first);
- `packages/adapter-stellar/E1-HANDOFF.md` (“DF7 script — No — Freebuff”);
- `scripts/demo/evidence/2026-10-25-h3-df1-df2-stellar.md` (“DF7 anchor
  lifecycle is not run”);
- `scripts/testnet/EVENT-TX-WINDOWS.md` (recipient A ownership).

## What this scaffold adds

- `scripts/demo/lib/df7-lifecycle.ts` — local prerequisites, stage vocabulary,
  role-based ref validation, outcome classification, anchor-payment field
  validation, completion verification, three live gates, payment-state handling,
  bounded Horizon reconciliation and hosted-URL/amount helpers.
- `scripts/demo/df7-anchor-lifecycle.ts` — plan/preflight plus network-gated
  readiness, hosted-session start, one-shot classic payment (`--pay`), read-only
  reconciliation (`--reconcile`) and bounded poll modes; offline `--classify`.
- `tests/e2e/df7-scaffold.test.ts` — offline tests for the helpers.
- A short README section; no API, web, adapter or contract edit.

It consumes Cursor's `scripts/testnet/testnet-ids-anchor-vault.env` and the
CCR-20 names `FP_ANCHOR_*` / `FP_ANCHOR_VAULT_*`. It does not create a competing
anchor ids file. `ReferenceAnchorClient`, `loadAnchorEventEnv`,
`sanitiseHostedUrl` and the existing SEP-24/SEP-10 methods are reused.

## Offline checks performed

### Plan (no network)

```text
result      SCAFFOLD_READY
```

Public ids loaded successfully, including the isolated anchor vault
`CA5SYMIWGCUGG6OVTL3KBFNOWVEF46UILNKG7D7JMAD7XVQWX2W3ETMS`, anchor asset
`USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`, and the 100-bps
value from Cursor's file. No anchor call or transaction was made.

### Local preflight (no network)

`node scripts/demo/df7-anchor-lifecycle.ts --preflight` returned **BLOCKED**:

```text
blocked     FP_RECIPIENT_A_SECRET is missing
result      BLOCKED
```

The git-ignored `.env.secrets-anchor-vault` overlay is absent in this checkout.
This is an unavailable prerequisite, not an assertion failure. The public
address/secret match and live SEP-10 remain **NOT VERIFIED**. No secret value
was read into evidence or printed.

`--start-withdraw` and `--poll` refused without the network gate:

```text
node scripts/demo/df7-anchor-lifecycle.ts --start-withdraw
blocked     FP_DF7_ALLOW_NETWORK=1 is required for a network step
result      BLOCKED

node scripts/demo/df7-anchor-lifecycle.ts --poll --id demo
blocked     FP_DF7_ALLOW_NETWORK=1 is required for a network step
result      BLOCKED
```

No network request was made by these checks.

### Classification examples (offline)

| Input                                                                | Outcome        | Exit |
| -------------------------------------------------------------------- | -------------- | ---- |
| `completed` + all three refs + `--withdraw-check pass` (CLI)         | `NOT_VERIFIED` | 2    |
| `completed` + missing anchor payment and vault release refs + `pass` | `NOT_VERIFIED` | 2    |
| `expired`                                                            | `FAILURE`      | 1    |
| function call: `completed` + verified proof + `pass`                 | `SUCCESS`      | —    |

`SUCCESS` is deliberately stricter than the anchor status: it requires all three
references verified at their sources and a passed amount/destination/memo
assertion. The offline CLI cannot verify a caller-supplied ref, so it reports
`NOT_VERIFIED`; the SUCCESS branch is covered by the unit tests. The table is a
test of the decision function, not a live run.

### Classic-payment stage (implemented, not executed)

`--pay` reuses `submitClassicPaymentWithMemo`; there is no second payment
implementation. Before any submit it requires:

1. `FP_DF7_ALLOW_NETWORK=1`;
2. `FP_DF7_SUBMIT_PAYMENT=1`; and
3. `FP_DF7_RECIPIENT_LOCK` in the form `LOCK recipient A <agent> DF7 <UTC>`.

With all three absent, the CLI exits `BLOCKED` before any network call:

```text
blocked     FP_DF7_ALLOW_NETWORK=1 is required for a network step
blocked     FP_DF7_SUBMIT_PAYMENT=1 is required for a classic payment
blocked     FP_DF7_RECIPIENT_LOCK is required: supply the LOCK recipient A <agent> DF7 <UTC> confirmation
result      BLOCKED
```

`--pay` then reads the SEP-24 record and requires `pending_user_transfer_start`
plus a positive decimal amount, G-address destination, supported memo type/value
and the configured asset identity. When the anchor publishes an asset
declaration (`amount_in_asset` / `asset_code` + `asset_issuer`), it must match;
a ticker-only declaration is a mismatch, not an identity. If the record
publishes no asset, the CLI prints `asset-source` = requested session asset
instead of claiming anchor-published proof.

The submission state file (`/tmp/fp-df7-private/payment-state.json`, `0600`) is
written before submit with status `submitting`, then rewritten with the returned
hash and status `submitted` **before any polling**. A second `--pay` refuses
while state exists. An uncertain submit is recorded as `uncertain` and prints
`DO NOT RETRY`. A retry is never automated: even `NOT_FOUND` reconciliation
needs an operator decision and explicit state handling before a new attempt, and
reconciliation itself never resets or resends. `--reconcile` performs a bounded
read-only Horizon scan (latest 20 recipient transactions, operations fetched
only for memo-carrying records) and either retains a single matching hash,
reports `NOT_FOUND`, `MISMATCH`, `AMBIGUOUS` or `NOT_VERIFIED`. It never
submits. `--reconcile` requires only `FP_DF7_ALLOW_NETWORK=1` (read-only);
without it the CLI prints that one blocker and makes no request.

### Tests and typecheck

- `npx vitest run tests/e2e/df7-scaffold.test.ts` — **25 tests passed**.
- Targeted `tsc --noEmit` over the new script, helper and test — **passes**.
- Repository-wide `tsc -p scripts/demo/tsconfig.json` currently reports the
  pre-existing H1 driver error on `main` (`settle.amountIn`); PR #66 contains
  that one-line fix. It is not duplicated here.

No network is used by the test file, and no test key is committed.

## Lifecycle stages and status semantics

| Stage                | Scaffold state | Meaning                                               |
| -------------------- | -------------- | ----------------------------------------------------- |
| `prerequisites`      | READY/BLOCKED  | public ids; secret only via `--preflight`             |
| `vault_release`      | NOT_RUN        | claim path must supply a distinct vault release hash  |
| `discover`           | PLANNED        | anchor TOML and listed asset                          |
| `authenticate`       | PLANNED        | SEP-10; JWT stays on the client instance              |
| `price`              | PLANNED        | indicative SEP-38 `context=sep6`, not a binding quote |
| `start_withdraw`     | PLANNED        | hosted session; full URL to a private file            |
| `hosted_interactive` | NOT_RUN        | human/browser step; cannot be scripted                |
| `anchor_payment`     | PLANNED        | implemented via `--pay`; one submit, three live gates |
| `poll_terminal`      | PLANNED        | bounded `waitForTerminal` + retained payment check    |
| `classify`           | PLANNED        | success/failure/not-verified/pending with refs        |

Classification is explicit:

- **SUCCESS** — anchor `completed`, local payment assertion `pass`, three refs
  present and each verified at the source/role that produced it.
- **FAILURE** — SEP-24 failure status, a failed payment assertion, a confirmed
  amount/asset/destination/memo mismatch, or an anchor `stellar_transaction_id`
  that differs from the retained payment hash.
- **NOT_VERIFIED** — anchor `completed` but required evidence is incomplete:
  missing refs, refs not verified at source, missing `amount_in`/destination/
  memo, or no retained payment expectation.
- **PENDING** — non-terminal status or a bounded timeout (INCOMPLETE).
- **BLOCKED** — missing prerequisite; never success.

`--classify` cannot produce `SUCCESS`: its refs and assertion are caller inputs,
so completed output is `NOT_VERIFIED` until `--poll` verifies the retained
payment hash against the anchor record. The SUCCESS decision is covered by unit
tests with explicit proof flags, not by the offline CLI.

## Three references (kept separate)

| Reference             | Kind                             | Source                     |
| --------------------- | -------------------------------- | -------------------------- |
| anchor transaction id | SEP-24 record id                 | `startWithdrawInteractive` |
| anchor payment hash   | Horizon classic payment hash     | memo payment to anchor     |
| vault release hash    | Soroban `claim` transaction hash | claim release path         |

The helper rejects a missing or malformed ref. It does **not** infer roles from
string inequality: identical values are allowed when each was produced by its
own source, because role is established by the stage that observed it, not by
comparison. A refund/`releaseTxRef` is not evidence of a claim release (CCR-12).
`--classify` and `--poll` print the three fields separately as `ref-anchor`,
`ref-payment` and `ref-release`; role verification is tracked separately, so a
completed status alone cannot yield SUCCESS.

## Hosted URL handling

`saveHostedUrlForBrowser` validates the URL, writes the functional URL to
`/tmp/fp-df7-private/hosted-withdraw-url.txt` with directory mode `0700` and
file mode `0600`, and returns only `sanitiseHostedUrl(url)` for logs/evidence.
The test uses a fake token and proves the full URL is in the private file while
the returned value contains only origin + pathname. No JWT or session token is
printed or committed.

## Exact integration dependencies

1. **Csaba API/UI (interface shape still owned by Csaba):** the claim journey
   must produce the claim's **vault release hash** and a cash-out action that
   starts the anchor withdrawal. This scaffold does not assume an endpoint or
   request body; offline classification accepts the hash and anchor refs as CLI
   inputs. Integrated M1 remains **PARTIAL** until this is wired.
2. **Cursor / ids:** no new interface requested. Consume
   `testnet-ids-anchor-vault.env` and the exported `ReferenceAnchorClient`.
   Cursor owns that file; this PR does not modify it.
3. **Local live prerequisite:** the git-ignored
   `scripts/testnet/.env.secrets-anchor-vault` overlay and a recipient A keypair
   matching the published address. Missing here, hence preflight BLOCKED. A live
   run also needs the recipient's anchor-USDC balance or a sanctioned top-up.
4. **Human/browser:** the SEP-24 hosted screen and bank details are mandatory.
   The functional URL is available only through the private file; sanitised URLs
   are used in logs/evidence.
5. **Claude approval / tx window:** `--start-withdraw` is double-gated by
   `FP_DF7_ALLOW_NETWORK=1` and `FP_DF7_START_WITHDRAW=1`. A live classic
   payment now exists as `--pay` but was **not executed**; it requires
   `FP_DF7_SUBMIT_PAYMENT=1` plus `FP_DF7_RECIPIENT_LOCK` (LOCK recipient A via
   `EVENT-TX-WINDOWS.md`) and a bounded, single-submit run.
6. **Integrated M1:** this PR is not M1 PASS and does not replace the E1 package
   evidence. It only makes the DF7 prerequisites, stages and classification
   reviewable before a live run.

## Next live run (not performed)

1. Restore the anchor secrets overlay and confirm recipient A matches.
2. LOCK recipient A; run `--readiness`, then `--start-withdraw`; open the
   private URL in a browser and complete the hosted flow.
3. Record the anchor transaction id; run `--pay` once under the recipient lock.
4. Run bounded `--poll`; verify the retained payment hash against the anchor
   `stellar_transaction_id` and supply the claim path's vault release hash.
5. If the submit is uncertain, run `--reconcile` before any retry decision.
   Completing the test-anchor withdrawal is still not proof of a real bank
   receipt.
