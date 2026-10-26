# Prior work disclosure

What existed before HackMeridian hacking begins, versus what is reserved for the
event. Tags: **`qualifier-v1`** exists. **`arrival`** and **`submission`** are
**not** created yet — do not mint them early.

Pre-event demo handoff started from **`975d959`**; CCR-11/FX follow-up merges
afterward — see `docs/LOCAL_DEMO.md` for the current tip after integration.

## On arrival (disclosed baseline)

| Layer        | What is included                                                            |
| ------------ | --------------------------------------------------------------------------- |
| Qualifier    | Scaffold Stellar `pay_shift` legacy (parked; not used by DF1–DF5)           |
| Domain / API | Quotes, payments, claims, endpoints, batches, events, sandbox controls      |
| Settlement   | Soroban `payout_vault` on Stellar testnet + mock settlement offline         |
| Providers    | Simulated bank, e-wallet, FX (labelled); config-driven corridors            |
| Web          | Send / payment detail / claim pages; local Vite proxy for sandbox auth      |
| Acceptance   | DF1–DF5 scripts, seed/reset, offline launcher; browser DF2/DF3/DF5 evidence |

Evidence for D1/D2 on this tip:
`scripts/demo/evidence/2026-10-23-d1-d2-final-acceptance.md`.

## Remaining gaps on the arrival baseline (do not over-claim)

- **Stellar fee-drift / orphan recovery** — **closed at the event** (H1, testnet
  PASS).
- **Different-seal-key negative control** — **closed at the event** (H2, PASS).
- **Mock vault** loses state across process restart (Stellar CCR-11 restart
  **PASS**).
- **Local Vite proxy** is not deployed authentication.
- Deployed public Preview / production hosts — account steps; not required to
  run the local demo.
- Event features below.

## New work at the event (after Sun 25 Oct 11:30)

Timing and scope are from the team plan; change only with an owner decision.

Merged pull requests #61 to #83 on `main` (tag `arrival` is the baseline):

- **Milestone 1, partial:** anchor client for the SDF test anchor (SEP-10,
  SEP-24, indicative SEP-38), a second payout vault for the anchor's asset, an
  operator CLI for the lifecycle, claim-page API and UI. The anchor withdrawal
  reached `completed` in a package-level testnet run; the claim-page journey is
  not run live.
- **Milestone 2, partial:** passkey wallet API and UI; a wallet created and
  deployed on testnet from a real device; fixes for the registration focus
  problem, Bind resume after a reload, and a passkey-kit null-expiry crash
  (local patch).
- **Milestone 3, done:** H1 fee-drift refund, H2 wrong-seal-key failure and H3
  decoded evidence on testnet.
- **Found and fixed during the event:** SDK fee double-count and a configured
  fee ceiling; duplicate deposits after a failed lock (CCR-23 recovery, with an
  operator CLI).
- **Product surface:** dashboard, payment history and developers pages in the
  web app; plain-English quote errors; a visible claim link; simulated provider
  limits raised for the demo.
- Stretch not done: fee sponsorship; hosted demo with real authentication.

Statuses are in the README milestone table. These milestones are **team
targets**, not established Scale eligibility requirements. Published
HackMeridian rules: **Scale** is a standalone builder track; **thematic tracks
are Genesis-only**. FlexiPay’s intended builder entry is **Scale** alone.

The `arrival` → `submission` diff (once those tags exist) is the event work.
