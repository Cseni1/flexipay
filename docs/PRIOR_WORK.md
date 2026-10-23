# Prior work disclosure

What existed before HackMeridian hacking begins, versus what is reserved for
the event. Tags: **`qualifier-v1`** exists. **`arrival`** and **`submission`**
are **not** created yet — do not mint them early.

Integrated tip for the pre-event demo handoff: **`975d959`**.

## On arrival (disclosed baseline)

| Layer | What is included |
| --- | --- |
| Qualifier | Scaffold Stellar `pay_shift` legacy (parked; not used by DF1–DF5) |
| Domain / API | Quotes, payments, claims, endpoints, batches, events, sandbox controls |
| Settlement | Soroban `payout_vault` on Stellar testnet + mock settlement offline |
| Providers | Simulated bank, e-wallet, FX (labelled); config-driven corridors |
| Web | Send / payment detail / claim pages; local Vite proxy for sandbox auth |
| Acceptance | DF1–DF5 scripts, seed/reset, offline launcher; browser DF2/DF3/DF5 evidence |

Evidence for D1/D2 on this tip:
`scripts/demo/evidence/2026-10-23-d1-d2-final-acceptance.md`.

## Not complete on this tip (do not over-claim)

- **CCR-11 Stellar restart** — Freebuff in progress; mock restart release failed.
- **Stellar fee-drift recovery** — mock PASS only.
- Deployed public Preview / production hosts — account steps; not required to
  run the local demo.
- Event features below.

## New work at the event (after Sun 25 Oct 11:30)

Timing and scope are from the team plan; change only with an owner decision.

- Anchor cash-out to a bank via the SDF test anchor (SEP-10, indicative SEP-38,
  SEP-24).
- Passkey smart-wallet claim (no seed phrase).
- Fee sponsorship (stretch).

These are **planned demos**, not established Scale eligibility requirements.
Published HackMeridian rules: **Scale** is a standalone builder track;
**thematic tracks are Genesis-only**. FlexiPay’s intended builder entry is
**Scale** alone.

The `arrival` → `submission` diff (once those tags exist) is the event work.
