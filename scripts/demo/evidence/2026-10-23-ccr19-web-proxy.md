# CCR-19 local web-auth proxy — 23 October 2026

**Proxy: PASS locally. Browser DF2: PASS. Browser DF3 claim surface: executed;
DF3 acceptance: FAIL/BLOCKED on CCR-15.** This is local Vite operation only,
not a deployed BFF.

- Base: `main` **`9a171e0`** (merged CCR-19 contract).
- Task branch: `csenge-freebuff/CCR-19-web-proxy`.
- CF1 brought in at `66ed520` (from `origin/csenge-freebuff/CF1-payments`);
  CF4 brought in at `a49780b` (from `origin/csenge-freebuff/CF4-claim`).
- Tested web code: **`d0721b2`**. API/domain tree is unchanged from `286d044`
  (`git diff --stat 286d044..HEAD -- apps/api packages/domain` is empty).
- API was the real Express app + migrations on a disposable embedded Postgres,
  one locally provisioned Demo Platform key, `FP_SETTLEMENT=mock`. No testnet,
  no real funds, no deployment.

## Ownership / scope

Integrator comments on #29 and #37 assign CCR-19 to Freebuff and say Cursor must
not edit the web tree for a second BFF. This branch edits only `apps/web`,
`packages/web-lib` (merge integration) and `tests/e2e-ui`; no API, domain,
adapter, root script or lockfile change.

The proxy is a Vite plugin, not `server.proxy`: it has an explicit route
allowlist, strips every browser `Authorization`, injects the server key for
protected routes and forwards claims with no Bearer. `vite preview` uses the
same middleware; a static deployment has no Node process and is not covered.

## Implemented route split

Protected (`Authorization: Bearer <server-side FP_API_KEY>`):

- `GET /v1/corridors`, `GET/POST /v1/recipients`, `POST /v1/quotes`
- `GET/POST /v1/payments`, `GET /v1/payments/{id}`,
  `POST /v1/payments/{id}/fund`, `POST /v1/payments/{id}/cancel`
- `GET /v1/events`, `GET/POST /v1/endpoints`, `GET/POST /v1/batches`,
  `GET /v1/batches/{id}`
- `POST /v1/sandbox/{fail-next|provider-health|reset|advance-time}`

Public (`auth: none`, no Bearer even at the upstream hop):

- `GET /v1/claims/{token}`
- `POST /v1/claims/{token}/accept`

Anything else under `/v1` returns 404 `proxy_route_not_allowed`; non-`/v1`
requests fall through to Vite. Target must be a bare http(s) origin. Missing
`FP_API_KEY` returns 503 `frontend_auth_not_configured`; missing/invalid
`FP_API_URL` returns 503 `frontend_api_not_configured`. Neither response
contains a key.

Browser clients now call relative `/v1/...` paths. `FP_API_URL` is no longer in
Vite `define`; `envPrefix` remains `PUBLIC_` only.

## Browser evidence

### DF2 — real browser through the proxy

`POST /v1/quotes` → **201**, `POST /v1/recipients` → **201**,
`POST /v1/payments` → **201**, detail polling **200**, fund … final UI
**Paid**. Browser-visible `Authorization` on every request was **absent**:
quotes, recipients, payments, payment detail and fund. No console errors.
The API only accepts a Bearer key, so the 201s prove the proxy supplied it.

### DF3 mock — claim surface executed, acceptance remains FAIL

Same browser run used a crypto PH quote with `claim_link` delivery. After fund,
the payment detail showed the one-time claim link; the browser opened
`/claim/{token}` (token masked), `GET /v1/claims/{token}` → **200**,
`POST /v1/claims/{token}/accept` → **200**, final claim **accepted**, payment
**paid**. Every claim request had no browser `Authorization`.

**DF3 is not PASS.** The current API still has the CCR-15 defect documented on
`286d044`: after a lock-fee drift, the settle leg stays `processing` with
`error: null`, no refund occurs, and a drifted lock remains claimable. The API
tree is identical to `286d044`; `CCR-13` still asserts `settle.status ===
"processing"` after the drift throw (2 passed). Do not read the normal mock
claim success above as recovery proof.

The CF1 create response is the only place the API returns the claim token;
`GET /v1/payments/{id}` deliberately returns `claimLink: null`. The detail
route now accepts the token handoff from the create navigation and maps
`/v1/claims/{token}` to `/claim/{token}`. A refresh loses the link because the
API does not reissue the token.

## Checks (all on `d0721b2`)

| Check | Command | Result |
| --- | --- | --- |
| Web typecheck | `npm run typecheck --workspace @flexipay/web` | 0 |
| Web lint | `npm run lint --workspace @flexipay/web` | 0 |
| Web build | `npm run build --workspace @flexipay/web` | 0 (large-chunk warning only) |
| Proxy unit/integration | `npx vitest run apps/web/vite.proxy.test.ts` | **8 passed** |
| Playwright fixture/UI suite | `npx playwright test --config tests/e2e-ui/playwright.config.ts` | **34 passed** |
| Separation | `bash scripts/check-separation.sh` | 0 |
| Diff whitespace | `git diff --check` | 0 |
| CCR-13 orchestrator | `npx vitest run test/orchestrator.test.ts -t "CCR-13"` | 2 passed (old behaviour) |

Proxy tests use a real local upstream and cover: key injected on protected,
browser key overwritten, body and `Idempotency-Key` preserved, claim GET and
accept with no upstream Bearer, unlisted route not forwarded, missing key 503,
invalid/missing target 503, and no key in the response.

### Build leak check

Built with a random `FP_API_KEY` sentinel and a separate
`FP_API_URL_SECRET_SENTINEL`: both values were absent from `apps/web/dist`.
The local upstream origin (`127.0.0.1:8788`) was also absent. Values were never
printed. Browser storage was checked for the claim token only; stale
StellarWalletsKit metadata keys exist on the page but contain no claim token.

## Blockers / not done

- **CCR-15 recovery remains OPEN**: no durable failed leg, drift error, refund
  or refund-failure replay. DF3 acceptance stays FAIL until CC2/Cursor lands
  and this evidence is repeated against the patched API.
- `GET/POST /v1/endpoints` and `GET/POST /v1/batches` are still **404** on this
  API; lane-D DF1/DF4/DF5 remain BLOCKED. DF2/DF3 browser flows above do not
  need endpoints.
- Fiat claim accept still returns 422; CF4 keeps fiat disabled.
- No deployed BFF, publish, merge or production claim. PR is for Cursor review
  only.
