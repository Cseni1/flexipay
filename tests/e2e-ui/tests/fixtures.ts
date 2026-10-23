// A0-shaped HTTP fixtures for the browser tests. The app never falls back to these; Playwright
// intercepts the requests. This is fixture coverage, not integrated API acceptance.

const now = (offsetMs = 0): string =>
	new Date(Date.now() + offsetMs).toISOString()

export function quoteFixture(validForMs = 120_000) {
	return {
		id: "quo_1",
		source: { type: "bank_account", currency: "USD", country: "US" },
		destination: {
			type: "ewallet",
			currency: "PHP",
			country: "PH",
			recipientKind: "individual",
		},
		amount: { side: "send", value: { amount: "125000", currency: "USD" } },
		route: [
			{
				kind: "collect",
				rail: "sim_bank_us_ach",
				providerId: "sim_bank_us_ach",
				simulated: true,
			},
			{
				kind: "convert",
				rail: "sim_fx",
				providerId: "sim_fx",
				simulated: true,
			},
			{
				kind: "settle",
				rail: "stellar_usdc",
				providerId: "stellar_usdc",
				simulated: true,
			},
			{
				kind: "convert",
				rail: "sim_fx",
				providerId: "sim_fx",
				simulated: true,
			},
			{
				kind: "payout",
				rail: "sim_ewallet_ph",
				providerId: "sim_ewallet_ph",
				simulated: true,
			},
		],
		fees: {
			legs: [
				{
					kind: "collect",
					rail: "sim_bank_us_ach",
					fee: { amount: "0", currency: "USD" },
				},
				{
					kind: "convert",
					rail: "sim_fx",
					fee: { amount: "250", currency: "USD" },
				},
				{
					kind: "settle",
					rail: "stellar_usdc",
					fee: { amount: "1250", currency: "USD" },
				},
				{
					kind: "payout",
					rail: "sim_ewallet_ph",
					fee: { amount: "500", currency: "USD" },
				},
			],
			flexiPayFee: { amount: "1250", currency: "USD" },
			total: { amount: "3250", currency: "USD" },
		},
		fxRate: "55.50",
		expectedReceive: { amount: "6625000", currency: "PHP" },
		priceRiskBearer: "sender",
		policy: "cheapest",
		feeMode: "PayerPays",
		validUntil: now(validForMs),
		alternatives: [
			{
				route: [
					{
						kind: "collect",
						rail: "sim_bank_us_ach",
						providerId: "sim_bank_us_ach",
						simulated: true,
					},
					{
						kind: "convert",
						rail: "sim_fx",
						providerId: "sim_fx",
						simulated: true,
					},
					{
						kind: "settle",
						rail: "stellar_usdc",
						providerId: "stellar_usdc",
						simulated: true,
					},
					{
						kind: "convert",
						rail: "sim_fx",
						providerId: "sim_fx",
						simulated: true,
					},
					{
						kind: "payout",
						rail: "sim_bank_ph_instapay",
						providerId: "sim_bank_ph_instapay",
						simulated: true,
					},
				],
				totalCost: { amount: "4000", currency: "USD" },
				estimatedTimeSeconds: 900,
				reasons: ["Bank payout is available for this recipient kind."],
			},
		],
		reasons: [
			"E-wallet payout is available for individuals in this corridor.",
			"Crypto wallet is not the selected destination type.",
		],
		simulated: true,
	}
}

interface LegFixture {
	id: string
	kind: "collect" | "convert" | "settle" | "payout"
	rail: string
	status: "pending" | "processing" | "succeeded" | "failed"
	externalRef?: string | null
	error?: { code: string; message: string } | null
}

const leg = (input: LegFixture) => ({
	id: input.id,
	paymentId: "pay_1",
	kind: input.kind,
	rail: input.rail,
	providerId: input.rail,
	amountIn: { amount: "125000", currency: "USD" },
	amountOut: { amount: "125000", currency: "USD" },
	status: input.status,
	externalRef: input.externalRef ?? null,
	error: input.error ?? null,
	reversalOf: null,
	simulated: true,
})

