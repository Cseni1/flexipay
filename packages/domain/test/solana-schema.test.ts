import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	ClaimAcceptRequestSchema,
	CreateEndpointRequestSchema,
	SolanaConfirmRequestSchema,
} from "../src/index.ts";

/** Opaque destination string — schema does not require on-curve validation. */
const SAMPLE_SOLANA_ADDRESS = "So11111111111111111111111111111111111111112";

describe("CCR-24 Solana schemas", () => {
	test("claim accept allows network solana with address", () => {
		const parsed = ClaimAcceptRequestSchema.parse({
			endpoint: {
				type: "crypto_wallet",
				country: "",
				currency: "USDC",
				network: "solana",
				details: { address: SAMPLE_SOLANA_ADDRESS },
				simulated: true,
			},
		});
		assert.equal(parsed.endpoint.network, "solana");
	});

	test("claim accept still requires stellar or solana for crypto", () => {
		assert.throws(() =>
			ClaimAcceptRequestSchema.parse({
				endpoint: {
					type: "crypto_wallet",
					country: "",
					currency: "USDC",
					network: null,
					details: { address: "GDEMO" },
					simulated: true,
				},
			}),
		);
	});

	test("create endpoint allows solana", () => {
		const parsed = CreateEndpointRequestSchema.parse({
			recipientId: "rcp_1",
			type: "crypto_wallet",
			country: "",
			currency: "USDC",
			network: "solana",
			details: { address: SAMPLE_SOLANA_ADDRESS },
			simulated: true,
		});
		assert.equal(parsed.network, "solana");
	});

	test("confirm request requires signature", () => {
		const parsed = SolanaConfirmRequestSchema.parse({
			signature: "5".repeat(64),
		});
		assert.ok(parsed.signature.length >= 32);
	});
});
