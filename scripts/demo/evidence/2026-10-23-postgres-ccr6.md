# Postgres repair + CCR-6 — 23 October 2026

Integrator worktree: `flexipay-integrate` / branch `csenge-cursor/integrate-2026-10-23`.  
**main tip:** `24f9c6a` (merge PR #24) · fix commit `cce1998`.

## 1. Embedded Postgres (darwin-arm64)

| Item | Detail |
| --- | --- |
| Failure | `dyld: Library not loaded: …/libicudata.77.dylib` (also `libicui18n`) during embedded `initdb` |
| Root cause | `@embedded-postgres/darwin-arm64` ships versioned ICU/lz4/z/zstd libs without the soname symlinks Postgres expects |
| Repair | `apps/api/src/dev/fix-embedded-pg-dylibs.ts` — idempotent symlinks; called from `embedded-db.ts` before init |
| Architecture kept | Embedded Postgres only (no SQLite / Docker / cloud substitute) |

### Proof

| Command | Result |
| --- | --- |
| `npm test --workspace @flexipay/api -- api.test fix-embedded-pg-dylibs` | **17 passed** (re-run after merge) |
| Live `npm run dev --workspace @flexipay/api` | Postgres migrate + **listening on `:8788`** |
| `POST /v1/recipients` (Bearer key) | **201** `rcp_9fb22c191bf47cb48f5d37e2` Worker Prove |
| `GET /v1/recipients` | **200** lists same row (real DB read) |

## 2. CCR-6 (`PlannedLeg.simulated`)

| Item | Detail |
| --- | --- |
| Conflict | A0 forces `PlannedLegSchema.simulated: z.literal(true)`; Architecture / `stellar_usdc` require `simulated: false` for real settle legs |
| Status | **proposed** in `docs/CONTRACT_CHANGES.md` — **not applied** |
| Blocker | Await Csaba (A0/CC1) confirmation before shared-schema edit |
| Owner | Csaba Cursor for accept + CC1 setters; integrator applies after ACK |

## 3. Merged into main this session (cumulative)

| PR | Merge | Notes |
| --- | --- | --- |
| #18–#23 | earlier | A0, SC2, CF0, D1, wiring, evidence |
| **#24** | `24f9c6a` | Postgres ICU fix + CCR-6 proposal text |

## 4. Still OPEN (policy — need executed evidence)

1. Exactly one retry with **no third attempt** (DF4).
2. DF5 recipient-kind exclusion **explanation** (not a non-empty reason string alone).
3. Actual vault **release to the intended recipient** (DF3 stellar; arbitrary successful Stellar tx insufficient).

## 5. Blockers / owners

| Item | Status | Owner |
| --- | --- | --- |
| CC1 → CC2 → CC3a/b | No open PR / no task branch | Csaba Cursor |
| CF1 / CF4 | No open PR | Csaba Freebuff |
| D2 `npm run demo:offline` | No handoff (launcher/seed/acceptance) | Freebuff standalone |
| CCR-6 schema apply | Proposed | Csaba ACK → then integrator/Csaba |
| DF1–DF5 mock / DF3 stellar / browser DF2/3/5 | BLOCKED on CC3 + CF1 | Csaba + Freebuff + integrator verify |

## Next exact task

Poll/review **CC1** PR when Csaba opens it; merge in dependency order CC1→CC2→CC3; apply CCR-6 only after Csaba ACK; wire root `demo:offline` only when Freebuff D2 handoff lands (do not edit Freebuff launcher files concurrently).
