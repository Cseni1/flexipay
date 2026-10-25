import { expect, test, type Page } from "@playwright/test"

// CF10: create vs Bind wallet split (WebAuthn binding focus). Fixture PASS is not a real
// authenticator ceremony and not M2 acceptance.

const CONTRACT_ID = `C${"A".repeat(55)}`
const KEY_ID = "pQ7-_credential-id_base64url=="
const SIGNED_TX = "AAAAAgAAAAB+standard/base64+xdr=="
const DEPLOY_HASH = "ab".repeat(32)
const CLAIM_TOKEN = "claim_token_1"
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
const UNSIGNED_ENTRY = "AAAAEAAAAAEAAAACauth-entry-fixture=="

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
	binds: number
	signs: number
	bind: "ok" | "cancel" | "error" | "hang"
	bindDelay: number
	contractId: string
	keyIdBase64: string
	signedTx: string
	deployHashes: string[]
}

type StubWindow = { __passkeyBindTest?: StubState }

const STUB_MODULE = `
export class PasskeyWalletError extends Error {
	constructor(code, message) {
		super(message)
		this.name = "PasskeyWalletError"
		this.code = code
	}
}

export async function createPasskeyWallet() {
	const state = window.__passkeyBindTest
	state.creates += 1
	return {
		contractId: state.contractId,
		keyIdBase64: state.keyIdBase64,
		signedTx: state.signedTx,
	}
}

export function rememberPasskeyDeploy(hash) {
	window.__passkeyBindTest.deployHashes.push(hash)
}

export function forgetPasskeyWallet() {}

export async function bindPasskeyWallet() {
	const state = window.__passkeyBindTest
	state.binds += 1
	if (state.bindDelay > 0)
		await new Promise((resolve) => setTimeout(resolve, state.bindDelay))
	if (state.bind === "cancel")
		throw new PasskeyWalletError("cancelled", "The bind prompt was dismissed.")
	if (state.bind === "error")
		throw new PasskeyWalletError(
			"failed",
			"The passkey wallet could not be bound on this device.",
		)
	if (state.bind === "hang") return new Promise(() => {})
}

export async function signPasskeyClaimAuthEntries({ authEntries }) {
	const state = window.__passkeyBindTest
	state.signs += 1
	return authEntries.map((entry) => "c2ln" + entry)
}
`

async function installStub(
	page: Page,
	overrides: Partial<StubState> = {},
): Promise<{ state: () => Promise<StubState> }> {
	const initial: StubState = {
		creates: 0,
		binds: 0,
		signs: 0,
		bind: "ok",
		bindDelay: 0,
		contractId: CONTRACT_ID,
		keyIdBase64: KEY_ID,
		signedTx: SIGNED_TX,
		deployHashes: [],
		...overrides,
	}
	await page.addInitScript((state) => {
		Object.assign(window, { __passkeyBindTest: state })
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
				() => (window as unknown as StubWindow).__passkeyBindTest as StubState,
			),
	}
}

async function mockClaim(page: Page): Promise<{ prepareCount: () => number }> {
	let prepares = 0
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
			prepares += 1
			await route.fulfill({
				json: {
					prepareId: "prep_bind_1",
					payoutId: "payout_1",
					networkPassphrase: NETWORK_PASSPHRASE,
					signatureExpirationLedger: 424242,
					authEntries: [UNSIGNED_ENTRY],
				},
			})
		},
	)
	await page.route(/\/v1\/claims\/claim_token_1\/passkey\/submit$/, (route) =>
		route.fulfill({
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
		}),
	)
	return { prepareCount: () => prepares }
}

const openPasskey = async (page: Page) => {
	await page.goto(`/claim/${CLAIM_TOKEN}`)
	await page.getByTestId("claim-passkey-option").getByRole("radio").check()
	await expect(page.getByTestId("passkey-panel")).toBeVisible()
}

test.use({ viewport: { width: 390, height: 844 } })

