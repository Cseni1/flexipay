# FlexiPay: Development Plan

Version 5, 23 Oct 2026. Derived from `ARCHITECTURE.md` v5 and `PRODUCT.md` v4. Applies the reduced MVP (CCR-5). Status below is from the repository audit of 23 Oct 2026 (`main` = `d8b5e1a`). Estimates assume AI coding agents with a human or the integrator reviewing.

## 1. The shape of the plan

| Part | When | What |
|---|---|---|
| **Arrival baseline** (disclosed prior work) | Today, Fri 23 Oct, until the humans call the freeze (before travel) | The reduced MVP: four corridors, route selection with reasons, quote, payment, claim link, retry then refund, Stellar testnet claim, three web screens, demo scripts DF1 to DF5, offline mode |
| **Preparation** (no event-feature code) | Today and during travel | Pitch deck, README and doc skeletons, event task cards, rehearsal |
| **New work at HackMeridian** | Sunday 25 Oct 11:30 to Monday 26 Oct submission | Anchor cash-out to a bank, passkey smart-wallet claim, fee sponsorship (stretch) |

Entry: one **Scale** entry in the **Stellar Composed** track. Nothing built for the event features before 11:30 on Sunday. Everything prepared beforehand is disclosed in `docs/PRIOR_WORK.md`. Saturday (travel) is for fixes only.

## 2. People, agents and lanes

Four agents (two per human: one Cursor and one Freebuff each, with ChatGPT coordinating Freebuff) work in four lanes. A lane owns its folders (ARCHITECTURE section 4). At the event Claude acts as an additional quality controller.

| Lane | Folders | Suggested agent (humans confirm) |
|---|---|---|
| **A: core** (domain, route selection, orchestrator, API) | `packages/domain`, `apps/api` | Cursor 1 |
| **B: chain** (Stellar adapter, demo wallet) | `packages/adapter-stellar` | Cursor 2 |
| **C: web** (three screens) | `apps/web`, `packages/web-lib`, `tests/e2e-ui` | Freebuff 1 |
| **D: scripts and acceptance** (demo scripts, seed, sample data) | `scripts/demo`, `scripts/seed`, `tests/e2e` | Freebuff 2 |

Done and closed lanes: simulated providers and mock settlement (`packages/adapters-sim`), config (`config/`), contracts and testnet scripts (`contracts/payout_vault`, `scripts/testnet`). Their owners fix defects only.

**Rules for every agent:** work on a branch `<agent>/<task>`; write only in your lane's folders; build only against the interfaces in `packages/domain`; if an interface is missing or unclear, stop and write a contract-change request in `docs/CONTRACT_CHANGES.md` instead of guessing; neutral sample names only ("Demo Platform", "Worker A"); no anchor, passkey or fee-sponsorship code before Sunday 11:30; show the demo script or test output with the pull request.

## 3. Pre-build checklist (status from the audit)

| Item | Status |
|---|---|
| Tag `qualifier-v1` | **Done** (on GitHub at `909713c`) |
| `main` protected: pull request + `separation` check, 0 approvals, admins included | **Done** |
| Guards: separation check in the commit hook and CI, commit identity guard, root `.env.example` | **Done** |
| Collaborator access for the second builder | **Open:** the second collaborator has write access under an account whose name carries another product's name. Confirm it is the right person and that this account is acceptable |
| CI test job (typecheck, tests, Prisma generate, secret scan) | **Not done.** Needs the `workflow` permission on the `gh` login once (task CI1) |
| `docs/` holds the three documents | **This change** (they were outside the repo) |
| Vercel production branch `production`; stable Preview link | **Not done** (account step; does not block building) |
| API host (Railway) with Postgres | **Not done** (account step; does not block building) |
| Cursor and Freebuff each tried on a small task | Freebuff **done**; Cursor **not verified** |
| Per-folder git identity | Done on Csenge's laptop; **the other laptop not verified** |
| Hackathon rules on pre-existing code | **Not verified**; read on arrival |

## 4. Status of earlier tasks

