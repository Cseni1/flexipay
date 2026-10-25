# FlexiPay: event build plan (Sun 25 Oct to Mon 26 Oct)

For Csenge, Csaba and their agents. **Claude is the supervisor manager of the whole build:** sets priorities, decides go/no-go with the two humans, reviews and merges every pull request into `main`, runs the checks, unblocks lanes, and keeps the status words honest. ChatGPT coordinates Cursor and Freebuff from this file; Cursor and Freebuff build and push branches to GitHub for Claude to integrate. Replaces the event sections of `FlexiPay-Csenge-DEV-PLAN.md` and `docs/DEV_PLAN.md` v5. Baseline: `main` at `9d9c039` (accepted; DF1 to DF5 and the restart proof passed before the event). **Tag `arrival` is pushed on that commit.** Hackathon has started.

## 0. What the judges score (hackmeridian.com/build)

Scale entry. **Scale does not pick a track; the thematic tracks (including Composed) do not apply.** Scored on: milestone completion against the goals set at pre-event intake, SCF eligibility, production readiness, ecosystem impact. Rubric weights: ecosystem alignment 20, user value and problem 20, technical execution 15, innovation 15, hackathon progress 10, market and ecosystem potential 10, product design and UX 10. Priority order: Adoption, then Discovery, then Continuation. Review is asynchronous from the demo video, pitch deck, GitHub repo and submission answers. **Deadline Monday 26 Oct 12:00, no late submissions.** Finalists pitch live on Wed 28 Oct.

Consequence: the three milestones below, with evidence, are the product of this weekend. Everything else supports them.

## 1. Rules for everyone

- **Status words:** VERIFIED COMPLETE, PARTIAL, NOT STARTED, BLOCKED, NOT VERIFIED. "Done" in the deck only with evidence: a testnet transaction hash, a test result, or a timestamp in the video. Never "no one checks".
- **Evidence goes in `scripts/demo/evidence/<date>-<milestone>.md`:** commit, command, result, transaction hashes. No secrets.
- **Pull requests:** branch `<agent>/<task>`, own lane's folders only, the `separation` check green, the demo script or test output attached. Claude reviews before merge. Shared interface changes go through `docs/CONTRACT_CHANGES.md`.
- **Event work is disclosed:** tag `arrival` at the baseline before the first event commit; event commits are on `event/*` branches; `docs/PRIOR_WORK.md` lists the diff at the end.
- **Neutral sample names** (Demo Platform, Worker A). FlexiPay stays separate from other products in code and commits.
- **Timeboxes are limits, not promises.** If a milestone is blocked at its checkpoint, report BLOCKED with the exact reason and switch to the fallback. Do not sit on it.

## 2. The three milestones

No goals were submitted at pre-event intake and none are required. The deck states the milestones itself: slide 8 says "Our event milestones, set at the start of the hackathon on 25 Oct", never "matching the goals set at intake".

| # | Milestone | Owner | Done when (evidence) |
|---|---|---|---|
| M1 | Cash-out to a bank through an anchor | Csenge | A testnet SEP-24 withdrawal reaches the anchor's terminal status, with the on-chain payment hash and the anchor transaction record |
| M2 | Passkey smart-wallet claim, no seed phrase | Csaba | A passkey-created contract wallet receives a vault release on testnet; hash plus a recorded browser run |
| M3 | Close known testnet gaps | Csenge | Fee-drift recovery on testnet, seal-key negative control, decoded RPC evidence for DF1 and DF2, each with a short evidence file |

Stretch, only after M1 to M3: fee sponsorship for the passkey claim; a hosted demo with real authentication.

## 3. Csenge's line

### Cursor (chain): M1 then M3

**E1 anchor cash-out (target 4 to 5 h, checkpoint Sun 17:30).** Package `packages/adapter-stellar`. Findings that shape the design:

1. Use the SDF test anchor `testanchor.stellar.org`: SEP-10 (classic G account), SEP-24 hosted withdrawal, indicative price from SEP-38 `GET /price` with `context=sep6` (the test anchor rejects `sep24` as a quote context, so label the price indicative; the hosted screen shows the binding rate). Limits: 1 to 10 USDC; pays out only to a USD or CAD bank account by wire. Re-check `info` at the start.
2. **The anchor's USDC is a different asset** (issuer `GBBD47…`) from our vault's (`GBBO6N…`). Path: deploy a **second vault** with the same constructor script, token = the anchor's USDC (its Stellar asset contract). Get anchor USDC into the payer through a SEP-24 **deposit** (1 to 10 USDC). The anchor route then settles in the anchor's asset. Document this in `docs/STELLAR.md`; never present it as a conversion.
3. Flow for the demo: claim link → vault #2 lock → release to the recipient's classic account → SEP-10 login → SEP-24 withdraw (hosted screen opened from the claim page) → recipient wallet pays the anchor with the requested memo → poll the anchor transaction until it reaches a terminal status. Baseline recipient key is the custodial demo wallet.
4. Register the anchor as a payout provider through Csaba's API lifecycle (a provider-adapter entry; no routing rewrite). The UI says "reference anchor on testnet", never a local PH or Brazil payout.

Fallback at the checkpoint: if the withdrawal cannot complete, report the furthest stage reached (auth, interactive URL, payment sent, anchor status) with evidence, mark M1 PARTIAL, and keep the indicative price and the hosted flow in the video.

**M3 hardening (target 3 h, in parallel with Freebuff).**
- H1 fee-drift / orphan-lock recovery on **testnet** (currently verified on the mock only): reproduce, recover, decode.
- H2 different-seal-key negative control: restart the API with another seal key; the claim must fail safely with a clear error and leak nothing.
- H3 decoded RPC evidence for DF1 and DF2 (as already done for DF3 and DF4).

