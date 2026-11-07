import { expect, test, type Page } from "@playwright/test"

// TASK 28: Demo Day pounds → abroad (GB→KE / GB→PH). Fixture coverage with
// response shapes matching the live API (CCR-26 settle on solana_tgbp, Tazapay payout).

const TGBP_MINT = "TgbpDevMint1111111111111111111111111111111"
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
const SIGNATURE =
	"5Task28Sigaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const PAYMENT_ID = "pay_gb_abroad"

const noSideways = async (page: Page) => {
	const metrics = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}))
	expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth)
}

const corridorsFor = (toCountry: "KE" | "PH", toCurrency: "KES" | "PHP") => ({
	corridors: [
		{
			from: { country: "GB", currency: "GBP" },
			to: { country: toCountry, currency: toCurrency },
			allowedDestinationTypes: ["bank_account"],
			recipientKinds: ["individual", "company"],
			regulationNote: `Cross-border GBP to ${toCurrency}.`,
			simulated: true,
			legsAvailable: {
				collect: ["sim_bank_gb_fps"],
				convert: ["sim_fx_gbp_tgbp", "tazapay_sandbox"],
				settle: ["solana_tgbp"],
				payout: ["tazapay_sandbox"],
			},
		},
	],
})

/** Quote shape aligned with GB→abroad live quotes (settle tGBP on Solana). */
function gbpAbroadQuote(toCountry: "KE" | "PH", toCurrency: "KES" | "PHP") {
	const validUntil = new Date(Date.now() + 120_000).toISOString()
	return {
		id: "quo_gb_abroad",
		source: { type: "bank_account", currency: "GBP", country: "GB" },
		destination: {
			type: "bank_account",
			currency: toCurrency,
			country: toCountry,
			recipientKind: "individual",
		},
		amount: { side: "send", value: { amount: "10000", currency: "GBP" } },
		route: [
			{
				kind: "collect",
				rail: "sim_bank_gb_fps",
				providerId: "sim_bank_gb_fps",
				amountIn: { amount: "10000", currency: "GBP" },
				amountOut: { amount: "10000", currency: "GBP" },
				simulated: true,
			},
			{
				kind: "convert",
				rail: "sim_fx_gbp_tgbp",
				providerId: "sim_fx_gbp_tgbp",
				amountIn: { amount: "10000", currency: "GBP" },
				amountOut: { amount: "1000000000", currency: "TGBP" },
				simulated: true,
			},
			{
				kind: "settle",
				rail: "solana_tgbp",
				providerId: "solana_tgbp",
				amountIn: { amount: "1000000000", currency: "TGBP" },
				amountOut: { amount: "990000000", currency: "TGBP" },
				simulated: false,
			},
			{
				kind: "convert",
				rail: "tazapay_sandbox",
				providerId: "tazapay_sandbox",
				amountIn: { amount: "990000000", currency: "TGBP" },
				amountOut: { amount: "990000000", currency: "TGBP" },
				simulated: true,
			},
			{
				kind: "payout",
				rail: "tazapay_sandbox",
				providerId: "tazapay_sandbox",
				amountIn: { amount: "990000000", currency: "TGBP" },
				amountOut: {
					amount: toCurrency === "KES" ? "1650000" : "720000",
					currency: toCurrency,
				},
				simulated: true,
			},
		],
		fees: {
			legs: [
				{
					kind: "collect",
					rail: "sim_bank_gb_fps",
					fee: { amount: "0", currency: "GBP" },
				},
				{
					kind: "convert",
					rail: "sim_fx_gbp_tgbp",
					fee: { amount: "0", currency: "GBP" },
				},
				{
					kind: "settle",
					rail: "solana_tgbp",
					fee: { amount: "10000000", currency: "TGBP" },
				},
				{
					kind: "convert",
					rail: "tazapay_sandbox",
					fee: { amount: "0", currency: "TGBP" },
				},
				{
					kind: "payout",
					rail: "tazapay_sandbox",
					fee: { amount: "0", currency: "TGBP" },
				},
			],
			flexiPayFee: { amount: "10000000", currency: "TGBP" },
			total: { amount: "10", currency: "GBP" },
			settleUnlockedRemainder: null,
		},
		fxRate: toCurrency === "KES" ? "165.00" : "72.00",
		expectedReceive: {
			amount: toCurrency === "KES" ? "1650000" : "720000",
			currency: toCurrency,
		},
		priceRiskBearer: "sender",
		policy: "cheapest",
		feeMode: "PayerPays",
		validUntil,
		alternatives: [],
		reasons: ["cheapest_total"],
		simulated: true,
	}
}