| Task | Status | Evidence |
|---|---|---|
| CC0a domain, config schemas, adapter interfaces | **Done** | PR #7; 33 domain tests |
| CC0b restructure to the target layout | **Done** | PR #9; web build, 2 Playwright tests |
| CC0c state machine | **Done** | PR #10 |
| CC0c Postgres schema, API skeleton, OpenAPI | **Done** | PR #13; 11 API tests against real Postgres |
| SC0 contracts (vault, constructor, events, per-attempt ids) | **Done** | 19 contract tests; `tip_pool` not ported |
| SC1 testnet set-up | **Done** | vault `CCG232...` answers `config()`; ids in `scripts/testnet/testnet-ids.env` |
| SF0 config | **Done** | `npm run validate:config` |
| SF1 simulated providers | **Done** | PR #11; integration with the orchestrator not yet verified |
| SF2 mock settlement | **Done** | PR #14; 85 adapter tests; offline demo not yet verified |
| SF3-prep scenarios | **Done** | `tests/e2e/SCENARIOS.md` |
| SC2 Stellar adapter | **Partial** | vault client and helpers on a local branch only (`csenge-claude/SC2-stellar-adapter`, 13 unit and 3 testnet tests); adapter class not written |
| CC1, CC2, CC3 | Not started / skeleton only | replaced by the cards below |
| CF0 to CF6, SF3 tests, CC4 | Not started | replaced by the cards below |

## 5. Task cards for today (reduced scope)

Time boxes are for an agent working alone in its lane.

### Lane A: core
| Id | Task | Time | Depends on | Done when |
|---|---|---|---|---|
| **A0** | **API contract first.** Zod schemas for the request and response bodies of `quotes`, `payments`, `payments/{id}`, `claims`, `events`, `sandbox` in `packages/domain/src/api/`, with OpenAPI entries as stubs. Merge before anything else, so lanes C and D can build against it | 0.75 h | CCR-3, CCR-4, ARCHITECTURE sections 6, 8, 10 | Merged; web and scripts can import the types |
| CC1 | Route selection (section 8): templates, eligibility filter, reasons with excluded alternatives, pricing through the provider adapters and the vault fee | 1 h | A0, config, `adapters-sim` | Unit tests for every exclusion reason, including South Africa and the crypto-destination route ending at settle |
| CC2 | Synchronous orchestrator (section 1a, 7): create payment, run legs in order, retry once, refund, claim wait, lazy expiry, events and audit rows, duplicate external ids | 2 h | CC1, mock settlement | Tests for every failure path in section 7, on the mock settlement |
| CC3a | Routes: `quotes`, `payments` (create, get, list), `fund`, `cancel`, `events` | 1.5 h | A0, CC1, CC2 | HTTP tests; `openapi.json` matches |
| CC3b | Routes: `claims`, `claims/accept`, `endpoints`, `batches` (JSON), sandbox routes | 1.5 h | CC3a | HTTP tests; DF4 and DF5 can be driven |

### Lane B: chain
| Id | Task | Time | Depends on | Done when |
|---|---|---|---|---|
| SC2 | `StellarSettlementAdapter` implementing `SettlementAdapter` over the existing vault client (refund = cancel before expiry, refund after), custodial demo wallet provider, `FP_SETTLEMENT` factory, workspace integration | 2 h | merged interfaces, vault client | Adapter tests pass against testnet with transaction hashes; behaves like the mock in the shared adapter test cases |

### Lane C: web
| Id | Task | Time | Depends on | Done when |
|---|---|---|---|---|
| CF0 | Web shell and minimal design system (section 13 rules, status colours, simulated label, (i) popover) | 1 h | A0 for types | Shared components in place; build green |
| CF1 | Send a payment screen with quote panel, and the payment detail screen with timeline | 2.5 h | CF0, A0, then CC3a | DF2 works in the browser |
| CF4 | Claim page at phone width, options list built to accept new options | 1.5 h | CF0, A0, then CC3b | DF3 works on a phone-size screen |

