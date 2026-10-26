import { expect, test, type Page } from "@playwright/test"

// CF10: create Confirm vs Bind wallet as separate steps. Wrapper-control proof lives in
// cf10-passkey-webauthn-gate.spec.ts. Fixture PASS here is not a real authenticator ceremony.

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
	confirms: number
	binds: number
	signs: number
	confirm: "ok" | "cancel" | "error"
	bind: "ok" | "cancel" | "error" | "hang"
	/** When set, Bind fails at this kit step with a diagnostic. */
	bindFailStep: null | "confirmWalletCreation" | "connectWallet"
	bindDelay: number
	confirmDelay: number
	contractId: string
	keyIdBase64: string
	signedTx: string
	deployHashes: string[]
	createContinue: null | (() => void)
	createReject: null | ((err: Error) => void)
}

type StubWindow = { __passkeyBindTest?: StubState }

const STUB_MODULE = `
export class PasskeyWalletError extends Error {
	constructor(code, message, options = {}) {
		super(message)
		this.name = "PasskeyWalletError"
		this.code = code
		if (options.bindDiagnostic) this.bindDiagnostic = options.bindDiagnostic
	}
}

export async function createPasskeyWallet(hooks = {}) {
	const state = window.__passkeyBindTest
	state.creates += 1
	hooks.onAwaitingCreationConfirm?.()
	await new Promise((resolve, reject) => {
		state.createContinue = () => resolve()
		state.createReject = (err) => reject(err)
	})
	return {
		contractId: state.contractId,
		keyIdBase64: state.keyIdBase64,
		signedTx: state.signedTx,
	}
}

export async function confirmPasskeyCreationAuth() {
	const state = window.__passkeyBindTest
	state.confirms += 1
	if (state.confirmDelay > 0)
		await new Promise((resolve) => setTimeout(resolve, state.confirmDelay))
	if (state.confirm === "cancel") return "dismissed"
	if (state.confirm === "error") return "failed"
	state.createContinue?.()
	state.createContinue = null
	return "completed"
}

export function abandonPasskeyCreationAuth() {
	const state = window.__passkeyBindTest
	if (state?.createReject) {
		const err = new Error("cancelled")
		err.name = "NotAllowedError"
		state.createReject(err)
		state.createContinue = null
		state.createReject = null
	}
}

export function rememberPasskeyDeploy(hash) {
	window.__passkeyBindTest.deployHashes.push(hash)
}

export function forgetPasskeyWallet() {
	abandonPasskeyCreationAuth()
}

export function releasePasskeyWalletMemory() {
	abandonPasskeyCreationAuth()
}

export async function clearPasskeyResumeRecord() {}

export async function resumePasskeyWallet() {
	return null
}

export async function bindPasskeyWallet() {
	const state = window.__passkeyBindTest
	state.binds += 1
	if (state.bindDelay > 0)
		await new Promise((resolve) => setTimeout(resolve, state.bindDelay))
	if (state.bind === "cancel")
		throw new PasskeyWalletError("cancelled", "The bind prompt was dismissed.")
	if (state.bindFailStep === "confirmWalletCreation") {
		const diagnostic = {
			step: "confirmWalletCreation",
			errorName: "WalletOwnershipError",
			errorCode: 601,
			reason: "birth_mismatch",
			detail: "birth wasm mismatch",
			causeName: "DOMException",
			causeMessage: "The operation is insecure.",
			hostname: window.location.hostname,
			rpId: window.location.hostname,
			allowedOrigins: [window.location.origin],
			contractId: state.contractId,
		}
		console.warn("[passkey-bind]", diagnostic)
		throw new PasskeyWalletError(
			"failed",
			"The passkey wallet could not be bound on this device.",
			{ bindDiagnostic: diagnostic },
		)
	}
	if (state.bindFailStep === "connectWallet") {
		const diagnostic = {
			step: "connectWallet",
			errorName: "WalletOwnershipError",
			errorCode: 602,
			reason: "signer_missing",
			detail: "passkey not a live signer",
			causeName: "NotAllowedError",
			causeMessage: "The request is not allowed.",
			hostname: window.location.hostname,
			rpId: window.location.hostname,
			allowedOrigins: [window.location.origin],
			contractId: state.contractId,
		}
		console.warn("[passkey-bind]", diagnostic)
		throw new PasskeyWalletError(
			"failed",
			"The passkey wallet could not be bound on this device.",
			{ bindDiagnostic: diagnostic },
		)
	}
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
		confirms: 0,
		binds: 0,
		signs: 0,
		confirm: "ok",
		bind: "ok",
		bindFailStep: null,
		bindDelay: 0,
		confirmDelay: 0,
		contractId: CONTRACT_ID,
		keyIdBase64: KEY_ID,
		signedTx: SIGNED_TX,
		deployHashes: [],
		createContinue: null,
		createReject: null,
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

const createAndConfirm = async (page: Page) => {
	await page.getByTestId("passkey-create").click()
	await expect(page.getByTestId("passkey-confirm-creation")).toBeVisible()
	await expect(page.getByTestId("passkey-bind")).toHaveCount(0)
	await page.getByTestId("passkey-confirm-creation").click()
	await expect(page.getByTestId("passkey-deployed")).toBeVisible()
	await expect(page.getByTestId("passkey-bind")).toBeEnabled()
}

test.use({ viewport: { width: 390, height: 844 } })

test.describe("CF10 passkey binding focus", () => {
	test("create parks for Confirm; Confirm then Bind are separate steps", async ({
		page,
	}) => {
		const stub = await installStub(page)
		await mockClaim(page)
		await openPasskey(page)
		await page.getByTestId("passkey-create").click()

		await expect(page.getByTestId("passkey-creation-confirm-needed")).toBeVisible()
		await expect(page.getByTestId("passkey-confirm-creation")).toBeEnabled()
		await expect(page.getByTestId("passkey-deployed")).toHaveCount(0)
		await expect(page.getByTestId("passkey-bind")).toHaveCount(0)
		expect((await stub.state()).creates).toBe(1)
		expect((await stub.state()).confirms).toBe(0)
		expect((await stub.state()).binds).toBe(0)

		await page.getByTestId("passkey-confirm-creation").click()
		await expect(page.getByTestId("passkey-deployed")).toBeVisible()
		await expect(page.getByTestId("passkey-bind")).toBeEnabled()
		expect((await stub.state()).confirms).toBe(1)
		expect((await stub.state()).creates).toBe(1)
		expect((await stub.state()).binds).toBe(0)

		await page.getByTestId("passkey-bind").click()
		await expect(page.getByTestId("passkey-bound")).toBeVisible()
		expect((await stub.state()).binds).toBe(1)
		expect((await stub.state()).creates).toBe(1)
		expect((await stub.state()).confirms).toBe(1)
	})

	test("Confirm dismiss then retry continues the same create (creates stay 1)", async ({
		page,
	}) => {
		const stub = await installStub(page, { confirm: "cancel" })
		await mockClaim(page)
		await openPasskey(page)
		await page.getByTestId("passkey-create").click()
		await page.getByTestId("passkey-confirm-creation").click()
		await expect(page.getByTestId("passkey-creation-confirm-note")).toContainText(
			/same passkey|dismissed/i,
		)
		expect((await stub.state()).creates).toBe(1)
		expect((await stub.state()).confirms).toBe(1)

		await page.evaluate(() => {
			const state = (window as unknown as StubWindow).__passkeyBindTest
			if (state) state.confirm = "ok"
		})
		await page.getByTestId("passkey-confirm-creation").click()
		await expect(page.getByTestId("passkey-deployed")).toBeVisible()
		expect((await stub.state()).creates).toBe(1)
		expect((await stub.state()).confirms).toBe(2)
	})

	test("Confirm get-error retry never starts a second create", async ({
		page,
	}) => {
		const stub = await installStub(page, { confirm: "error" })
		await mockClaim(page)
		await openPasskey(page)
		await page.getByTestId("passkey-create").click()
		await page.getByTestId("passkey-confirm-creation").click()
		await expect(page.getByTestId("passkey-creation-confirm-note")).toContainText(
			/retry/i,
		)
		expect((await stub.state()).creates).toBe(1)

		await page.evaluate(() => {
			const state = (window as unknown as StubWindow).__passkeyBindTest
			if (state) state.confirm = "ok"
		})
		await page.getByTestId("passkey-confirm-creation").click()
		await expect(page.getByTestId("passkey-deployed")).toBeVisible()
		expect((await stub.state()).creates).toBe(1)
		expect((await stub.state()).confirms).toBe(2)
	})

	test("double Confirm click runs a single confirmation", async ({ page }) => {
		const stub = await installStub(page, { confirmDelay: 200 })
		await mockClaim(page)
		await openPasskey(page)
		await page.getByTestId("passkey-create").click()
		await expect(page.getByTestId("passkey-confirm-creation")).toBeEnabled()

		await page.evaluate(() => {
			const button = document.querySelector<HTMLButtonElement>(
				'[data-testid="passkey-confirm-creation"]',
			)
			button?.click()
			button?.click()
		})
		await expect(page.getByTestId("passkey-deployed")).toBeVisible()
		expect((await stub.state()).confirms).toBe(1)
		expect((await stub.state()).creates).toBe(1)
	})

	test("double Bind click runs a single binding ceremony", async ({ page }) => {
		const stub = await installStub(page, { bindDelay: 200 })
		await mockClaim(page)
		await openPasskey(page)
		await createAndConfirm(page)

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

	test("claim sign stays closed until bind succeeds after Confirm", async ({
		page,
	}) => {
		const stub = await installStub(page)
		const mock = await mockClaim(page)
		await openPasskey(page)
		await createAndConfirm(page)
		await expect(page.getByTestId("passkey-prepare")).toHaveCount(0)
		expect(mock.prepareCount()).toBe(0)

		await page.getByTestId("passkey-bind").click()
		await expect(page.getByTestId("passkey-bound")).toBeVisible()
		await page.getByTestId("passkey-prepare").click()
		await expect(page.getByTestId("passkey-approve")).toBeEnabled()
		await page.getByTestId("passkey-approve").click()
		await expect(page.getByTestId("passkey-verified")).toBeVisible()
		expect((await stub.state()).creates).toBe(1)
		expect((await stub.state()).confirms).toBe(1)
		expect((await stub.state()).binds).toBe(1)
		expect((await stub.state()).signs).toBe(1)
	})

	test("390 px viewport stays inside width after Confirm and Bind", async ({
		page,
	}) => {
		await installStub(page)
		await mockClaim(page)
		await openPasskey(page)
		await createAndConfirm(page)
		await page.getByTestId("passkey-bind").click()
		await expect(page.getByTestId("passkey-bound")).toBeVisible()
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true)
	})

	test("confirmWalletCreation failure shows step diagnostic under generic headline", async ({
		page,
	}) => {
		const warnings: string[] = []
		page.on("console", (message) => {
			if (message.type() === "warning") warnings.push(message.text())
		})
		await installStub(page, { bindFailStep: "confirmWalletCreation" })
		await mockClaim(page)
		await openPasskey(page)
		await createAndConfirm(page)
		await page.getByTestId("passkey-bind").click()

		await expect(page.getByTestId("passkey-bind-error")).toContainText(
			/could not be bound/i,
		)
		const diagnostic = page.getByTestId("passkey-bind-diagnostic")
		await expect(diagnostic).toContainText("confirmWalletCreation")
		await expect(diagnostic).toContainText("WalletOwnershipError")
		await expect(diagnostic).toContainText("601")
		await expect(diagnostic).toContainText("birth_mismatch")
		await expect(diagnostic).toContainText("DOMException")
		await expect(diagnostic).toContainText("host localhost")
		await expect(diagnostic).toContainText("rpId localhost")
		await expect(diagnostic).not.toContainText(SIGNED_TX)
		await expect(diagnostic).not.toContainText(DEPLOY_HASH)
		await expect(page.getByTestId("passkey-bind")).toBeEnabled()
		expect(warnings.some((line) => /\[passkey-bind\]/.test(line))).toBe(true)
	})

	test("connectWallet failure shows step diagnostic under generic headline", async ({
		page,
	}) => {
		const warnings: string[] = []
		page.on("console", (message) => {
			if (message.type() === "warning") warnings.push(message.text())
		})
		await installStub(page, { bindFailStep: "connectWallet" })
		await mockClaim(page)
		await openPasskey(page)
		await createAndConfirm(page)
		await page.getByTestId("passkey-bind").click()

		await expect(page.getByTestId("passkey-bind-error")).toContainText(
			/could not be bound/i,
		)
		const diagnostic = page.getByTestId("passkey-bind-diagnostic")
		await expect(diagnostic).toContainText("connectWallet")
		await expect(diagnostic).toContainText("WalletOwnershipError")
		await expect(diagnostic).toContainText("602")
		await expect(diagnostic).toContainText("signer_missing")
		await expect(diagnostic).toContainText("NotAllowedError")
		await expect(diagnostic).toContainText("host localhost")
		await expect(diagnostic).toContainText("rpId localhost")
		await expect(diagnostic).not.toContainText(SIGNED_TX)
		await expect(diagnostic).not.toContainText(DEPLOY_HASH)
		await expect(page.getByTestId("passkey-bind")).toBeEnabled()
		expect(warnings.some((line) => /\[passkey-bind\]/.test(line))).toBe(true)
	})
})