/** Intent shape from GET /v1/payments/{id}/solana/intent (CCR-26 TGBP). */
const tgbpIntent = {
	paymentId: PAYMENT_ID,
	cluster: "devnet" as const,
	asset: "TGBP" as const,
	mint: TGBP_MINT,
	decimals: 6,
	usdcMint: TGBP_MINT,
	usdcDecimals: 6,
	// 99.00 tGBP at 6 mint decimals (settle amountOut floored from domain 7dp).
	amount: "99000000",
	recipient: "TazapayTreasury111111111111111111111111111",
	reference: "Reference11111111111111111111111111111",
	intentIssuedAt: new Date().toISOString(),
	label: "Solana TGBP (devnet)",
	explorerTxUrlTemplate:
		"https://explorer.solana.com/tx/{signature}?cluster=devnet",
}

const solanaConfig = {
	cluster: "devnet",
	assets: [
		{ asset: "USDC", mint: USDC_MINT, decimals: 6 },
		{ asset: "TGBP", mint: TGBP_MINT, decimals: 6 },
	],
	usdcMint: USDC_MINT,
	usdcDecimals: 6,
	explorerTxUrlTemplate:
		"https://explorer.solana.com/tx/{signature}?cluster=devnet",
	publicRpcUrl: null,
	label: "Solana (devnet)",
}

type Phase = "awaiting_funding" | "solana_wait" | "tazapay_wait" | "paid"

