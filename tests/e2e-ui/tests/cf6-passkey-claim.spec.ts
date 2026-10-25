import { expect, test, type Page } from "@playwright/test"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
	canApprovePasskeyClaim,
	canRetryPasskeyStep,
	initialPasskeyFlow,
	passkeyClaimReducer,
	type PasskeyClaimFlowState,
} from "../../../apps/web/src/components/claim/passkey-claim-flow.ts"
import { SENSITIVE_MARKER } from "./passkey-sensitive-fixture.ts"

// CF6 covers the prepared passkey claim UI (M2) without a backend. Fixture PASS here is not a
// passkey run, not a testnet claim and not API acceptance: the physical passkey run is separate.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const cryptoAddress =
	"GDEMOTESTNETADDRESSONLY000000000000000000000000000000000000"

const now = (offsetMs = 0): string =>
	new Date(Date.now() + offsetMs).toISOString()

const claimFixture = (overrides: Record<string, unknown> = {}) => ({
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
	...overrides,
})

interface ClaimMockOptions {
	claim?: ReturnType<typeof claimFixture>
}

async function mockClaimApi(page: Page, options: ClaimMockOptions = {}) {
	let current = options.claim ?? claimFixture()
	const requests: { url: string; authorization?: string }[] = []

	page.on("request", (request) => {
		requests.push({
			url: request.url(),
			authorization: request.headers()["authorization"],
		})
	})

	await page.route(/\/v1\/claims\/claim_token_1$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		if (current.status === "accepted")
			current = { ...current, paymentStatus: "paid" }
		await route.fulfill({ json: current })
	})

	await page.route(/\/v1\/claims\/claim_token_1\/accept$/, async (route) => {
		current = { ...current, status: "accepted", paymentStatus: "paid" }
		await route.fulfill({
			json: {
				claim: current,
				paymentId: current.paymentId,
				paymentStatus: "paid",
			},
		})
	})

	return {
		requests: () => requests,
		passkeyRequests: () =>
			requests.filter((entry) =>
				/\/v1\/claims\/[^/]+\/passkey\//.test(entry.url),
			),
		claimRequests: () =>
			requests.filter((entry) => entry.url.includes("/v1/claims/")),
	}
}

// ---------------------------------------------------------------------------
// Flow state machine (pure): idempotency, double submit, expiry
// ---------------------------------------------------------------------------

const accepted = (): PasskeyClaimFlowState =>
	initialPasskeyFlow({ deployAvailable: true, supported: true })

const DEPLOY_HASH = "ab".repeat(32)

const toAwaitingSignature = (): PasskeyClaimFlowState => {
	let flow = accepted()
	flow = passkeyClaimReducer(flow, { type: "wallet_creation_started" })
	flow = passkeyClaimReducer(flow, {
		type: "wallet_created",
		contractId: "CFIXTUREWALLET",
		deployIdempotencyKey: "deploy-key-1",
	})
	flow = passkeyClaimReducer(flow, {
		type: "deploy_succeeded",
		deployTxHash: DEPLOY_HASH,
	})
	flow = passkeyClaimReducer(flow, { type: "prepare_started" })
	flow = passkeyClaimReducer(flow, { type: "prepared", prepareId: "prep_1" })
	return flow
}

