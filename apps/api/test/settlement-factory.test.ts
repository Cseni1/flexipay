import { describe, expect, it } from "vitest";
import { createSettlement, settlementModeFromEnv } from "../src/settlement.ts";

describe("FP_SETTLEMENT factory", () => {
	it("defaults to mock", () => {
		expect(settlementModeFromEnv({})).toBe("mock");
	});

	it("creates a mock adapter without secrets", async () => {
		const { mode, adapter } = await createSettlement({
			env: { FP_SETTLEMENT: "mock", FP_VAULT_FEE_BPS: "100" },
		});
		expect(mode).toBe("mock");
		expect(adapter.network).toBe("mock");
		expect(await adapter.feeBps()).toBe(100);
	});
});
