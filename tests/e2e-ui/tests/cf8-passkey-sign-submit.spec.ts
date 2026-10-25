import { expect, test, type Page } from "@playwright/test"

// CF8 covers the CCR-21 claim chain after the wallet deploy: prepare → passkey sign → submit.
// The passkey module and the claim API are deterministic fixtures served to the dev browser.
// This is fixture PASS: not a WebAuthn ceremony, not a signature over a real transaction, not a
// testnet release and not API acceptance. The physical passkey run is a separate acceptance.

const CONTRACT_ID = `C${"A".repeat(55)}`
const KEY_ID = "pQ7-_credential-id_base64url=="
const SIGNED_TX = "AAAAAgAAAAB+standard/base64+xdr=="
const DEPLOY_HASH = "ab".repeat(32)
const PENDING_HASH = "cd".repeat(32)
const PREPARE_ID = "prep_fixture_1"
const CLAIM_TOKEN = "claim_token_1"
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
// Base64 charset, so the fixture entries pass the shared schema. Never a real claim secret.
const UNSIGNED_ENTRY = "AAAAEAAAAAEAAAACauth-entry-fixture=="
const SIGNED_ENTRY = `c2ln${UNSIGNED_ENTRY}`

const now = (offsetMs = 0): string =>
	new Date(Date.now() + offsetMs).toISOString()

const claimFixture = () => ({
	paymentId: "pay_claim_1",
	status: "open",
	paymentStatus: "processing",
	expiresAt: now(120_000),
	amount: { amount: "250000000", currency: "USDC" },
	corridor: {
		from: { country: "US", currency: "USD" },
		to: { country: "PH", currency: "PHP" },
	},
	allowedDestinationTypes: ["crypto_wallet"],
	simulated: true,
})

type PrepareOutcome =
	| "ok"
	| "fail"
	| "expired"
	| "mismatch"
	| "contract_mismatch"
type SubmitOutcome = "paid" | "pending" | "fail" | "auth_expired" | "mismatch"

interface SignStubState {
	creates: number
	signs: number
	sign: "ok" | "cancel" | "error" | "hang"
	ledgers: number[]
	entryCounts: number[]
	deployHashes: string[]
	contractId: string
	keyIdBase64: string
	signedTx: string
}

type StubWindow = { __passkeySignTest?: SignStubState }

const STUB_MODULE = `
export class PasskeyWalletError extends Error {
	constructor(code, message) {
		super(message)
		this.name = "PasskeyWalletError"
		this.code = code
	}
}

export async function createPasskeyWallet() {
	const state = window.__passkeySignTest
	state.creates += 1
	return {
		contractId: state.contractId,
		keyIdBase64: state.keyIdBase64,
		signedTx: state.signedTx,
	}
}

export function rememberPasskeyDeploy(hash) {
	window.__passkeySignTest.deployHashes.push(hash)
}

export function forgetPasskeyWallet() {}

export async function signPasskeyClaimAuthEntries({ authEntries, signatureExpirationLedger }) {
	const state = window.__passkeySignTest
	state.signs += 1
	state.ledgers.push(signatureExpirationLedger)
	state.entryCounts.push(authEntries.length)
	if (state.sign === "cancel")
		throw new PasskeyWalletError("cancelled", "The passkey prompt was dismissed.")
	if (state.sign === "error")
		throw new PasskeyWalletError("failed", "The passkey wallet could not be used on this device.")
	if (state.sign === "hang") return new Promise(() => {})
	return authEntries.map((entry) => "c2ln" + entry)
}
`

interface ClaimCall {
	body: Record<string, unknown>
	headers: Record<string, string>
}

interface ApiMock {
	prepareCalls: () => ClaimCall[]
	submitCalls: () => ClaimCall[]
}

async function installStub(
	page: Page,
	overrides: Partial<SignStubState> = {},
): Promise<{ state: () => Promise<SignStubState> }> {
	const initial: SignStubState = {
		creates: 0,
		signs: 0,
		sign: "ok",
		ledgers: [],
		entryCounts: [],
		deployHashes: [],
		contractId: CONTRACT_ID,
		keyIdBase64: KEY_ID,
		signedTx: SIGNED_TX,
		...overrides,
	}
	await page.addInitScript((state) => {
		Object.assign(window, { __passkeySignTest: state })
	}, initial)
	await page.route(/\/src\/api\/passkeyWallet\.ts(\?.*)?$/, (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/javascript",
			body: STUB_MODULE,
		}),
	)
	return {
		state: () =>
			page.evaluate(
				() =>
					(window as unknown as StubWindow).__passkeySignTest as SignStubState,
			),
	}
}

