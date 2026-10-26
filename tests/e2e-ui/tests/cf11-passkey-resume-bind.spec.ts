import { expect, test, type Page } from "@playwright/test"

// CF11: resume Bind after reload from public sessionStorage facts only.
// Fixture PASS — not a real authenticator, testnet, or API acceptance.

const CONTRACT_ID = `C${"A".repeat(55)}`
const KEY_ID = "pQ7-_credential-id_base64url=="
const PUBLIC_KEY_B64 = Buffer.from(
	Uint8Array.from({ length: 65 }, (_, i) => i + 1),
).toString("base64")
const SIGNED_TX = "AAAAAgAAAAB+standard/base64+xdr=="
const DEPLOY_HASH = "ab".repeat(32)
const CLAIM_TOKEN = "claim_token_1"
const STORAGE_PREFIX = "fp.passkey.resume.v1."

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
	storageBlocked: boolean
	resumed: boolean
	contractId: string
	keyIdBase64: string
	publicKey: string
	signedTx: string
	deployHashes: string[]
}

type StubWindow = { __passkeyResumeTest?: StubState }

const STUB_MODULE = `
const STORAGE_PREFIX = "fp.passkey.resume.v1."

async function tokenHash(token) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	)
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
}

async function storageKey(token) {
	return STORAGE_PREFIX + (await tokenHash(token))
}

export class PasskeyWalletError extends Error {
	constructor(code, message) {
		super(message)
		this.name = "PasskeyWalletError"
		this.code = code
	}
}

export const PASSKEY_RESUME_STORAGE_KEYS = [
	"v",
	"contractId",
	"keyIdBase64",
	"publicKey",
	"deployTxHash",
]

export async function createPasskeyWallet() {
	const state = window.__passkeyResumeTest
	state.creates += 1
	return {
		contractId: state.contractId,
		keyIdBase64: state.keyIdBase64,
		signedTx: state.signedTx,
	}
}

export async function confirmPasskeyCreationAuth() {
	return "idle"
}

export function abandonPasskeyCreationAuth() {}

export async function rememberPasskeyDeploy(hash, claimToken) {
	const state = window.__passkeyResumeTest
	state.deployHashes.push(hash)
	if (state.storageBlocked) return
	try {
		const key = await storageKey(claimToken)
		sessionStorage.setItem(
			key,
			JSON.stringify({
				v: 1,
				contractId: state.contractId,
				keyIdBase64: state.keyIdBase64,
				publicKey: state.publicKey,
				deployTxHash: hash,
			}),
		)
	} catch {}
}

export function releasePasskeyWalletMemory() {}

export function forgetPasskeyWallet(claimToken) {
	abandonPasskeyCreationAuth()
	if (!claimToken) return
	void storageKey(claimToken).then((key) => {
		try {
			sessionStorage.removeItem(key)
		} catch {}
	})
}

export async function clearPasskeyResumeRecord(claimToken) {
	try {
		sessionStorage.removeItem(await storageKey(claimToken))
	} catch {}
}

export async function resumePasskeyWallet(claimToken) {
	const state = window.__passkeyResumeTest
	if (state.storageBlocked) return null
	try {
		const raw = sessionStorage.getItem(await storageKey(claimToken))
		if (!raw) return null
		const parsed = JSON.parse(raw)
		state.resumed = true
		return {
			contractId: parsed.contractId,
			deployTxHash: parsed.deployTxHash,
		}
	} catch {
		return null
	}
}

export async function bindPasskeyWallet() {
	const state = window.__passkeyResumeTest
	state.binds += 1
}

export async function signPasskeyClaimAuthEntries() {
	throw new PasskeyWalletError("failed", "Signing is not part of this fixture.")
}
`

async function installStub(
	page: Page,
	overrides: Partial<StubState> = {},
): Promise<{ state: () => Promise<StubState> }> {
	const initial: StubState = {
		creates: 0,
		binds: 0,
		storageBlocked: false,
		resumed: false,
		contractId: CONTRACT_ID,
		keyIdBase64: KEY_ID,
		publicKey: PUBLIC_KEY_B64,
		signedTx: SIGNED_TX,
		deployHashes: [],
		...overrides,
	}
	await page.addInitScript((state) => {
		Object.assign(window, { __passkeyResumeTest: state })
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
					(window as unknown as StubWindow).__passkeyResumeTest as StubState,
			),
	}
}

async function mockClaim(
	page: Page,
	deploy: "ok" | "mismatch" = "ok",
): Promise<void> {
	await page.route(/\/v1\/claims\/claim_token_1$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ json: claimFixture() })
	})
	await page.route(/\/v1\/claims\/claim_token_1\/passkey\/deploy$/, (route) => {
		if (deploy === "mismatch") {
			return route.fulfill({
				status: 422,
				json: {
					code: "contract_mismatch",
					message: "claim already bound to a different passkey contractId",
				},
			})
		}
		return route.fulfill({
			json: {
				contractId: CONTRACT_ID,
				deployTxHash: DEPLOY_HASH,
				creationLedger: 1234,
				status: "deployed",
			},
		})
	})
}

