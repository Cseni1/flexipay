import { expect, test, type Page } from "@playwright/test"

// CF7 covers the CCR-20 wallet creation + deploy path in the browser. The claim API is mocked
// and the passkey-kit module is replaced with a deterministic fixture module (served by the
// dev server, not a production switch). This is fixture PASS: it is not a real passkey
// ceremony, not a testnet deploy and not API acceptance. The physical passkey run is separate.

const CONTRACT_ID = `C${"A".repeat(55)}`
const KEY_ID = "pQ7-_credential-id_base64url=="
const SIGNED_TX = "AAAAAgAAAAB+standard/base64+xdr=="
const DEPLOY_HASH = "ab".repeat(32)
const CLAIM_TOKEN = "claim_token_1"

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

interface StubState {
	creates: number
	create: "ok" | "cancel" | "error" | "hang"
	createDelay: number
	contractId: string
	keyIdBase64: string
	signedTx: string
	deployHashes: string[]
}

type StubWindow = { __passkeyTest?: StubState }

const STUB_MODULE = `
export class PasskeyWalletError extends Error {
	constructor(code, message) {
		super(message)
		this.name = "PasskeyWalletError"
		this.code = code
	}
}

export function rememberPasskeyDeploy(hash) {
	window.__passkeyTest?.deployHashes?.push(hash)
}

export function forgetPasskeyWallet() {}

export async function signPasskeyClaimAuthEntries() {
	throw new PasskeyWalletError("failed", "Signing is not part of this fixture.")
}

export async function createPasskeyWallet() {
	const state = window.__passkeyTest
	state.creates += 1
	if (state.create === "cancel") {
		throw new PasskeyWalletError(
			"cancelled",
			"The passkey prompt was dismissed. No wallet was deployed.",
		)
	}
	if (state.create === "error") {
		throw new PasskeyWalletError(
			"failed",
			"The passkey wallet could not be created on this device.",
		)
	}
	if (state.create === "hang") return new Promise(() => {})
	if (state.createDelay > 0)
		await new Promise((resolve) => setTimeout(resolve, state.createDelay))
	return {
		contractId: state.contractId,
		keyIdBase64: state.keyIdBase64,
		signedTx: state.signedTx,
	}
}
`

interface DeployCall {
	url: string
	method: string
	headers: Record<string, string>
	body: Record<string, unknown>
}

interface ClaimMock {
	deployCalls: () => DeployCall[]
	allPayloadUrls: () => string[]
}

async function installStub(
	page: Page,
	overrides: Partial<StubState> = {},
): Promise<{ creates: () => Promise<number> }> {
	const initial: StubState = {
		creates: 0,
		create: "ok",
		createDelay: 0,
		contractId: CONTRACT_ID,
		keyIdBase64: KEY_ID,
		signedTx: SIGNED_TX,
		deployHashes: [],
		...overrides,
	}
	await page.addInitScript((state) => {
		Object.assign(window, { __passkeyTest: state })
	}, initial)
	await page.route(/\/src\/api\/passkeyWallet\.ts(\?.*)?$/, (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/javascript",
			body: STUB_MODULE,
		}),
	)
	return {
		creates: async () =>
			page.evaluate(() => {
				const state = (window as unknown as StubWindow).__passkeyTest
				return state?.creates ?? -1
			}),
	}
}