async function mockClaim(
	page: Page,
	{
		prepare = ["ok"] as PrepareOutcome[],
		submit = ["paid"] as SubmitOutcome[],
	}: { prepare?: PrepareOutcome[]; submit?: SubmitOutcome[] } = {},
): Promise<ApiMock> {
	const prepares: ClaimCall[] = []
	const submits: ClaimCall[] = []
	const urls: string[] = []
	let prepareIndex = 0
	let submitIndex = 0

	page.on("request", (request) => urls.push(request.url()))

	await page.route(/\/v1\/claims\/claim_token_1$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ json: claimFixture() })
	})

	await page.route(/\/v1\/claims\/claim_token_1\/passkey\/deploy$/, (route) =>
		route.fulfill({
			json: {
				contractId: CONTRACT_ID,
				deployTxHash: DEPLOY_HASH,
				creationLedger: 1234,
				status: "deployed",
			},
		}),
	)

	await page.route(
		/\/v1\/claims\/claim_token_1\/passkey\/prepare$/,
		async (route) => {
			const request = route.request()
			const body = (request.postDataJSON() ?? {}) as Record<string, unknown>
			prepares.push({ body, headers: request.headers() })
			const outcome = prepare[Math.min(prepareIndex, prepare.length - 1)]
			prepareIndex += 1

			if (outcome === "fail") {
				await route.fulfill({
					status: 502,
					json: { code: "prepare_failed", message: "prepare failed upstream" },
				})
				return
			}
			if (outcome === "expired") {
				await route.fulfill({
					status: 409,
					json: { code: "expired", message: "claim link expired" },
				})
				return
			}
			if (outcome === "contract_mismatch") {
				await route.fulfill({
					status: 422,
					json: {
						code: "contract_mismatch",
						message: "claim bound to another wallet",
					},
				})
				return
			}
			await route.fulfill({
				json: {
					prepareId: PREPARE_ID,
					payoutId: "payout_1",
					networkPassphrase:
						outcome === "mismatch" ? "Other Network ; 2026" : NETWORK_PASSPHRASE,
					signatureExpirationLedger: 424242,
					authEntries: [UNSIGNED_ENTRY],
				},
			})
		},
	)

	await page.route(
		/\/v1\/claims\/claim_token_1\/passkey\/submit$/,
		async (route) => {
			const request = route.request()
			const body = (request.postDataJSON() ?? {}) as Record<string, unknown>
			submits.push({ body, headers: request.headers() })
			const outcome = submit[Math.min(submitIndex, submit.length - 1)]
			submitIndex += 1

			if (outcome === "fail") {
				await route.fulfill({
					status: 502,
					json: { code: "release_failed", message: "release failed upstream" },
				})
				return
			}
			if (outcome === "auth_expired") {
				await route.fulfill({
					status: 409,
					json: { code: "auth_expired", message: "signature expired" },
				})
				return
			}
			if (outcome === "mismatch") {
				await route.fulfill({
					status: 422,
					json: { code: "auth_mismatch", message: "entries do not match" },
				})
				return
			}
			if (outcome === "pending") {
				await route.fulfill({
					status: 202,
					json: {
						status: "pending",
						prepareId: PREPARE_ID,
						paymentId: "pay_claim_1",
						paymentStatus: "processing",
						pendingTxHash: PENDING_HASH,
					},
				})
				return
			}
			await route.fulfill({
				json: {
					claim: {
						...claimFixture(),
						status: "accepted",
						paymentStatus: "paid",
					},
					paymentId: "pay_claim_1",
					paymentStatus: "paid",
					releaseTxRef: "release-tx-ref-1",
				},
			})
		},
	)

	return {
		prepareCalls: () => prepares,
		submitCalls: () => submits,
	}
}

const openPasskey = async (page: Page) => {
	await page.goto(`/claim/${CLAIM_TOKEN}`)
	await expect(
		page.getByRole("heading", { name: "Claim your payment" }),
	).toBeVisible()
	await page.getByTestId("claim-passkey-option").getByRole("radio").check()
	await expect(page.getByTestId("passkey-panel")).toBeVisible()
}

const createWallet = async (page: Page) => {
	await page.getByTestId("passkey-create").click()
	await expect(page.getByTestId("passkey-deployed")).toBeVisible()
}

const prepare = async (page: Page) => {
	await page.getByTestId("passkey-prepare").click()
	await expect(page.getByTestId("passkey-approve")).toBeEnabled()
}

const approve = async (page: Page) => {
	await page.getByTestId("passkey-approve").click()
}