const openPasskey = async (page: Page) => {
	await page.goto(`/claim/${CLAIM_TOKEN}`)
	await page.getByTestId("claim-passkey-option").getByRole("radio").check()
	await expect(page.getByTestId("passkey-panel")).toBeVisible()
}

const sessionResumeRecords = (page: Page) =>
	page.evaluate((prefix) => {
		const out: Array<{ key: string; value: Record<string, unknown> }> = []
		for (let i = 0; i < sessionStorage.length; i += 1) {
			const key = sessionStorage.key(i)
			if (!key?.startsWith(prefix)) continue
			out.push({ key, value: JSON.parse(sessionStorage.getItem(key) ?? "{}") })
		}
		return out
	}, STORAGE_PREFIX)

test.use({ viewport: { width: 390, height: 844 } })

test.describe("CF11 passkey resume Bind", () => {
	test("reload between deploy and Bind restores Bind without Create", async ({
		page,
	}) => {
		const stub = await installStub(page)
		await mockClaim(page)
		await openPasskey(page)

		await page.getByTestId("passkey-create").click()
		await expect(page.getByTestId("passkey-deployed")).toBeVisible()
		await expect(page.getByTestId("passkey-bind")).toBeEnabled()
		expect((await stub.state()).creates).toBe(1)
		expect((await stub.state()).binds).toBe(0)

		const records = await sessionResumeRecords(page)
		expect(records).toHaveLength(1)
		expect(records[0]!.key.startsWith(STORAGE_PREFIX)).toBe(true)
		expect(records[0]!.key).not.toContain(CLAIM_TOKEN)
		expect(Object.keys(records[0]!.value).sort()).toEqual(
			["contractId", "deployTxHash", "keyIdBase64", "publicKey", "v"].sort(),
		)
		expect(records[0]!.value).not.toHaveProperty("signedTx")
		expect(records[0]!.value).not.toHaveProperty("authEntries")
		expect(records[0]!.value).not.toHaveProperty("secret")
		expect(records[0]!.value).not.toHaveProperty("token")
		expect(JSON.stringify(records[0]!.value)).not.toContain(SIGNED_TX)
		expect(JSON.stringify(records[0]!.value)).not.toContain(CLAIM_TOKEN)

		await page.reload()
		await page.getByTestId("claim-passkey-option").getByRole("radio").check()
		await expect(page.getByTestId("passkey-deployed")).toBeVisible()
		await expect(page.getByTestId("passkey-bind")).toBeEnabled()
		await expect(page.getByTestId("passkey-create")).toHaveCount(0)
		expect((await stub.state()).resumed).toBe(true)
		expect((await stub.state()).creates).toBe(0)

		await page.getByTestId("passkey-bind").click()
		await expect(page.getByTestId("passkey-bound")).toBeVisible()
		expect((await stub.state()).binds).toBe(1)
		expect((await stub.state()).creates).toBe(0)
	})

	test("blocked sessionStorage still completes deploy → Bind without resume", async ({
		page,
	}) => {
		const stub = await installStub(page, { storageBlocked: true })
		await mockClaim(page)
		await openPasskey(page)

		await page.getByTestId("passkey-create").click()
		await expect(page.getByTestId("passkey-deployed")).toBeVisible()
		expect(await sessionResumeRecords(page)).toEqual([])

		await page.getByTestId("passkey-bind").click()
		await expect(page.getByTestId("passkey-bound")).toBeVisible()
		expect((await stub.state()).creates).toBe(1)
		expect((await stub.state()).binds).toBe(1)
		expect((await stub.state()).resumed).toBe(false)
	})

	test("contract_mismatch shows copy and offers no second Create", async ({
		page,
	}) => {
		const stub = await installStub(page)
		await mockClaim(page, "mismatch")
		await openPasskey(page)

		await page.getByTestId("passkey-create").click()
		await expect(page.getByTestId("passkey-contract-mismatch")).toBeVisible()
		await expect(page.getByTestId("passkey-contract-mismatch")).toContainText(
			/already has a passkey wallet/i,
		)
		await expect(page.getByTestId("passkey-create")).toHaveCount(0)
		await expect(page.getByTestId("passkey-retry")).toHaveCount(0)
		await expect(page.getByTestId("passkey-bind")).toHaveCount(0)
		await expect(page.getByTestId("passkey-use-crypto")).toBeVisible()
		expect((await stub.state()).creates).toBe(1)
	})
})
