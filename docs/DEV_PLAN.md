# FlexiPay development plan, 1 to 12 November 2026

Owner: Csenge. Helping: Csaba (some days). Integrator and reviewer: Csenge's
Claude. Builders: Csenge's Cursor, Csaba's Cursor, Csaba's Claude, Freebuff if
needed. ChatGPT coordinates Cursor and Freebuff.

Source of truth for scope: "FlexiPay: the plan for 12 November" (31 Oct). In
short: real, verified USDC payments on Solana between supported wallets, with
the receiver choosing how to be paid. Embedded wallets and bank legs only where
production access, regulatory eligibility and an end-to-end test are complete.
Demo Day 12 Nov, feature freeze 8 Nov.

## Working rules

- Every change is a pull request to `main`; Csenge's Claude reviews and merges.
  Builders never merge.
- Commit and push as `Cseni1 <199313317+Cseni1@users.noreply.github.com>` (check
  `git config user.name`).
- Work in a fresh worktree from the latest `main`, run `npm ci` (never symlink
  `node_modules`) and `npm run db:generate --workspace=@flexipay/api` before
  typechecking.
- A pull request is ready only when it passes: every workspace typecheck,
  `npm run lint`, the web production build
  (`npm run build --workspace=@flexipay/web`), the API tests, `tests/e2e`, the
  browser tests in `tests/e2e-ui`, and the OpenAPI check. Attach the command
  output.
- Devnet only. Mainnet needs Csenge's written approval. Secrets stay in local
  git-ignored files and server-side env; never in the browser bundle, a commit,
  chat or a public route.
- No made-up numbers in the real app. Anything simulated is labelled simulated.

## Where things stand (review of 1 Nov)