test.describe("CF6 passkey claim flow state", () => {
	test("missing public passkey config keeps the flow unavailable", () => {
		expect(
			initialPasskeyFlow({ deployAvailable: false, supported: true }).phase,
		).toBe("unavailable")
		expect(
			initialPasskeyFlow({ deployAvailable: false, supported: false }).phase,
		).toBe("unavailable")
	})

	test("a browser without WebAuthn is unsupported, not silently available", () => {
		const flow = initialPasskeyFlow({
			deployAvailable: true,
			supported: false,
		})
		expect(flow.phase).toBe("unsupported")
		expect(flow.submitIdempotencyKey).toBeNull()
	})

	test("a submit is issued once and retried with the same idempotency key", () => {
		let flow = toAwaitingSignature()
		expect(canApprovePasskeyClaim(flow, false)).toBe(true)

		flow = passkeyClaimReducer(flow, {
			type: "signature_approved",
			submitIdempotencyKey: "submit-key-1",
		})
		expect(flow.phase).toBe("submitting")

		const afterSecondClick = passkeyClaimReducer(flow, {
			type: "signature_approved",
			submitIdempotencyKey: "submit-key-2",
		})
		expect(afterSecondClick).toBe(flow)
		expect(afterSecondClick.submitIdempotencyKey).toBe("submit-key-1")

		flow = passkeyClaimReducer(flow, {
			type: "submit_rejected",
			message: "Network error.",
			retryable: true,
		})
		expect(flow.phase).toBe("retryable_error")
		expect(canRetryPasskeyStep(flow, false)).toBe(true)

		flow = passkeyClaimReducer(flow, { type: "retry" })
		expect(flow.phase).toBe("submitting")
		expect(flow.submitIdempotencyKey).toBe("submit-key-1")
	})

	test("a deploy retry reuses the deploy idempotency key", () => {
		let flow = accepted()
		flow = passkeyClaimReducer(flow, { type: "wallet_creation_started" })
		flow = passkeyClaimReducer(flow, {
			type: "wallet_created",
			contractId: "CFIXTUREWALLET",
			deployIdempotencyKey: "deploy-key-1",
		})
		flow = passkeyClaimReducer(flow, {
			type: "deploy_failed",
			message: "deploy failed",
		})
		flow = passkeyClaimReducer(flow, { type: "retry" })
		expect(flow.phase).toBe("deploying")
		expect(flow.deployIdempotencyKey).toBe("deploy-key-1")
	})

	test("a failed wallet ceremony retries the ceremony, not an empty deploy", () => {
		let flow = accepted()
		flow = passkeyClaimReducer(flow, { type: "wallet_creation_started" })
		flow = passkeyClaimReducer(flow, {
			type: "wallet_creation_failed",
			message: "The passkey wallet could not be created on this device.",
		})
		expect(flow.phase).toBe("deploy_failed")
		expect(flow.retry).toBe("create")
		expect(flow.deployIdempotencyKey).toBeNull()

		flow = passkeyClaimReducer(flow, { type: "retry" })
		expect(flow.phase).toBe("creating_wallet")
		expect(flow.contractId).toBeNull()
		expect(flow.deployIdempotencyKey).toBeNull()
	})

	test("a non-retryable deploy rejection offers no retry button", () => {
		let flow = accepted()
		flow = passkeyClaimReducer(flow, { type: "wallet_creation_started" })
		flow = passkeyClaimReducer(flow, {
			type: "wallet_created",
			contractId: "CFIXTUREWALLET",
			deployIdempotencyKey: "deploy-key-1",
		})
		flow = passkeyClaimReducer(flow, {
			type: "deploy_failed",
			message: "rejected",
			retryable: false,
		})
		expect(flow.retry).toBeNull()
		expect(canRetryPasskeyStep(flow, false)).toBe(false)
	})

	test("expiry and cancel cannot produce a submit or a fake success", () => {
		const awaiting = toAwaitingSignature()
		const expired = passkeyClaimReducer(awaiting, { type: "expired" })
		expect(expired.phase).toBe("expired")
		expect(canApprovePasskeyClaim(expired, true)).toBe(false)
		expect(
			passkeyClaimReducer(expired, {
				type: "signature_approved",
				submitIdempotencyKey: "submit-key-1",
			}).phase,
		).toBe("expired")

		const cancelled = passkeyClaimReducer(awaiting, { type: "cancelled" })
		expect(cancelled.phase).toBe("cancelled")
		expect(cancelled.submitIdempotencyKey).toBeNull()

		const submitting = passkeyClaimReducer(awaiting, {
			type: "signature_approved",
			submitIdempotencyKey: "submit-key-1",
		})
		// Cancelling must not hide a submission that may already be in flight.
		expect(passkeyClaimReducer(submitting, { type: "cancelled" })).toBe(
			submitting,
		)
	})

	test("only an API-confirmed accepted+paid claim becomes verified", () => {
		let flow = toAwaitingSignature()
		flow = passkeyClaimReducer(flow, {
			type: "signature_approved",
			submitIdempotencyKey: "submit-key-1",
		})

		const processing = passkeyClaimReducer(flow, {
			type: "submit_accepted",
			claimStatus: "accepted",
			paymentStatus: "processing",
		})
		expect(processing.phase).toBe("processing")
		expect(processing.verified).toBeNull()

		const unconfirmed = passkeyClaimReducer(flow, {
			type: "submit_accepted",
			claimStatus: "open",
			paymentStatus: "paid",
		})
		expect(unconfirmed.phase).toBe("unconfirmed")
		expect(unconfirmed.verified).toBeNull()

		const verified = passkeyClaimReducer(flow, {
			type: "submit_accepted",
			claimStatus: "accepted",
			paymentStatus: "paid",
		})
		expect(verified.phase).toBe("verified")
		expect(verified.verified).toEqual({
			claimStatus: "accepted",
			paymentStatus: "paid",
		})
	})
})