test.describe("CF10 passkey binding focus", () => {
	test("create success does not auto-bind; Bind wallet starts authentication", async ({
		page,
	}) => {
		const stub = await installStub(page)
		await mockClaim(page)
		await openPasskey(page)
		await page.getByTestId("passkey-create").click()

		await expect(page.getByTestId("passkey-deployed")).toBeVisible()
		await expect(page.getByTestId("passkey-bind")).toBeEnabled()
		await expect(page.getByTestId("passkey-bound")).toHaveCount(0)
		await expect(page.getByTestId("passkey-prepare")).toHaveCount(0)
		await expect(page.getByTestId("passkey-approve")).toHaveCount(0)
		expect((await stub.state()).creates).toBe(1)
		expect((await stub.state()).binds).toBe(0)

		await page.getByTestId("passkey-bind").click()
		await expect(page.getByTestId("passkey-bound")).toBeVisible()
		expect((await stub.state()).binds).toBe(1)
		expect((await stub.state()).creates).toBe(1)
	})

	test("bind cancel then retry reuses the credential; create stays 1", async ({
		page,
	}) => {
		const stub = await installStub(page, { bind: "cancel" })
		await mockClaim(page)
		await openPasskey(page)
		await page.getByTestId("passkey-create").click()
		await expect(page.getByTestId("passkey-bind")).toBeVisible()
		await page.getByTestId("passkey-bind").click()

		await expect(page.getByTestId("passkey-bind-error")).toContainText(
			/dismissed|same passkey/i,
		)
		expect((await stub.state()).creates).toBe(1)
		expect((await stub.state()).binds).toBe(1)

		await page.evaluate(() => {
			const state = (window as unknown as StubWindow).__passkeyBindTest
			if (state) state.bind = "ok"
		})
		await page.getByTestId("passkey-bind").click()
		await expect(page.getByTestId("passkey-bound")).toBeVisible()
		expect((await stub.state()).creates).toBe(1)
		expect((await stub.state()).binds).toBe(2)
	})

	test("bind error retry never creates a new credential", async ({ page }) => {
		const stub = await installStub(page, { bind: "error" })
		await mockClaim(page)
		await openPasskey(page)
		await page.getByTestId("passkey-create").click()
		await page.getByTestId("passkey-bind").click()
		await expect(page.getByTestId("passkey-bind-error")).toBeVisible()
		expect((await stub.state()).creates).toBe(1)

		await page.evaluate(() => {
			const state = (window as unknown as StubWindow).__passkeyBindTest
			if (state) state.bind = "ok"
		})
		await page.getByTestId("passkey-bind").click()
		await expect(page.getByTestId("passkey-bound")).toBeVisible()
		expect((await stub.state()).creates).toBe(1)
		expect((await stub.state()).binds).toBe(2)
	})

	test("double Bind click runs a single binding ceremony", async ({ page }) => {
		const stub = await installStub(page, { bindDelay: 200 })
		await mockClaim(page)
		await openPasskey(page)
		await page.getByTestId("passkey-create").click()
		await expect(page.getByTestId("passkey-bind")).toBeEnabled()

		await page.evaluate(() => {
			const button = document.querySelector<HTMLButtonElement>(
				'[data-testid="passkey-bind"]',
			)
			button?.click()
			button?.click()
		})
		await expect(page.getByTestId("passkey-bound")).toBeVisible()
		expect((await stub.state()).binds).toBe(1)
		expect((await stub.state()).creates).toBe(1)
	})

	test("claim sign stays closed until bind succeeds, then prepare/approve work", async ({
		page,
	}) => {
		const stub = await installStub(page)
		const mock = await mockClaim(page)
		await openPasskey(page)
		await page.getByTestId("passkey-create").click()
		await expect(page.getByTestId("passkey-deployed")).toBeVisible()
		await expect(page.getByTestId("passkey-prepare")).toHaveCount(0)
		await expect(page.getByTestId("passkey-approve")).toHaveCount(0)
		expect(mock.prepareCount()).toBe(0)

		await page.getByTestId("passkey-bind").click()
		await expect(page.getByTestId("passkey-bound")).toBeVisible()
		await expect(page.getByTestId("passkey-prepare")).toBeEnabled()

		await page.getByTestId("passkey-prepare").click()
		await expect(page.getByTestId("passkey-approve")).toBeEnabled()
		await page.getByTestId("passkey-approve").click()
		await expect(page.getByTestId("passkey-verified")).toBeVisible()
		expect((await stub.state()).creates).toBe(1)
		expect((await stub.state()).binds).toBe(1)
		expect((await stub.state()).signs).toBe(1)
	})

	test("390 px viewport stays inside width after bind", async ({ page }) => {
		await installStub(page)
		await mockClaim(page)
		await openPasskey(page)
		await page.getByTestId("passkey-create").click()
		await page.getByTestId("passkey-bind").click()
		await expect(page.getByTestId("passkey-bound")).toBeVisible()
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true)
	})
})