`main` (`9911588`): routing, pricing, orchestration, API, web app (dashboard,
payments, send, claim, developers), settlement on the mock adapter or the
optional Stellar adapter. Stellar hackathon material removed (#87). The UX
prototype source is in `prototype/` and deployed to the Vercel project
`flexipay-console-prototype`.

Agent branches `agent/task-01`, `task-02`, `task-03` (31 Oct) stack on each
other; `task-03` contains all three. They add Solana devnet USDC
wallet-to-wallet (CCR-24): `packages/adapter-solana`, `/v1/solana/*` routes,
Solana claim accept, Wallet Standard connect and a pay panel in `apps/web`.
**Not mergeable yet.** Findings, most serious first:

| #   | Finding                                                                                                                                                                                                                                                                                                                               | Severity                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| F1  | The web production build fails (web tsconfig picks up `client.test.ts` node types; `adapter-solana/config.ts` uses `process` and is imported into the browser; a Wallet Standard commitment type error). `adapter-solana` and `api` typechecks fail (`allowImportingTsExtensions`; `embedded-db.ts` reads a private `process` field). | Blocker                  |
| F2  | 23 browser tests that pass on `main` fail on the branch: send page, claim page, shell, proxy config, passkey guard.                                                                                                                                                                                                                   | Blocker                  |
| F3  | Wrong-token bypass in `verifyUsdcTransfer`: the instruction fallback treats a plain SPL `transfer` (which carries no mint) as the expected mint, and the owner lookup ignores the mint, so a transfer of any token to the recipient can pass.                                                                                         | Security, blocker        |
| F4  | One transaction signature can mark several payments paid: no uniqueness across payments and no binding to the payment (no reference key, no time check).                                                                                                                                                                              | Security, blocker        |
| F5  | The paid-to address is the recipient's latest Solana endpoint, not the address accepted on this claim. A second claim, or a platform `POST /v1/endpoints`, changes where an earlier payment is checked.                                                                                                                               | Security, blocker        |
| F6  | `GET /v1/solana/config` (public) returns the server RPC URL when no public one is set. A Helius URL with an API key would leak.                                                                                                                                                                                                       | Security, blocker        |
| F7  | A production test hook: `devnetTestWallet.ts` registers a wallet that signs with a secret key read from `window.__FP_SOLANA_TEST_WALLET__`, and it ships in the app bundle. It also breaks the existing "no test hook in production code" guard test.                                                                                 | Security, blocker        |
| F8  | `POST /v1/payments/{id}/solana/confirm` verifies before checking state (claim accepted, settle waiting, payment not refunded or expired).                                                                                                                                                                                             | High                     |
| F9  | Design: the Solana claim still requires funding and locking through the mock or Stellar vault first. With Stellar settlement the locked funds would stay in the vault while the sender also pays on Solana. Solana needs its own settle rail.                                                                                         | High (core backend task) |
| F10 | `apps/api/openapi.json` not regenerated (1 API test fails).                                                                                                                                                                                                                                                                           | Medium                   |
| F11 | CCR-24 was marked accepted by the building agent; it needs integrator acceptance with the fixes above.                                                                                                                                                                                                                                | Process                  |
| F12 | Dependencies: `@solana/web3.js` v1 and `@solana/spl-token` (high advisory via `bigint-buffer`); the 12 Nov plan names Solana Kit. The web app still bundles `@creit.tech/stellar-wallets-kit` (8 high advisories, and the "MetaMask session" console noise).                                                                          | Medium                   |

Carried over from the Stellar work:

| #   | Item                                                                                                                                                          | Decision proposed                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Unresolved: the Stellar passkey wallet Create fails in the browser with "could not be used on this device" before any API call; no console line was captured. | Not on the 12 Nov path (the FlexiPay wallet is Solana). Remove the Stellar passkey and anchor options from the web claim page; keep the API code for now. |
| S2  | No hosted API and no user login: the dashboard only works through the local Vite proxy that injects a demo API key.                                           | Needed before the Vercel front end can use real data (task D).                                                                                            |
| S3  | `scripts/check-separation.sh`, the husky hook and the required `separation` CI check still block the word FlexiWork, although the rule is gone.               | Csenge to decide; the check needs a branch-protection change in GitHub settings.                                                                          |
| S4  | About 100 stale remote branches; PR #85 (hackathon evidence) is open.                                                                                         | Clean up after Demo Day; close #85.                                                                                                                       |

## Architecture decision for the front end

The real front end is `apps/web` (React, typed API client, tests). The prototype
in `prototype/` is the design reference. We bring the prototype's look and pages
into `apps/web`, backed by the API, and point a Vercel project at the `apps/web`
build once it has a hosted API. The prototype stays deployed until then. We do
not wire the static prototype to the API directly (no types, no tests, and it
would need browser-side credentials).

## Today, 1 November: four lanes in parallel

Order matters only where stated. Each lane opens one pull request per task.

### Lane A, Csenge's Cursor: make the Solana branch mergeable (F1, F2, F7, F10)

Branch `cseni1/solana-base` from `origin/agent/task-03-live-ui-payment`, rebased
onto `main`.

1. Rebase onto `main` and resolve conflicts.
2. Fix every typecheck and the web production build (F1). Keep node-only code
   out of the browser: split `adapter-solana` into a browser-safe entry
   (address, amount, build-transfer) and a server entry (config, verify).
3. Make all browser tests pass again (F2) without weakening them.
4. Move the devnet test wallet out of the production bundle (F7): inject it only
   from Playwright (`addInitScript` of a test-only module) or behind
   `import.meta.env.DEV` plus an explicit dev flag. The source guard test must
   pass.
5. Regenerate the OpenAPI document (F10).

Done when every check in "Working rules" passes. No behaviour change beyond the
fixes.

### Lane B, Csaba's Cursor: Solana verification and settle rail (F3, F4, F5, F6, F8, F9)

Starts on `packages/adapter-solana` and the CCR text now; moves to API code
after Lane A's pull request merges.

1. F3: delete the instruction fallback; verify by the recipient owner's balance
   change for the configured mint only. Tests: a non-USDC transfer, a USDC
   transfer to someone else, a failed transaction, an amount below the expected
   one.
2. F4: give each payment a Solana Pay `reference` public key in the intent; the
   transfer must include it, and confirm checks it. Also refuse a signature
   already stored on any payment (check plus a database unique index on the
   Solana signature) and a transaction older than the intent.
3. F5: store the accepted endpoint id on the claim at accept time and read only
   that one at intent and confirm.
4. F6: `/v1/solana/config` returns `publicRpcUrl` only, otherwise `null`.
5. F8: confirm applies the same state checks as intent before calling the RPC.
6. F9: a `solana_usdc` settle rail: funding does not lock in a vault; the settle
   leg waits for the verified transfer; the payment is paid only after confirm.
   Mock and Stellar paths unchanged.
7. Update CCR-24 in `docs/CONTRACT_CHANGES.md` with these changes, marked
   "proposed", for integrator acceptance (F11).

### Lane C, Csaba's Claude: bring the prototype design into `apps/web`

New files first, to avoid colliding with Lane A, which owns `SendPayment.tsx`,
`ClaimPage.tsx` and `PaymentDetail.tsx` until its pull request merges.

1. Design tokens, layout and sidebar from `prototype/index.html` (light and
   dark), applied to the existing `AppShell` and pages.
2. A Recipients page on `GET /v1/recipients` and `GET /v1/endpoints`, with
   create.
3. A FlexiPay wallet page and a Pay from page as honest shells: connected Solana
   wallet (Wallet Standard, once Lane A merges), balances from chain, and the
   embedded wallet shown as "coming soon" until Crossmint access is confirmed.
4. After Lane A merges: restyle Send, Payment detail and Claim, and remove the
   Stellar passkey and anchor options from the claim page (S1).

### Lane D, Csenge's Claude (integrator) plus Csenge: hosting and access

1. Review and merge every pull request; accept or amend CCR-24 (F11); keep this
   plan current.
2. Hosting proposal for the API: a host with managed Postgres, the seal key and
   Helius key as server secrets, CORS for the web origin, and a sign-in for the
   dashboard (S2). Csenge chooses the provider and creates the accounts; nothing
   is created without her go.
3. Remove `@creit.tech/stellar-wallets-kit` from the web app once Lane C no
   longer needs it (F12).
4. Decide S3 (separation check) with Csenge.

### Freebuff (if needed)

Devnet readiness, no code changes to the app: two devnet test wallets, devnet
USDC from the faucet, a Helius devnet key in local env, and a one-page runbook
for a real devnet payment. Runs the end-to-end devnet payment once Lanes A and B
have merged, and records the signature and Explorer link.

### Csenge (human), from the 12 Nov plan

Apply for Demo Day; ask Crossmint whether production Wallets need an order form
and KYB; submit the Transak KYB form and start the MoonPay review; decide the
legal entity; book the lawyer hour on UK crypto promotions.

## Next days

| Days        | Goal                                                                       | Done when                                                                  |
| ----------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1 to 3 Nov  | Front end on real data; Solana base merged                                 | `apps/web` in the prototype design on a hosted API; Lanes A and B merged   |
| 4 to 6 Nov  | Real devnet USDC payment between two wallets, with the invite (claim) link | A verified devnet payment end to end, signature and Explorer link recorded |
| 7 to 8 Nov  | Crossmint wallet if approved; Transak and MoonPay sandbox                  | Sandbox flows behind clear labels; feature freeze 8 Nov                    |
| 9 to 11 Nov | 3 to 5 real people, small amounts                                          | Fixes only                                                                 |
| 12 Nov      | Demo Day                                                                   |                                                                            |