// ---------------------------------------------------------------------------
// Claim page: the prepared options and the working crypto fallback
// ---------------------------------------------------------------------------

test.describe("CF6 claim page passkey option", () => {
	test.use({ viewport: { width: 390, height: 844 } })

	test("the passkey option opens the deploy panel and crypto still claims", async ({
		page,
	}) => {
		const consoleMessages: string[] = []
		page.on("console", (message) => consoleMessages.push(message.text()))
		const mock = await mockClaimApi(page)

		await page.goto("/claim/claim_token_1")
		await expect(
			page.getByRole("heading", { name: "Claim your payment" }),
		).toBeVisible()

		const passkeyOption = page.getByTestId("claim-passkey-option")
		await expect(passkeyOption).toBeVisible()
		await expect(
			passkeyOption.getByRole("radio", { name: /Create passkey wallet/ }),
		).toBeEnabled()
		await passkeyOption.getByRole("radio").check()
		await expect(page.getByTestId("passkey-panel")).toBeVisible()
		await expect(page.getByTestId("passkey-create")).toBeEnabled()
		await expect(page.getByTestId("passkey-signing-unavailable")).toHaveCount(0)

		const anchorOption = page.getByTestId("claim-anchor-option")
		await expect(anchorOption).toBeVisible()
		await expect(
			anchorOption.getByRole("radio", { name: /Cash out to bank/ }),
		).toBeDisabled()
		await expect(
			anchorOption.getByText(/Not available in this build/),
		).toBeVisible()

		// No invented price, hosted URL, indicative rate or anchor status.
		await expect(page.getByText(/https?:\/\//i)).toHaveCount(0)
		await expect(page.getByText(/indicative/i)).toHaveCount(0)

		// Selecting the crypto option closes the passkey panel.
		await page.getByRole("radio", { name: /Crypto wallet/ }).check()
		await expect(page.getByTestId("passkey-panel")).toHaveCount(0)

		// The G-address crypto claim still works: the passkey work is not a regression.
		await page.getByLabel("Stellar testnet wallet address").fill(cryptoAddress)
		await page.getByTestId("claim-accept").click()
		await expect(page.getByText("Claim Accepted")).toBeVisible()
		await expect(
			page.getByText(/Paid: confirmed by the claim API/),
		).toBeVisible()

		// No passkey request is attempted from the claim page, and claim calls carry no Bearer.
		expect(mock.passkeyRequests()).toEqual([])
		expect(mock.claimRequests().length).toBeGreaterThan(0)
		for (const entry of mock.claimRequests())
			expect(entry.authorization).toBeUndefined()

		const stored = await page.evaluate(() =>
			[...Object.entries(localStorage), ...Object.entries(sessionStorage)].map(
				([key, value]) => `${key}:${value}`,
			),
		)
		expect(stored.some((entry) => entry.includes("claim_token_1"))).toBe(false)
		expect(stored.join(" ")).not.toContain(SENSITIVE_MARKER)
		expect(consoleMessages.join(" ")).not.toContain("claim_token_1")
		expect(consoleMessages.join(" ")).not.toContain(SENSITIVE_MARKER)

		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true)
	})

	test("an expired claim offers no passkey action at all", async ({ page }) => {
		await mockClaimApi(page, {
			claim: claimFixture({
				status: "expired",
				paymentStatus: "expired",
				expiresAt: now(-60_000),
			}),
		})
		await page.goto("/claim/claim_token_1")
		await expect(page.getByText(/This claim link has expired/)).toBeVisible()
		await expect(page.getByTestId("claim-passkey-option")).toHaveCount(0)
		await expect(page.getByTestId("passkey-panel")).toHaveCount(0)
		await expect(page.getByTestId("claim-accept")).toHaveCount(0)
	})
})

// ---------------------------------------------------------------------------
// DEV-only state gallery: every UI state, no fake success, no sensitive data
// ---------------------------------------------------------------------------

const scenario = (page: Page, name: string) =>
	page.locator(`[data-scenario="${name}"]`)

test.describe("CF6 passkey state gallery", () => {
	test.use({ viewport: { width: 390, height: 844 } })

	test("renders every state at 390px without horizontal overflow", async ({
		page,
	}) => {
		await page.goto("/_dev/passkey-states")
		await expect(
			page.getByRole("heading", { name: "Passkey claim states" }),
		).toBeVisible()

		const phases = [
			"unavailable",
			"unsupported",
			"idle",
			"creating_wallet",
			"deploying",
			"deployed",
			"deploy_failed",
			"preparing",
			"awaiting_signature",
			"submitting",
			"processing",
			"verified",
			"unconfirmed",
			"retryable_error",
			"cancelled",
			"expired",
		]
		for (const phase of phases) {
			await expect(
				page.locator(
					`[data-scenario="${phase}"] [data-passkey-phase="${phase}"]`,
				),
			).toBeVisible()
		}

		// Live detection uses the accepted deploy contract and a WebAuthn-capable browser.
		await expect(
			scenario(page, "live-support").locator('[data-passkey-phase="idle"]'),
		).toBeVisible()

		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true)
	})

	test("an unsupported browser is explained and leaves the crypto fallback", async ({
		page,
	}) => {
		await page.addInitScript(() => {
			Object.defineProperty(window, "PublicKeyCredential", {
				value: undefined,
				configurable: true,
			})
		})
		await page.goto("/_dev/passkey-states")

		const unsupported = scenario(page, "unsupported")
		await expect(
			unsupported.locator('[data-passkey-phase="unsupported"]'),
		).toBeVisible()
		await expect(
			unsupported.getByText(/cannot create a passkey wallet/),
		).toBeVisible()
		await expect(unsupported.getByTestId("passkey-create")).toHaveCount(0)
		await expect(unsupported.getByTestId("passkey-use-crypto")).toBeVisible()

		// Live detection also reports the missing WebAuthn API as unsupported.
		await expect(
			scenario(page, "live-support").locator(
				'[data-passkey-phase="unsupported"]',
			),
		).toBeVisible()
	})

	test("cancel, deploy error, retryable error and expiry behave as labelled", async ({
		page,
	}) => {
		await page.goto("/_dev/passkey-states")

		const awaiting = scenario(page, "awaiting_signature")
		await expect(awaiting.getByTestId("passkey-approve")).toBeEnabled()
		await awaiting.getByTestId("passkey-cancel").click()
		await expect(
			scenario(page, "awaiting_signature").getByTestId("passkey-cancelled"),
		).toBeVisible()
		await expect(
			scenario(page, "awaiting_signature").getByTestId("passkey-approve"),
		).toHaveCount(0)

		await expect(
			scenario(page, "deploy_failed").getByTestId("passkey-deploy-error"),
		).toBeVisible()
		await expect(
			scenario(page, "deploy_failed").getByTestId("passkey-retry"),
		).toBeEnabled()
		await expect(
			scenario(page, "deploy_failed").getByText(/same idempotency key/),
		).toBeVisible()

		await expect(
			scenario(page, "retryable_error").getByTestId("passkey-error"),
		).toBeVisible()
		await expect(
			scenario(page, "retryable_error").getByTestId("passkey-retry"),
		).toBeEnabled()

		// Approval is refused while the claim is not in an acceptable state.
		await expect(
			scenario(page, "awaiting_signature_closed").getByTestId(
				"passkey-approve",
			),
		).toBeDisabled()

		const expiredWhileSigning = scenario(page, "awaiting_signature_expired")
		await expect(
			expiredWhileSigning.getByTestId("passkey-expired"),
		).toBeVisible()
		await expect(
			expiredWhileSigning.getByTestId("passkey-approve"),
		).toBeDisabled()

		const expiredTerminal = scenario(page, "expired")
		await expect(expiredTerminal.getByTestId("passkey-expired")).toBeVisible()
		await expect(expiredTerminal.getByTestId("passkey-approve")).toHaveCount(0)
	})

	test("the submitting state cannot be submitted twice", async ({ page }) => {
		await page.goto("/_dev/passkey-states")

		const awaiting = scenario(page, "awaiting_signature")
		const approve = awaiting.getByTestId("passkey-approve")
		await approve.click()
		await expect(
			scenario(page, "awaiting_signature").locator(
				'[data-passkey-phase="submitting"]',
			),
		).toBeVisible()
		await expect(approve).toHaveCount(0)
		await expect(
			scenario(page, "awaiting_signature").getByTestId("passkey-submitting"),
		).toBeDisabled()

		const staticSubmitting = scenario(page, "submitting")
		await expect(
			staticSubmitting.getByTestId("passkey-submitting"),
		).toBeDisabled()
		await expect(staticSubmitting.getByTestId("passkey-approve")).toHaveCount(0)
		await expect(staticSubmitting.getByTestId("passkey-cancel")).toHaveCount(0)
	})

	test("only the API-confirmed scenario is shown as paid; nothing is faked", async ({
		page,
	}) => {
		await page.goto("/_dev/passkey-states")

		const verified = scenario(page, "verified")
		await expect(verified.getByTestId("passkey-verified")).toBeVisible()
		await expect(verified.getByText(/Confirmed by the claim API/)).toBeVisible()
		await expect(verified.locator('[data-status="paid"]')).toBeVisible()

		for (const name of [
			"unavailable",
			"unsupported",
			"idle",
			"creating_wallet",
			"deploying",
			"deployed",
			"deploy_failed",
			"preparing",
			"awaiting_signature",
			"submitting",
			"processing",
			"unconfirmed",
			"retryable_error",
		]) {
			const text = (await scenario(page, name).innerText()).replace(/\s+/g, " ")
			expect(text, `scenario ${name} must not claim success`).not.toMatch(
				/\bPaid\b|\bCompleted\b/,
			)
		}
	})

	test("no secret payload, claim token or Authorization header leaks into the page", async ({
		page,
	}) => {
		const consoleMessages: string[] = []
		page.on("console", (message) => consoleMessages.push(message.text()))
		await page.goto("/_dev/passkey-states")
		await page.waitForTimeout(300)

		const stored = await page.evaluate(() =>
			[...Object.entries(localStorage), ...Object.entries(sessionStorage)].map(
				([key, value]) => `${key}:${value}`,
			),
		)
		const html = await page.content()
		expect(stored.join(" ")).not.toContain(SENSITIVE_MARKER)
		expect(consoleMessages.join(" ")).not.toContain(SENSITIVE_MARKER)
		expect(html).not.toContain(SENSITIVE_MARKER)
		expect(html).not.toMatch(/signedAuthEntries|signedTx|keyIdBase64/)
	})
})