async function mockClaim(
	page: Page,
	outcomes: ("ok" | "fail" | "reject" | "expired")[] = ["ok"],
	deployDelayMs = 0,
): Promise<ClaimMock> {
	const calls: DeployCall[] = []
	const urls: string[] = []
	let index = 0

	page.on("request", (request) => urls.push(request.url()))

	await page.route(/\/v1\/claims\/claim_token_1$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ json: claimFixture() })
	})

	await page.route(
		/\/v1\/claims\/claim_token_1\/passkey\/deploy$/,
		async (route) => {
			const request = route.request()
			const body = (request.postDataJSON() ?? {}) as Record<string, unknown>
			calls.push({
				url: request.url(),
				method: request.method(),
				headers: request.headers(),
				body,
			})
			const outcome = outcomes[Math.min(index, outcomes.length - 1)]
			index += 1
			if (deployDelayMs > 0)
				await new Promise((resolve) => setTimeout(resolve, deployDelayMs))

			if (outcome === "fail") {
				await route.fulfill({
					status: 502,
					json: { code: "deploy_failed", message: "deploy failed upstream" },
				})
				return
			}
			if (outcome === "reject") {
				await route.fulfill({
					status: 422,
					json: { code: "invalid_deploy_tx", message: "carrier rejected" },
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
			await route.fulfill({
				json: {
					contractId: body.contractId,
					deployTxHash: DEPLOY_HASH,
					creationLedger: 1234,
					status: "deployed",
				},
			})
		},
	)

	return {
		deployCalls: () => calls,
		allPayloadUrls: () => urls,
	}
}

const openClaim = async (page: Page) => {
	await page.goto(`/claim/${CLAIM_TOKEN}`)
	await expect(
		page.getByRole("heading", { name: "Claim your payment" }),
	).toBeVisible()
}

const selectPasskey = async (page: Page) => {
	await page.getByTestId("claim-passkey-option").getByRole("radio").check()
	await expect(page.getByTestId("passkey-panel")).toBeVisible()
}

const clickCreate = (page: Page) => page.getByTestId("passkey-create").click()

const storageDump = (page: Page) =>
	page.evaluate(() =>
		[...Object.entries(localStorage), ...Object.entries(sessionStorage)].map(
			([key, value]) => `${key}:${value}`,
		),
	)

test.use({ viewport: { width: 390, height: 844 } })

test.describe("CF7 passkey wallet deploy", () => {
	test("creates one wallet, deploys once and keeps signing unavailable", async ({
		page,
	}) => {
		const consoleMessages: string[] = []
		page.on("console", (message) => consoleMessages.push(message.text()))
		const stub = await installStub(page)
		const mock = await mockClaim(page)

		await openClaim(page)
		await selectPasskey(page)
		await clickCreate(page)

		await expect(page.getByTestId("passkey-deployed")).toBeVisible()
		await expect(page.getByTestId("passkey-deploy-hash")).toBeVisible()
		// The chain continues with prepare; nothing is submitted until the user asks.
		await expect(page.getByTestId("passkey-prepare")).toBeEnabled()
		await expect(page.getByTestId("passkey-approve")).toHaveCount(0)

		expect(await stub.creates()).toBe(1)
		const calls = mock.deployCalls()
		expect(calls).toHaveLength(1)
		const call = calls[0]!
		expect(call.method).toBe("POST")
		expect(Object.keys(call.body).sort()).toEqual([
			"contractId",
			"keyIdBase64",
			"signedTx",
		])
		expect(call.body.contractId).toBe(CONTRACT_ID)
		// The credential id stays base64url and the carrier stays standard base64: no
		// format normalisation happens on the way to the API.
		expect(call.body.keyIdBase64).toBe(KEY_ID)
		expect(call.body.signedTx).toBe(SIGNED_TX)
		expect(call.headers["idempotency-key"]).toMatch(/\S+/)
		expect(call.headers["authorization"]).toBeUndefined()
		expect(call.headers["content-type"]).toContain("application/json")

		// No prepare/submit call: those routes are not part of this build.
		expect(
			mock
				.allPayloadUrls()
				.filter((url) => /passkey\/(prepare|submit)/.test(url)),
		).toEqual([])
		expect(
			mock
				.allPayloadUrls()
				.some((url) => url.includes(`/v1/claims/${CLAIM_TOKEN}`)),
		).toBe(true)

		// Nothing is reported as paid/completed without an API claim confirmation.
		const text = await page.getByTestId("passkey-panel").innerText()
		expect(text).not.toMatch(/\bPaid\b|\bCompleted\b/)
		await expect(page.locator('[data-claim-status="open"]')).toBeVisible()

		const stored = (await storageDump(page)).join(" ")
		const consoleText = consoleMessages.join(" ")
		for (const needle of [CLAIM_TOKEN, SIGNED_TX, KEY_ID]) {
			expect(stored).not.toContain(needle)
			expect(consoleText).not.toContain(needle)
		}

		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true)
	})

	test("a double click starts one ceremony and one deploy", async ({
		page,
	}) => {
		const stub = await installStub(page, { createDelay: 150 })
		const mock = await mockClaim(page, ["ok"], 100)

		await openClaim(page)
		await selectPasskey(page)
		// Two clicks in the same task, before React can re-render a disabled button.
		await page.evaluate(() => {
			const button = document.querySelector<HTMLButtonElement>(
				'[data-testid="passkey-create"]',
			)
			button?.click()
			button?.click()
		})

		await expect(page.getByTestId("passkey-deployed")).toBeVisible()
		expect(await stub.creates()).toBe(1)
		expect(mock.deployCalls()).toHaveLength(1)
	})

	test("a failed deploy retries the same body with the same idempotency key", async ({
		page,
	}) => {
		const stub = await installStub(page)
		const mock = await mockClaim(page, ["fail", "ok"])

		await openClaim(page)
		await selectPasskey(page)
		await clickCreate(page)

		await expect(page.getByTestId("passkey-deploy-error")).toBeVisible()
		await expect(page.getByTestId("passkey-retry")).toBeEnabled()
		await expect(
			page
				.getByText(
					/Retrying sends the same deploy request with the same idempotency key/,
				)
				.last(),
		).toBeVisible()
		await expect(page.getByTestId("passkey-deployed")).toHaveCount(0)

		await page.getByTestId("passkey-retry").click()
		await expect(page.getByTestId("passkey-deployed")).toBeVisible()

		// The retry is a network retry: no second passkey ceremony.
		expect(await stub.creates()).toBe(1)
		const calls = mock.deployCalls()
		expect(calls).toHaveLength(2)
		expect(calls[1]!.headers["idempotency-key"]).toBe(
			calls[0]!.headers["idempotency-key"],
		)
		expect(calls[1]!.body).toEqual(calls[0]!.body)
		for (const call of calls)
			expect(call.headers["authorization"]).toBeUndefined()
	})

	test("a rejected carrier is not offered as a blind retry", async ({
		page,
	}) => {
		await installStub(page)
		const mock = await mockClaim(page, ["reject"])

		await openClaim(page)
		await selectPasskey(page)
		await clickCreate(page)

		await expect(page.getByTestId("passkey-deploy-error")).toBeVisible()
		await expect(page.getByText(/invalid_deploy_tx/)).toBeVisible()
		await expect(page.getByTestId("passkey-retry")).toHaveCount(0)
		await expect(page.getByTestId("passkey-deployed")).toHaveCount(0)
		expect(mock.deployCalls()).toHaveLength(1)
	})

	test("cancelling during the passkey ceremony sends no request", async ({
		page,
	}) => {
		const stub = await installStub(page, { create: "hang" })
		const mock = await mockClaim(page)

		await openClaim(page)
		await selectPasskey(page)
		await clickCreate(page)

		await expect(page.getByTestId("passkey-cancel")).toBeVisible()
		await page.getByTestId("passkey-cancel").click()

		await expect(page.getByTestId("passkey-cancelled")).toBeVisible()
		await page.waitForTimeout(300)
		expect(mock.deployCalls()).toHaveLength(0)
		expect(await stub.creates()).toBe(1)
		await expect(page.getByTestId("passkey-deployed")).toHaveCount(0)
	})

	test("a failed ceremony retries the ceremony, never an empty deploy", async ({
		page,
	}) => {
		const stub = await installStub(page, { create: "error" })
		const mock = await mockClaim(page)

		await openClaim(page)
		await selectPasskey(page)
		await clickCreate(page)

		await expect(page.getByTestId("passkey-deploy-error")).toBeVisible()
		await expect(
			page.getByText(/asks your device for a passkey again/),
		).toBeVisible()
		await page.getByTestId("passkey-retry").click()

		await expect.poll(() => stub.creates()).toBe(2)
		expect(mock.deployCalls()).toHaveLength(0)
	})

	test("an unsupported browser keeps the crypto fallback", async ({ page }) => {
		await page.addInitScript(() => {
			Object.defineProperty(window, "PublicKeyCredential", {
				value: undefined,
				configurable: true,
			})
		})
		await installStub(page)
		const mock = await mockClaim(page)

		await openClaim(page)
		await selectPasskey(page)

		await expect(page.getByText(/cannot create a passkey wallet/)).toBeVisible()
		await expect(page.getByTestId("passkey-create")).toHaveCount(0)
		await expect(page.getByTestId("passkey-use-crypto")).toBeVisible()
		expect(mock.deployCalls()).toHaveLength(0)

		await page.getByTestId("passkey-use-crypto").click()
		await expect(page.getByTestId("passkey-panel")).toHaveCount(0)
		await expect(
			page.getByRole("radio", { name: /Crypto wallet/ }),
		).toBeEnabled()
	})

	test("an expired claim cannot start a passkey deploy", async ({ page }) => {
		await installStub(page)
		const mock = await mockClaim(page, ["expired"])

		await openClaim(page)
		await selectPasskey(page)
		await clickCreate(page)

		await expect(page.getByTestId("passkey-expired")).toBeVisible()
		await expect(page.getByTestId("passkey-deployed")).toHaveCount(0)
		await expect(page.getByTestId("passkey-retry")).toHaveCount(0)
		expect(mock.deployCalls()).toHaveLength(1)
	})
})