function paymentDetail(
	phase: Phase,
	toCountry: "KE" | "PH",
	toCurrency: "KES" | "PHP",
) {
	const now = new Date().toISOString()
	const receive =
		toCurrency === "KES"
			? { amount: "1650000", currency: "KES" }
			: { amount: "720000", currency: "PHP" }

	const settleStatus =
		phase === "awaiting_funding"
			? "pending"
			: phase === "solana_wait"
				? "processing"
				: "succeeded"
	const payoutStatus =
		phase === "paid"
			? "succeeded"
			: phase === "tazapay_wait"
				? "processing"
				: "pending"
	const paymentStatus =
		phase === "awaiting_funding"
			? "awaiting_funding"
			: phase === "paid"
				? "paid"
				: "processing"

	const legs = [
		{
			id: "leg_collect",
			paymentId: PAYMENT_ID,
			kind: "collect",
			rail: "sim_bank_gb_fps",
			providerId: "sim_bank_gb_fps",
			amountIn: { amount: "10000", currency: "GBP" },
			amountOut: { amount: "10000", currency: "GBP" },
			status:
				phase === "awaiting_funding" ? "pending" : ("succeeded" as const),
			attempt: 1,
			externalRef: phase === "awaiting_funding" ? null : "fps_ref_1",
			lockTxRef: null,
			releaseTxRef: null,
			error: null,
			reversalOf: null,
			simulated: true,
		},
		{
			id: "leg_fx",
			paymentId: PAYMENT_ID,
			kind: "convert",
			rail: "sim_fx_gbp_tgbp",
			providerId: "sim_fx_gbp_tgbp",
			amountIn: { amount: "10000", currency: "GBP" },
			amountOut: { amount: "1000000000", currency: "TGBP" },
			status:
				phase === "awaiting_funding" ? "pending" : ("succeeded" as const),
			attempt: 1,
			externalRef: null,
			lockTxRef: null,
			releaseTxRef: null,
			error: null,
			reversalOf: null,
			simulated: true,
		},
		{
			id: "leg_settle",
			paymentId: PAYMENT_ID,
			kind: "settle",
			rail: "solana_tgbp",
			providerId: "solana_tgbp",
			amountIn: { amount: "1000000000", currency: "TGBP" },
			amountOut: { amount: "990000000", currency: "TGBP" },
			status: settleStatus,
			attempt: 1,
			externalRef: null,
			lockTxRef: null,
			releaseTxRef:
				phase === "solana_wait" || phase === "awaiting_funding"
					? null
					: SIGNATURE,
			error: null,
			reversalOf: null,
			simulated: false,
		},
		{
			id: "leg_tazapay_convert",
			paymentId: PAYMENT_ID,
			kind: "convert",
			rail: "tazapay_sandbox",
			providerId: "tazapay_sandbox",
			amountIn: { amount: "990000000", currency: "TGBP" },
			amountOut: { amount: "990000000", currency: "TGBP" },
			status:
				phase === "paid" || phase === "tazapay_wait"
					? "succeeded"
					: "pending",
			attempt: 1,
			externalRef:
				phase === "paid" || phase === "tazapay_wait"
					? "tazapay-convert:GBP:leg_tazapay_convert:1"
					: null,
			lockTxRef: null,
			releaseTxRef: null,
			error: null,
			reversalOf: null,
			simulated: true,
		},
		{
			id: "leg_payout",
			paymentId: PAYMENT_ID,
			kind: "payout",
			rail: "tazapay_sandbox",
			providerId: "tazapay_sandbox",
			amountIn: { amount: "990000000", currency: "TGBP" },
			amountOut: receive,
			status: payoutStatus,
			attempt: 1,
			externalRef:
				phase === "tazapay_wait" || phase === "paid" ? "tazapay_po_1" : null,
			lockTxRef: null,
			releaseTxRef: null,
			error: null,
			reversalOf: null,
			simulated: true,
		},
	]

	const events = [
		{
			id: "evt_created",
			type: "payment.created",
			createdAt: now,
			paymentId: PAYMENT_ID,
			snapshot: { status: "awaiting_funding" },
		},
	]
	if (phase !== "awaiting_funding") {
		events.push(
			{
				id: "evt_funded",
				type: "payment.funded",
				createdAt: now,
				paymentId: PAYMENT_ID,
				snapshot: { status: "processing" },
			},
			{
				id: "evt_onchain",
				type: "payment.onchain",
				createdAt: now,
				paymentId: PAYMENT_ID,
				snapshot: {
					phase: "solana_settle_wait",
					legId: "leg_settle",
					detail: "awaiting_verified_solana_transfer",
				},
			},
		)
	}
	if (phase === "tazapay_wait" || phase === "paid") {
		events.push({
			id: "evt_settle_ok",
			type: "leg.succeeded",
			createdAt: now,
			paymentId: PAYMENT_ID,
			snapshot: { legId: "leg_settle" },
		})
	}
	if (phase === "paid") {
		events.push(
			{
				id: "evt_payout_ok",
				type: "leg.succeeded",
				createdAt: now,
				paymentId: PAYMENT_ID,
				snapshot: { legId: "leg_payout" },
			},
			{
				id: "evt_paid",
				type: "payment.paid",
				createdAt: now,
				paymentId: PAYMENT_ID,
				snapshot: { status: "paid" },
			},
		)
	}

	return {
		id: PAYMENT_ID,
		organizationId: "org_demo",
		quoteId: "quo_gb_abroad",
		recipientId: "rcp_abroad",
		externalId: null,
		delivery: "direct",
		profile: "one_off",
		reference: null,
		status: paymentStatus,
		batchId: null,
		legs,
		claimLink: null,
		createdAt: now,
		updatedAt: now,
		events,
	}
}

