# DF7 — reference-anchor lifecycle scaffold (25 Oct 2026)

**Status: SCAFFOLD READY — LIFECYCLE NOT VERIFIED.** No live anchor session,
classic payment, Stellar transaction or API/UI run was performed.

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
  three-ref validation, outcome classification, hosted-URL file handling and
  amount parsing.
- `scripts/demo/df7-anchor-lifecycle.ts` — plan/preflight plus network-gated
  readiness, hosted-session start and bounded poll modes; offline `--classify`.
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

Both live-effect modes refused without their gates:

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

| Input                                                                | Outcome   | Exit |
| -------------------------------------------------------------------- | --------- | ---- |
| `completed` + three distinct refs + `--withdraw-check pass`          | `SUCCESS` | 0    |
| `completed` + missing anchor payment and vault release refs + `pass` | `PENDING` | 2    |
| `expired`                                                            | `FAILURE` | 1    |

`SUCCESS` is deliberately stricter than the anchor status: it requires all three
references and the amount/destination/memo assertion. The table above is a test
of the decision function, not a live run; the CLI prints that supplied
refs/assertion are inputs, not execution proof.

### Tests and typecheck

- `npx vitest run tests/e2e/df7-scaffold.test.ts` — **10 tests passed**.
- Targeted `tsc --noEmit` over the new script, helper and test — **passes**.
- Repository-wide `tsc -p scripts/demo/tsconfig.json` currently reports the
  pre-existing H1 driver error on `main` (`settle.amountIn`); PR #66 contains
  that one-line fix. It is not duplicated here.

No network is used by the test file, and no test key is committed.

## Lifecycle stages and status semantics

| Stage                | Scaffold state  | Meaning                                               |
| -------------------- | --------------- | ----------------------------------------------------- |
| `prerequisites`      | READY/BLOCKED   | public ids; secret only via `--preflight`             |
| `vault_release`      | NOT_RUN         | claim path must supply a distinct vault release hash  |
| `discover`           | PLANNED         | anchor TOML and listed asset                          |
| `authenticate`       | PLANNED         | SEP-10; JWT stays on the client instance              |
| `price`              | PLANNED         | indicative SEP-38 `context=sep6`, not a binding quote |
| `start_withdraw`     | PLANNED         | hosted session; full URL to a private file            |
| `hosted_interactive` | NOT_RUN         | human/browser step; cannot be scripted                |
| `anchor_payment`     | NOT_IMPLEMENTED | live classic memo payment; requires separate approval |
| `poll_terminal`      | PLANNED         | bounded `waitForTerminal`                             |
| `classify`           | PLANNED         | success/failure/pending with refs and assertion       |

Classification is explicit:

- **SUCCESS** — anchor `completed`, local payment assertion `pass`, and three
  present, distinct refs.
- **FAILURE** — SEP-24 failure status or a failed payment assertion.
- **PENDING** — non-terminal status, bounded timeout (INCOMPLETE), or
  `completed` with missing/duplicate refs.
- **BLOCKED** — missing prerequisite; never success.

## Three references (kept separate)

| Reference             | Kind                             | Source                     |
| --------------------- | -------------------------------- | -------------------------- |
| anchor transaction id | SEP-24 record id                 | `startWithdrawInteractive` |
| anchor payment hash   | Horizon classic payment hash     | memo payment to anchor     |
| vault release hash    | Soroban `claim` transaction hash | claim release path         |

The helper rejects a missing ref or the same hash in both hash slots. A vault
release hash is not an anchor payment hash, and a refund/`releaseTxRef` is not
evidence of a claim release (CCR-12). `--classify` and `--poll` print the three
fields separately as `ref-anchor`, `ref-payment` and `ref-release`.

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
   payment is **not implemented** in this scaffold and must be approved and
   wired as a separate step. Any live submit needs LOCK recipient A via
   `EVENT-TX-WINDOWS.md` and a bounded, single-submit run.
6. **Integrated M1:** this PR is not M1 PASS and does not replace the E1 package
   evidence. It only makes the DF7 prerequisites, stages and classification
   reviewable before a live run.

## Next live run (not performed)

1. Restore the anchor secrets overlay and confirm recipient A matches.
2. LOCK recipient A; run `--readiness`, then `--start-withdraw`; open the
   private URL in a browser and complete the hosted flow.
3. Record the anchor transaction id; run bounded `--poll` with the three refs.
4. Implement/approve the single classic memo payment stage before claiming a
   complete DF7 lifecycle.