### Lane D: scripts and acceptance
| Id | Task | Time | Depends on | Done when |
|---|---|---|---|---|
| D1 | Demo scripts `scripts/demo/df1..df5` per `tests/e2e/SCENARIOS.md`, with sample data in `scripts/seed/` (neutral names), run on the mock; DF3 also on `stellar` | 2 h | CC3a, CC3b | Each script exits 0 on the integrated build and prints the route, legs and result |
| D2 | Seed and reset (`/v1/sandbox/reset`), offline-mode run script (`npm run demo:offline`) | 1 h | CC3b | One command starts Postgres, the API and the web app on a laptop |

### Integrator and humans
| Id | Task | Who |
|---|---|---|
| CI1 | CI test job: `npm ci`, Prisma generate, typecheck, tests, secret scan | Integrator; needs your `gh` login code for the `workflow` permission |
| HOST | Vercel production branch and Railway with Postgres; public URL for judges | Account owner; not needed for building |
| DOCS | README, `docs/STELLAR.md`, `docs/PRIOR_WORK.md` skeletons; pitch deck wording | Humans with ChatGPT |

## 6. Order of work today

1. **Wave 1, in parallel:** A0 first (30 to 45 minutes). While it is written: B starts SC2; C starts CF0; D reads the scenarios and prepares seed data.
2. **Wave 2:** A continues CC1 then CC2. C builds CF1 against the A0 types. B finishes SC2.
3. **Wave 3:** CC3a then CC3b. As each lands, C connects the screens and D runs its scripts against the real API.
4. **Wave 4, integration:** D1 scripts pass on the mock; switch DF3 to `stellar`; fix; run `demo:offline`; the humans call the freeze.

**Cut order if behind** (cut from the top): the alternatives list in the quote (keep the chosen route and the exclusions); DF1 as a script only (it already is); the Playwright flows (keep smoke tests); CF4 polish; real Stellar for anything except DF3. **Never cut:** DF2, DF3 on testnet, DF4 (retry then refund), DF5 reason, the route explanation, the simulated labels.

## 7. Event plan (Lisbon)

| Time | What |
|---|---|
| **Sun 09:00 to 11:30** | Check-in and opening. Read the event rules. Confirm the test anchor is up. Ask whether pre-event set-up counts as prior work. |
| **Sun 11:30** | Hacking begins. Tag `arrival`. Start E1 and E2. |
| **Sun 11:30 to 17:30** | Build. Eat at the desk. Only one person attends a workshop, and only if it is about anchors or smart wallets. |
| **Sun 16:00 to 20:00** | Mentor office hours: book early for anchor and passkey questions. |
| **Sun 17:30** | **Go/no-go:** anchor price working and a passkey wallet created on testnet. If the passkey wallet is stuck, switch the second tool to fee sponsorship. |
| **Sun 20:30 to 01:00** | Integration: anchor and passkey wired into route selection and the claim page; DF7 and DF8 scripts. |
| **Overnight** | Sleep in shifts (at least 4 to 5 hours each). Agents can run long tasks; humans review in the morning. |
| **Mon 07:00 to 09:00** | Fixes; fee sponsorship only if DF7 and DF8 are green. |
| **Mon 09:00** | Both attend the briefing on submission and judging. |
| **Mon 09:15** | **Feature freeze.** Public release, smoke test on the public URL, record the video, finish README, STELLAR.md, PRIOR_WORK.md and the deck. Tag `submission`. |
| **Mon 11:30** | **Submit** (30 minutes before the 12:00 close). |
| **Mon 13:30** | Judging. Offline fallback and the video ready. |

### Event tasks (not started; embargoed until Sunday 11:30)