async function mockPoundsAbroadFlow(
	page: Page,
	toCountry: "KE" | "PH",
	toCurrency: "KES" | "PHP",
) {
	const state: { phase: Phase } = { phase: "awaiting_funding" }

	await page.route(/\/v1\/corridors$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ json: corridorsFor(toCountry, toCurrency) })
	})
	await page.route(/\/v1\/recipients$/, async (route) => {
		const method = route.request().method()
		if (method === "GET") {
			await route.fulfill({ json: { recipients: [] } })
			return
		}
		if (method === "POST") {
			await route.fulfill({ json: { id: "rcp_abroad" } })
			return
		}
		return route.fallback()
	})
	await page.route(/\/v1\/endpoints(\?.*)?$/, async (route) => {
		const method = route.request().method()
		if (method === "GET") {
			await route.fulfill({ json: { endpoints: [] } })
			return
		}
		if (method === "POST") {
			const body = route.request().postDataJSON() as {
				recipientId: string
				type: string
				country: string
				currency: string
				network: string | null
				details: Record<string, string>
			}
			await route.fulfill({
				status: 201,
				json: {
					id: "end_bank_abroad",
					organizationId: "org_demo",
					recipientId: body.recipientId,
					type: body.type,
					country: body.country,
					currency: body.currency,
					network: body.network,
					details: body.details,
					simulated: true,
					createdAt: new Date().toISOString(),
				},
			})
			return
		}
		return route.fallback()
	})
	await page.route(/\/v1\/quotes$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback()
		await route.fulfill({ json: gbpAbroadQuote(toCountry, toCurrency) })
	})
	await page.route(/\/v1\/payments$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback()
		const detail = paymentDetail("awaiting_funding", toCountry, toCurrency)
		const { events: _events, ...payment } = detail
		await route.fulfill({ status: 201, json: payment })
	})
	await page.route(new RegExp(`/v1/payments/${PAYMENT_ID}$`), async (route) => {
		await route.fulfill({
			json: paymentDetail(state.phase, toCountry, toCurrency),
		})
	})
	await page.route(
		new RegExp(`/v1/payments/${PAYMENT_ID}/fund$`),
		async (route) => {
			if (route.request().method() !== "POST") return route.fallback()
			state.phase = "solana_wait"
			const detail = paymentDetail("solana_wait", toCountry, toCurrency)
			const { events: _events, ...payment } = detail
			await route.fulfill({ json: payment })
		},
	)
	await page.route(/\/v1\/solana\/config$/, async (route) => {
		await route.fulfill({ json: solanaConfig })
	})
	await page.route(
		new RegExp(`/v1/payments/${PAYMENT_ID}/solana/intent$`),
		async (route) => {
			await route.fulfill({ json: tgbpIntent })
		},
	)
	await page.route(
		new RegExp(`/v1/payments/${PAYMENT_ID}/solana/confirm$`),
		async (route) => {
			if (route.request().method() !== "POST") return route.fallback()
			// Client requires paymentStatus "paid"; detail refresh then shows payout wait.
			state.phase = "tazapay_wait"
			await route.fulfill({
				json: {
					paymentId: PAYMENT_ID,
					paymentStatus: "paid",
					signature: SIGNATURE,
					explorerUrl: `https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet`,
					verifiedAt: new Date().toISOString(),
					cluster: "devnet",
				},
			})
		},
	)

	return state
}

async function fillGbBankForm(page: Page, country: "KE" | "PH") {
	await page.getByLabel("Destination country").selectOption(country)
	await page.getByLabel("Destination", { exact: true }).selectOption({
		label: "Bank account",
	})
	await page.getByLabel("Recipient kind").selectOption({ label: "Individual" })
	await page.getByLabel("Who pays the fee? (Vault fee payer)").selectOption({
		label: "I pay the fee (added on top)",
	})
	await page.getByLabel("Amount (£)").fill("100.00")
	await page.getByRole("textbox", { name: "Recipient" }).fill("Worker Abroad")
	await expect(page.getByTestId("bank-details")).toBeVisible()
	await page.getByLabel(/Account number/).fill("12345678903210")
	await page
		.getByLabel("Bank name")
		.fill(country === "KE" ? "Equity Bank" : "BDO")
	await page
		.getByLabel("SWIFT/BIC")
		.fill(country === "KE" ? "EQBLKENA" : "BNORPHMM")
}