// ---------------------------------------------------------------------------
// Source guards: one SDK boundary, deploy only, no secrets in logs or storage
// ---------------------------------------------------------------------------

const readTree = async (
	root: string,
): Promise<{ path: string; text: string }[]> => {
	const out: { path: string; text: string }[] = []
	const walk = async (directory: string) => {
		const entries = await readdir(directory, { withFileTypes: true })
		for (const entry of entries) {
			const full = join(directory, entry.name)
			if (entry.isDirectory()) {
				if (entry.name === "node_modules") continue
				await walk(full)
				continue
			}
			if (!/\.(ts|tsx|css|json|html)$/.test(entry.name)) continue
			out.push({ path: full, text: await readFile(full, "utf8") })
		}
	}
	await walk(root)
	return out
}

test.describe("CF6 passkey source guards", () => {
	test("one passkey-kit boundary, deploy only, no test hook in production code", async () => {
		const files = [
			...(await readTree(join(repoRoot, "apps/web/src"))),
			...(await readTree(join(repoRoot, "packages/web-lib"))),
		]
		expect(files.length).toBeGreaterThan(10)

		for (const file of files) {
			// The prepare/submit routes are not wired: their payloads can carry the claim secret.
			expect(
				file.text,
				`${file.path} must not call prepare/submit`,
			).not.toMatch(/passkey\/(prepare|submit)/i)
			expect(file.text, `${file.path} must not build auth entries`).not.toMatch(
				/signedAuthEntries/,
			)
			expect(
				file.text,
				`${file.path} must not set an Authorization header`,
			).not.toMatch(/Authorization\s*:|headers\.set\(\s*["']authorization/i)
			// A test/fixture override must never ship inside the app.
			expect(file.text, `${file.path} must not expose a test hook`).not.toMatch(
				/__passkeyTest|window\.__/,
			)
			expect(
				file.text,
				`${file.path} must not carry a Stellar secret`,
			).not.toMatch(/\bS[A-Z2-7]{55}\b|FP_[A-Z_]*SECRET/)
		}

		const sdkImporters = files
			.filter((file) => /import\(\s*["']passkey-kit["']\s*\)/.test(file.text))
			.map((file) => file.path)
		expect(sdkImporters).toEqual([
			join(repoRoot, "apps/web/src/api/passkeyWallet.ts"),
		])
		// No static SDK import: the wallet kit is a lazy chunk, not part of the page entry.
		expect(
			files.filter((file) => /from\s+["']passkey-kit["']/.test(file.text)),
		).toEqual([])

		const deployRoutes = files
			.filter((file) => /passkey\/deploy/.test(file.text))
			.map((file) => file.path)
		expect(deployRoutes).toContain(
			join(repoRoot, "apps/web/src/api/claimClient.ts"),
		)
	})

	test("the web-lib re-exports the accepted shared schemas instead of copying them", async () => {
		const contract = await readFile(
			join(repoRoot, "packages/web-lib/claim-contract.ts"),
			"utf8",
		)
		expect(contract).toContain("../domain/src/api/claims.ts")
		expect(contract).toContain("PasskeyDeployRequestSchema")
		expect(contract).not.toMatch(/z\.object\(\{[^}]*keyIdBase64/s)
	})

	test("claim UI files never log or store the passkey payload", async () => {
		const claimFiles = [
			"apps/web/src/api/claimClient.ts",
			"apps/web/src/api/passkeyWallet.ts",
			"apps/web/src/pages/ClaimPage.tsx",
			"apps/web/src/components/claim/PasskeyClaimPanel.tsx",
			"apps/web/src/components/claim/PasskeyClaimSection.tsx",
			"apps/web/src/components/claim/passkey-claim-flow.ts",
			"apps/web/src/components/claim/usePasskeyClaim.ts",
			"packages/web-lib/passkey-config.ts",
		]
		for (const relative of claimFiles) {
			const text = await readFile(join(repoRoot, relative), "utf8")
			expect(text, `${relative} must not log`).not.toMatch(/console\./)
			expect(text, `${relative} must not use browser storage`).not.toMatch(
				/localStorage|sessionStorage|indexedDB/,
			)
			expect(text, `${relative} must not send analytics`).not.toMatch(
				/analytics|posthog|segment|gtag/i,
			)
		}
	})
})