const awaitingLegs = [
	leg({
		id: "leg_1",
		kind: "collect",
		rail: "sim_bank_us_ach",
		status: "pending",
	}),
	leg({ id: "leg_2", kind: "convert", rail: "sim_fx", status: "pending" }),
	leg({ id: "leg_3", kind: "settle", rail: "stellar_usdc", status: "pending" }),
	leg({ id: "leg_4", kind: "convert", rail: "sim_fx", status: "pending" }),
	leg({
		id: "leg_5",
		kind: "payout",
		rail: "sim_ewallet_ph",
		status: "pending",
	}),
]

const processingLegs = [
	leg({
		id: "leg_1",
		kind: "collect",
		rail: "sim_bank_us_ach",
		status: "succeeded",
		externalRef: "ach_ref_1",
	}),
	leg({ id: "leg_2", kind: "convert", rail: "sim_fx", status: "succeeded" }),
	leg({
		id: "leg_3",
		kind: "settle",
		rail: "stellar_usdc",
		status: "succeeded",
		externalRef:
			"a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
	}),
	leg({ id: "leg_4", kind: "convert", rail: "sim_fx", status: "succeeded" }),
	leg({
		id: "leg_5",
		kind: "payout",
		rail: "sim_ewallet_ph",
		status: "processing",
	}),
]

const failedLegs = [
	leg({
		id: "leg_1",
		kind: "collect",
		rail: "sim_bank_us_ach",
		status: "succeeded",
	}),
	leg({ id: "leg_2", kind: "convert", rail: "sim_fx", status: "succeeded" }),
	leg({
		id: "leg_3",
		kind: "settle",
		rail: "stellar_usdc",
		status: "succeeded",
	}),
	leg({ id: "leg_4", kind: "convert", rail: "sim_fx", status: "succeeded" }),
	leg({
		id: "leg_5",
		kind: "payout",
		rail: "sim_ewallet_ph",
		status: "failed",
		error: {
			code: "provider_declined",
			message: "The simulated payout was declined.",
		},
	}),
]

const basePayment = (status: string, legs: ReturnType<typeof leg>[]) => ({
	id: "pay_1",
	organizationId: "org_demo",
	quoteId: "quo_1",
	recipientId: "rcp_1",
	externalId: null,
	delivery: "direct",
	profile: "one_off",
	reference: null,
	status,
	batchId: null,
	legs,
	claimLink: null,
	createdAt: now(-30_000),
	updatedAt: now(),
})

const event = (id: string, type: string, offsetMs: number) => ({
	id,
	type,
	createdAt: now(offsetMs),
	paymentId: "pay_1",
	snapshot: { status: "pay_1" },
})

export function paymentDetailFixture(
	status: "awaiting_funding" | "processing" | "failed" = "awaiting_funding",
) {
	if (status === "failed") {
		return {
			...basePayment("failed", failedLegs),
			events: [
				event("evt_1", "payment.created", -30_000),
				event("evt_2", "payment.funded", -20_000),
				event("evt_3", "payment.processing", -15_000),
				event("evt_4", "leg.failed", -10_000),
				event("evt_5", "payment.failed", -8_000),
			],
		}
	}
	if (status === "processing") {
		return {
			...basePayment("processing", processingLegs),
			events: [
				event("evt_1", "payment.created", -30_000),
				event("evt_2", "payment.funded", -20_000),
				event("evt_3", "payment.processing", -15_000),
				event("evt_4", "leg.succeeded", -10_000),
				event("evt_5", "payment.onchain", -8_000),
			],
		}
	}
	return {
		...basePayment("awaiting_funding", awaitingLegs),
		events: [event("evt_1", "payment.created", -30_000)],
	}
}

export function paymentFromDetail(
	detail: ReturnType<typeof paymentDetailFixture>,
) {
	const { events: _events, ...payment } = detail
	return payment
}