async function walkToSolanaPanel(page: Page, country: "KE" | "PH") {
	await page.goto("/")
	await fillGbBankForm(page, country)
	await page.getByRole("button", { name: "Get quote" }).click()
	await expect(page.getByTestId("create-payment")).toBeEnabled()
	await page.getByTestId("create-payment").click()
	await expect(page).toHaveURL(new RegExp(`/payments/${PAYMENT_ID}$`))
	await page.getByTestId("fund-payment").click()
	await expect(page.getByTestId("solana-pay-panel")).toBeVisible()
	await expect(page.getByTestId("solana-pay-instruction")).toContainText(
		"Pay £99.00 tGBP from your wallet to send this payment",
	)
	await expect(page.getByTestId("solana-pay-amount")).toHaveText("£99.00")
}

async function confirmAndReachPaid(
	page: Page,
	state: { phase: Phase },
) {
	await page.getByTestId("solana-already-paid").locator("summary").click()
	await page.getByTestId("solana-manual-signature").fill(SIGNATURE)
	await page.getByTestId("solana-manual-verify").click()

	await expect(page.getByTestId("leg-waiting-payout")).toBeVisible()
	await expect(page.getByTestId("leg-waiting-payout")).toHaveText(
		"Waiting for Tazapay",
	)

	state.phase = "paid"
	await page.getByRole("button", { name: "Refresh" }).click()
	await expect(page.getByTestId("payment-paid-at")).toBeVisible()
	await expect(page.getByTestId("leg-waiting-payout")).toHaveCount(0)
}

test.describe("TASK 28 pounds to the world", () => {
	test("GB→KE bank: quote, create, fund → Solana tGBP panel → Tazapay → paid", async ({
		page,
	}) => {
		const state = await mockPoundsAbroadFlow(page, "KE", "KES")
		await walkToSolanaPanel(page, "KE")
		await confirmAndReachPaid(page, state)
	})

	test("GB→PH bank: same Solana tGBP → Waiting for Tazapay → payment-paid-at", async ({
		page,
	}) => {
		const state = await mockPoundsAbroadFlow(page, "PH", "PHP")
		await walkToSolanaPanel(page, "PH")
		await confirmAndReachPaid(page, state)
	})

	test("Where we pay lists From GBP first with a country count", async ({
		page,
	}) => {
		await page.route(/\/v1\/corridors$/, async (route) => {
			await route.fulfill({
				json: {
					corridors: [
						...corridorsFor("KE", "KES").corridors,
						...corridorsFor("PH", "PHP").corridors,
						{
							from: { country: "US", currency: "USD" },
							to: { country: "PH", currency: "PHP" },
							allowedDestinationTypes: ["bank_account"],
							recipientKinds: ["individual"],
							regulationNote: "USD to PHP.",
							simulated: true,
							legsAvailable: {
								collect: ["sim_bank_us_ach"],
								convert: ["sim_fx"],
								settle: ["stellar_usdc"],
								payout: ["tazapay_sandbox"],
							},
						},
					],
				},
			})
		})
		await page.goto("/where-we-pay")
		const priced = page.getByTestId("sandbox-priced")
		await expect(priced.getByTestId("sandbox-from-gbp")).toBeVisible()
		await expect(priced.getByTestId("sandbox-from-gbp-count")).toHaveText(
			"2 countries from GBP",
		)
		const html = await priced.innerHTML()
		expect(html.indexOf("sandbox-from-gbp")).toBeLessThan(
			html.indexOf("sandbox-from-usd"),
		)
	})

	test("390px: GB→KE Solana wait and Where we pay have no sideways scroll", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 })
		await mockPoundsAbroadFlow(page, "KE", "KES")
		await walkToSolanaPanel(page, "KE")
		await noSideways(page)

		await page.route(/\/v1\/corridors$/, async (route) => {
			await route.fulfill({ json: corridorsFor("KE", "KES") })
		})
		await page.goto("/where-we-pay")
		await expect(page.getByTestId("sandbox-from-gbp-count")).toContainText(
			"countries from GBP",
		)
		await noSideways(page)
	})
})