### Freebuff (acceptance): evidence, then DF7

- Start now: H3 decode scripts and evidence files for DF1 and DF2; baseline regression run (mock and Stellar) and a retained report at the `arrival` commit.
- DF7 script (`scripts/demo`): drives the anchor lifecycle against the real test anchor, asserts the terminal status, prints hashes. It must not claim a step it did not execute.
- Fixtures: anchor asset funding and the second vault's ids (public only, in `testnet-ids`-style file).
- Last two hours: evidence index for `docs/STELLAR.md` and `docs/PRIOR_WORK.md`.

## 4. Csaba's line

### Cursor (core and API): M2 backend

**E2 passkey wallet (target 4 to 5 h, checkpoint Sun 17:30).** Use [passkey-kit](https://github.com/kalepail/passkey-kit) (client creates the wallet with WebAuthn; the server side submits). Design:

1. The recipient creates a wallet on the claim page with Touch ID or Face ID; the result is a contract address (`C…`).
2. The vault's `claim(id, secret, to)` asks `to` to authorise. A contract account authorises through its passkey signature on the auth entry. The transaction source can be the backend's key, so the recipient needs **no XLM**, and a contract address holds the vault's token without a trustline.
3. API: accept a contract address as the claim destination, build the claim, return the auth entry to sign, then submit.
4. Check the passkey-kit README for the unaudited warning before wiring it and say so in `docs/STELLAR.md`.

Fallback at the checkpoint: if the passkey signature cannot authorise the claim, report the furthest stage (wallet created, address derived, auth entry built, signed, submitted) as PARTIAL and keep M1 and M3 as the deliverable.

Cash-out with the passkey wallet needs SEP-45 (the test anchor publishes it, contract `CD3LA6RK…`); whether the test anchor completes a SEP-24 withdrawal from a contract account is **not verified**. M1 uses a classic account. Say so plainly if only M1 and M2 are proven separately.

### Freebuff (web): claim page for M1 and M2

- Add two options to the claim page's options list: "Create passkey wallet" and "Cash out to bank (reference anchor)". Show the indicative price, labelled indicative, and the hosted anchor screen.
- Phone-width, simulated and testnet labels, existing design system only. Do not change the three-screen scope.
- Browser tests where automatable. A passkey touch cannot be scripted: record it in the video and note it as a manual run.

## 5. Shared: submission pack (Csaba's lane edits shared docs; Claude reviews)

1. **README rewrite for judges (done by Claude, merged early; updated with evidence at the end):** what it is, the problem, how it works (diagram), real versus simulated, a developer quickstart with `curl` for quote, payment and claim (Discovery), run steps, environment variables, evidence links, video and deck links, the three milestones and their status. Replace the current tagline with the deck's: "Pay anyone, anywhere. They choose how to get paid."
2. **Docs:** remove "Composed" from `PRODUCT.md`, `ARCHITECTURE.md`, `DEV_PLAN.md`; update `PRIOR_WORK.md` (arrival to submission diff) and `STELLAR.md` (contract ids, hashes, second vault, anchor asset).
3. **Deck:** slide 8 wording as above; fill or delete the placeholder fields on slides 11, 13 and 19, change slide 15 to "tranches follow milestones from MVP to testnet to mainnet", refresh the numbers on slide 6, set milestone statuses from evidence only.
4. **Video** (about 3 minutes, recorded Mon 07:00 to 09:00): claim on phone, route with reasons, South Africa exclusion, failure and refund, then the anchor withdrawal and passkey claim, each shown with the real transaction.
5. **Submission answers:** draft Sunday evening, paste Monday.
6. **Tag `submission`** on the submitted commit.

## 6. Timeline (Lisbon time)

| When | What |
|---|---|
| Now | Tag `arrival`; answer the open questions; agents start E1, E2, H items, claim UI, evidence |
| Sun 17:30 | **Checkpoint:** anchor price plus hosted flow reached; a passkey wallet created. Each owner reports VERIFIED or PARTIAL with evidence |
| Sun 17:30 to 20:30 | Finish the lifecycle (withdrawal terminal status; passkey claim); H1 to H3 evidence |
| Sun 20:30 to 01:00 | Integration: claim page options live, DF7 and DF8 runs, full regression at the new tip. Sleep in shifts after 01:00 |
| Mon 07:00 to 09:00 | Fixes only; README and deck finished; video recorded |
| Mon 09:00 | Submission briefing: read the actual rules |
| **Mon 09:15** | **Feature freeze.** Tag; final regression; evidence index |
| **Mon 11:00 target, 11:30 latest** | **Submit.** The deadline is 12:00 with no late submissions |

## 7. If behind (cut from the top)

Hosted demo; fee sponsorship; polish of the hosted anchor screen; extra Playwright; the alternatives list. **Never cut:** M3 evidence (the safest production-readiness proof), the README, the video, the honest status table. Do not swap a blocked milestone for another to look finished: report it.

## 8. Supervisor decisions already made

- **Merging:** Claude merges, after review and the required check. Agents never merge.
- **Hosting (stretch, after M1 to M3):** Claude sets it up, on a **new** Vercel project and a new API host with Postgres under Csenge's own account. Not the FlexiWork account, and no Supabase (separation rule). Needs one login from Csenge. The page does not require a live URL, so the video and README come first.
- **Adoption evidence:** Claude uses what the repo and deck support (the working testnet demo, the FlexiWork first-trial plan already on slide 14) and does not invent any pilot or letter of intent. Csenge adds a real one if it exists.

## 9. Still needed from the humans

1. Csenge: log in to Vercel (and the API host) when Claude asks, only if the hosted demo goes ahead.
2. Both: tell Claude immediately when an agent is stuck, a checkpoint is missed, or a decision about scope is needed.
