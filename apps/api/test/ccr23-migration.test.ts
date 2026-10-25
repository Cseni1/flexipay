import pg from "pg";
import { describe, expect, it } from "vitest";
import { migrateDeploy, startEmbeddedDb } from "../src/dev/embedded-db.ts";

describe("CCR-23 migration (embedded Postgres)", () => {
	it("adds nullable fund columns, partial unique index, and does not invent confirmed deposits", async () => {
		const embedded = await startEmbeddedDb();
		try {
			await migrateDeploy(embedded.url);
			const client = new pg.Client({ connectionString: embedded.url });
			await client.connect();
			try {
				const cols = await client.query<{ column_name: string }>(
					`SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'Leg'
             AND column_name LIKE 'fund%'
           ORDER BY column_name`,
				);
				expect(cols.rows.map((c) => c.column_name)).toEqual([
					"fundAmountCurrency",
					"fundAmountValue",
					"fundNetwork",
					"fundOpIndex",
					"fundTxRef",
					"fundVaultId",
				]);

				const idx = await client.query<{ indexdef: string }>(
					`SELECT indexdef FROM pg_indexes
           WHERE schemaname = 'public' AND indexname = 'Leg_fund_deposit_identity_key'`,
				);
				expect(idx.rows).toHaveLength(1);
				expect(idx.rows[0]!.indexdef).toMatch(/WHERE.*"fundTxRef" IS NOT NULL/i);

				// Existing/unknown rows stay unconfirmed: many null fundTxRef legs are allowed.
				await client.query(
					`INSERT INTO "Organization" (id, name, kind) VALUES ('org_ccr23', 'Demo', 'business')`,
				);
				await client.query(
					`INSERT INTO "Recipient" (id, "organizationId", name, kind, country)
           VALUES ('rcp_ccr23', 'org_ccr23', 'Worker A', 'individual', 'US')`,
				);
				await client.query(
					`INSERT INTO "Quote" (
            id, "organizationId", source, destination, "amountSide", "amountValue", "amountCurrency",
            route, fees, "expectedReceive", "receiveCurrency", "priceRiskBearer", "validUntil",
            alternatives, reasons
          ) VALUES (
            'qte_ccr23', 'org_ccr23', '{}', '{}', 'send', '1', 'USD',
            '[]', '{}', '1', 'USDC', 'sender', NOW() + interval '1 hour',
            '[]', '[]'
          )`,
				);
				await client.query(
					`INSERT INTO "Payment" (
            id, "organizationId", "quoteId", "recipientId", delivery, profile, status, "lockAttempt",
            "createdAt", "updatedAt"
          ) VALUES (
            'pay_ccr23_a', 'org_ccr23', 'qte_ccr23', 'rcp_ccr23', 'direct', 'one_off', 'processing', 0,
            NOW(), NOW()
          ), (
            'pay_ccr23_b', 'org_ccr23', 'qte_ccr23', 'rcp_ccr23', 'direct', 'one_off', 'processing', 0,
            NOW(), NOW()
          )`,
				);
				await client.query(
					`INSERT INTO "Leg" (
            id, "paymentId", position, kind, rail, "providerId",
            "amountInValue", "amountInCurrency", "amountOutValue", "amountOutCurrency", status,
            "createdAt", "updatedAt"
          ) VALUES (
            'leg_a', 'pay_ccr23_a', 0, 'settle', 'stellar_usdc', 'stellar',
            '100', 'USDC', '99', 'USDC', 'processing', NOW(), NOW()
          ), (
            'leg_b', 'pay_ccr23_b', 0, 'settle', 'stellar_usdc', 'stellar',
            '100', 'USDC', '99', 'USDC', 'processing', NOW(), NOW()
          )`,
				);
				const nulls = await client.query<{ c: string }>(
					`SELECT COUNT(*)::text AS c FROM "Leg" WHERE "fundTxRef" IS NULL`,
				);
				expect(nulls.rows[0]!.c).toBe("2");

				await client.query(
					`UPDATE "Leg" SET
            "fundTxRef" = 'tx1', "fundOpIndex" = 0, "fundAmountValue" = '100',
            "fundAmountCurrency" = 'USDC', "fundNetwork" = 'mock', "fundVaultId" = 'vault'
           WHERE id = 'leg_a'`,
				);
				await expect(
					client.query(
						`UPDATE "Leg" SET
              "fundTxRef" = 'tx1', "fundOpIndex" = 0, "fundAmountValue" = '100',
              "fundAmountCurrency" = 'USDC', "fundNetwork" = 'mock', "fundVaultId" = 'vault'
             WHERE id = 'leg_b'`,
					),
				).rejects.toThrow(/Leg_fund_deposit_identity_key|duplicate key/i);
			} finally {
				await client.end();
			}
		} finally {
			await embedded.stop();
		}
	}, 120_000);
});