| Id | Task | Lane | Done when |
|---|---|---|---|
| E1 | Anchor adapter (Option A): SEP-10, indicative SEP-38 price on the claim page (context `sep6`), SEP-24 interactive withdrawal to a bank (USD or CAD wire, 1 to 10 USDC on the test anchor); registered as a payout provider | B | DF7 passes on testnet |
| E2 | Passkey smart wallet: create, address, sign the claim; wired into the claim flow | A or B | DF8 passes on testnet |
| E3 | Claim page UI for passkey creation, the anchor's hosted flow and the price | C | DF7 and DF8 work in the browser |
| E4 | DF7 and DF8 scripts; contract ids and transaction hashes for STELLAR.md; PRIOR_WORK.md from the `arrival` to `submission` diff | D | Docs complete with evidence |
| E5 | Fee sponsorship (stretch) | whoever is free | Claim works from a wallet with zero XLM |
| E6 | Submission: README, deck, video, public release, submission form | humans with ChatGPT | Submitted by 11:30 |

**Re-check the test anchor on Sunday morning** (reported 22 Oct: USD or CAD wire only; 1 to 10 USDC; indicative price needs `context=sep6`; SEP-24 `quote_id` is not supported).

## 8. Merge and deploy rules

- Branch per task; small pull requests; the `separation` check must pass (and the full test job once CI1 exists); the integrator merges into `main`.
- A pull request for a flow shows the demo script output. Unit tests alone do not count as acceptance.
- Lane C works against the API contract (A0) until the real routes exist; no lane edits another lane's folders.
- Each branch has one stable Preview link once Vercel is set up; share that link.
- At the event, merges at least every two hours. After 09:15 on Monday, only fixes. Production is touched once, for the public release.
- Shared interfaces change only through `docs/CONTRACT_CHANGES.md` and the integrator.
- Stacked pull requests merge in one sitting, in order, with merge commits.
- Commit identity and separation rules: ARCHITECTURE section 14.

## 9. How ChatGPT coordinates Freebuff

ChatGPT gets `PRODUCT.md`, `ARCHITECTURE.md`, `DEV_PLAN.md` and one task card at a time; writes the Freebuff prompt limited to that task's folder; requires tests and the demo script output; never changes shared interfaces. Task card fields: id and title, goal, folder, inputs (interfaces and config), outputs, tests, done when, out of scope.

## 10. Definition of done

Typecheck, lint, tests and secret scan pass; only shared interfaces used; simulated items flagged and labelled; UI rules followed; for flow tasks the demo script passes on the integrated build; merged and visible.

## 11. Risks and fallbacks

| Risk | Fallback |
|---|---|
| Core lane (A) is the critical path and slips | A0 unblocks the others early; cut order in section 6; pitch from a scripted, labelled-simulated API flow with the claim page |
| Stellar adapter (SC2) slips | DF3 on the mock, labelled; the vault and testnet scripts already work; the event needs SC2 for the passkey claim, so it is the first thing fixed on arrival |
| Agent output has bugs | Contracts and tests exist for the hard parts; acceptance by demo script; small pull requests; one reviewer runs the flow before merging |
| Test anchor down or using a different asset | Simulated bank payout, stated in the demo |
| Passkey wallet stuck by Sunday 17:30 | Second Composed tool becomes fee sponsorship |
| Venue Wi-Fi fails | Offline mode (`npm run demo:offline`) plus the recorded video |
| Tiredness overnight | Sleep in shifts; no merges without review |
| Late submission | Submit at 11:30, not 12:00 |

## 12. Deferred and superseded

**Deferred (shown in the pitch, not built):** webhook delivery; CSV import and the Batches screen; Recipients and Developers screens; Tips module (`tip_pool` port, tips API, DF6); cost, speed and balanced optimisation; automatic provider switching; EU, UK and Mexico corridors; reports; invoice approval and quote lock.

**Superseded:** SC3 (anchor spike, replaced by E1); SC4 (tips API); CF2, CF3, CF5; the qualifier shift screen; the earlier native wallet-connection plan for the baseline.

## 13. Revision notes (v5)

Reduced MVP (CCR-5) and the four-lane working model for four agents. Status from the repository audit. New first task A0 (API contract) so the web and script lanes are not blocked. Task cards rewritten for the synchronous orchestrator, table-driven route selection, settlement adapter by setting and demo scripts as acceptance. Event plan and tasks unchanged except lane names. Deferred and superseded items listed.