const storageDump = (page: Page) =>
	page.evaluate(() =>
		[...Object.entries(localStorage), ...Object.entries(sessionStorage)].map(
			([key, value]) => `${key}:${value}`,
		),
	)

test.use({ viewport: { width: 390, height: 844 } })

test.describe("CF8 passkey prepare, sign and submit", () => {
	test("prepare → sign → submit releases only when the API says accepted+paid", async ({
		page,
	}) => {
		const consoleMessages: string[] = []
		page.on("console", (message) => consoleMessages.push(message.text()))
		const stub = await installStub(page)
		const mock = await mockClaim(page)

		await openPasskey(page)
		await createWallet(page)
		await expect(page.getByTestId("passkey-panel")).not.toContainText(/\bPaid\b/)

		await prepare(page)
		const [prepareCall] = mock.prepareCalls()
		expect(prepareCall).toBeDefined()
		expect(prepareCall!.body).toEqual({ contractId: CONTRACT_ID })
		expect(prepareCall!.headers["idempotency-key"]).toBeUndefined()
		expect(prepareCall!.headers["authorization"]).toBeUndefined()
		await expect(page.getByTestId("passkey-ledger")).toContainText("424242")

		await approve(page)
		await expect(page.getByTestId("passkey-verified")).toBeVisible()
		await expect(page.getByTestId("passkey-panel")).toContainText(/Paid/)

		const submits = mock.submitCalls()
		expect(submits).toHaveLength(1)
		expect(submits[0]!.body).toEqual({
			prepareId: PREPARE_ID,
			contractId: CONTRACT_ID,
			signedAuthEntries: [SIGNED_ENTRY],
		})
		expect(submits[0]!.headers["idempotency-key"]).toMatch(/\S+/)
		expect(submits[0]!.headers["authorization"]).toBeUndefined()

		const state = await stub.state()
		// signAuthEntry received exactly the prepare ledger and one entry.
		expect(state.ledgers).toEqual([424242])
		expect(state.entryCounts).toEqual([1])
		expect(state.deployHashes).toEqual([DEPLOY_HASH])
		expect(state.signs).toBe(1)

		// No auth entry, credential id or claim token in storage or console.
		const stored = (await storageDump(page)).join(" ")
		const consoleText = consoleMessages.join(" ")
		for (const needle of [UNSIGNED_ENTRY, SIGNED_ENTRY, CLAIM_TOKEN, KEY_ID]) {
			expect(stored).not.toContain(needle)
			expect(consoleText).not.toContain(needle)
		}
		expect(await page.content()).not.toContain(UNSIGNED_ENTRY)

		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true)
	})

	test("202 is pending, never paid, and re-checks with the same key and body", async ({
		page,
	}) => {
		await installStub(page)
		const mock = await mockClaim(page, { submit: ["pending", "paid"] })

		await openPasskey(page)
		await createWallet(page)
		await prepare(page)
		await approve(page)

		await expect(page.getByTestId("passkey-processing")).toBeVisible()
		await expect(page.getByTestId("passkey-verified")).toHaveCount(0)
		await expect(page.getByTestId("passkey-panel")).not.toContainText(/\bPaid\b/)
		await expect(page.getByTestId("passkey-pending-hash")).toContainText(
			`${PENDING_HASH.slice(0, 8)}…`,
		)

		await page.getByTestId("passkey-check-release").click()
		await expect(page.getByTestId("passkey-verified")).toBeVisible()

		const submits = mock.submitCalls()
		expect(submits).toHaveLength(2)
		expect(submits[1]!.body).toEqual(submits[0]!.body)
		expect(submits[1]!.headers["idempotency-key"]).toBe(
			submits[0]!.headers["idempotency-key"],
		)
		expect(mock.prepareCalls()).toHaveLength(1)
	})

	test("a failed submit retries the same signed body, never a new prepare", async ({
		page,
	}) => {
		await installStub(page)
		const mock = await mockClaim(page, { submit: ["fail", "paid"] })

		await openPasskey(page)
		await createWallet(page)
		await prepare(page)
		await approve(page)

		await expect(page.getByTestId("passkey-error")).toBeVisible()
		await expect(page.getByTestId("passkey-retry")).toBeEnabled()
		await expect(page.getByTestId("passkey-panel")).not.toContainText(/\bPaid\b/)

		await page.getByTestId("passkey-retry").click()
		await expect(page.getByTestId("passkey-verified")).toBeVisible()

		const submits = mock.submitCalls()
		expect(submits).toHaveLength(2)
		expect(submits[1]!.body).toEqual(submits[0]!.body)
		expect(submits[1]!.headers["idempotency-key"]).toBe(
			submits[0]!.headers["idempotency-key"],
		)
		expect(mock.prepareCalls()).toHaveLength(1)
	})

	test("expired signing material asks for a new prepare with a new submit key", async ({
		page,
	}) => {
		await installStub(page)
		const mock = await mockClaim(page, { submit: ["auth_expired", "paid"] })

		await openPasskey(page)
		await createWallet(page)
		await prepare(page)
		await approve(page)

		await expect(page.getByTestId("passkey-error")).toBeVisible()
		await expect(page.getByTestId("passkey-panel")).toContainText(
			/signing window/i,
		)

		await page.getByTestId("passkey-retry").click()
		await expect(page.getByTestId("passkey-approve")).toBeEnabled()
		expect(mock.prepareCalls()).toHaveLength(2)

		await approve(page)
		await expect(page.getByTestId("passkey-verified")).toBeVisible()

		const submits = mock.submitCalls()
		expect(submits).toHaveLength(2)
		expect(submits[1]!.headers["idempotency-key"]).not.toBe(
			submits[0]!.headers["idempotency-key"],
		)
	})

	test("an auth mismatch re-prepares instead of resubmitting bad signatures", async ({
		page,
	}) => {
		await installStub(page)
		const mock = await mockClaim(page, { submit: ["mismatch", "paid"] })

		await openPasskey(page)
		await createWallet(page)
		await prepare(page)
		await approve(page)

		await expect(page.getByTestId("passkey-error")).toBeVisible()
		await expect(page.getByText(/did not match the prepared request/)).toBeVisible()

		await page.getByTestId("passkey-retry").click()
		await expect(page.getByTestId("passkey-approve")).toBeEnabled()
		expect(mock.prepareCalls()).toHaveLength(2)
		expect(mock.submitCalls()).toHaveLength(1)
	})

	test("a dismissed passkey prompt sends nothing and can be approved again", async ({
		page,
	}) => {
		await installStub(page, { sign: "cancel" })
		const mock = await mockClaim(page)

		await openPasskey(page)
		await createWallet(page)
		await prepare(page)
		await approve(page)

		await expect(page.getByTestId("passkey-sign-note")).toContainText(
			/dismissed/,
		)
		expect(mock.submitCalls()).toHaveLength(0)
		await expect(page.getByTestId("passkey-panel")).not.toContainText(/\bPaid\b/)

		// The prepared claim is still valid: the next approval signs and submits once.
		await page.evaluate(() => {
			const state = (window as unknown as StubWindow).__passkeySignTest
			if (state) state.sign = "ok"
		})
		await approve(page)
		await expect(page.getByTestId("passkey-verified")).toBeVisible()
		expect(mock.submitCalls()).toHaveLength(1)
	})

	test("an expired prepare stops before any signature", async ({ page }) => {
		const stub = await installStub(page)
		const mock = await mockClaim(page, { prepare: ["expired"] })

		await openPasskey(page)
		await createWallet(page)
		await page.getByTestId("passkey-prepare").click()

		await expect(page.getByTestId("passkey-expired")).toBeVisible()
		await expect(page.getByTestId("passkey-approve")).toHaveCount(0)
		await expect(page.getByTestId("passkey-retry")).toHaveCount(0)
		expect(mock.submitCalls()).toHaveLength(0)
		expect((await stub.state()).signs).toBe(0)
	})

	test("a prepare for another network is refused without signing", async ({
		page,
	}) => {
		const stub = await installStub(page)
		const mock = await mockClaim(page, { prepare: ["mismatch"] })

		await openPasskey(page)
		await createWallet(page)
		await page.getByTestId("passkey-prepare").click()

		await expect(page.getByTestId("passkey-error")).toBeVisible()
		await expect(page.getByTestId("passkey-panel")).toContainText(
			/different Stellar network/,
		)
		await expect(page.getByTestId("passkey-retry")).toHaveCount(0)
		await expect(page.getByTestId("passkey-approve")).toHaveCount(0)
		expect(mock.submitCalls()).toHaveLength(0)
		expect((await stub.state()).signs).toBe(0)
	})

	test("a double approval click produces one signature and one submit", async ({
		page,
	}) => {
		const stub = await installStub(page)
		const mock = await mockClaim(page)

		await openPasskey(page)
		await createWallet(page)
		await prepare(page)

		await page.evaluate(() => {
			const button = document.querySelector<HTMLButtonElement>(
				'[data-testid="passkey-approve"]',
			)
			button?.click()
			button?.click()
		})

		await expect(page.getByTestId("passkey-verified")).toBeVisible()
		expect(mock.submitCalls()).toHaveLength(1)
		expect((await stub.state()).signs).toBe(1)
	})
})
