/**
 * Lane B migration verification against disposable embedded Postgres only.
 * Never points at Neon / production / shared databases.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { Client } from "pg";
import {
	migrateDeploy,
	prisma,
	startEmbeddedDb,
} from "../src/dev/embedded-db.ts";

describe("Lane B migration (local embedded Postgres only)", () => {
	test("applies forward; unique releaseTxRef; ClaimLink columns nullable for existing rows", async () => {
		const pg = await startEmbeddedDb();
		const client = new Client({ connectionString: pg.url });
		try {
			await client.connect();

			// Deploy full chain including Lane B migration.
			const out = await migrateDeploy(pg.url);
			assert.match(out, /lane_b_solana_security|Applied|already|No pending/i);

			const cols = await client.query<{ column_name: string; is_nullable: string }>(
				`SELECT column_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'ClaimLink'
           AND column_name IN ('acceptedEndpointId','solanaPayReference','solanaIntentAt')
         ORDER BY column_name`,
			);
			assert.equal(cols.rowCount, 3);
			for (const row of cols.rows) {
				assert.equal(row.is_nullable, "YES", `${row.column_name} must be nullable`);
			}

			const idx = await client.query<{ indexname: string }>(
				`SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = 'Leg_releaseTxRef_key'`,
			);
			assert.equal(idx.rowCount, 1);

			// Existing-data compatibility: ClaimLink without Solana fields still inserts.
			await client.query(`INSERT INTO "Organization" (id, name, kind) VALUES ('org_m1','M','business')`);
			await client.query(
				`INSERT INTO "Recipient" (id, "organizationId", name, kind, country)
         VALUES ('rcp_m1','org_m1','R','individual','PH')`,
			);
			await client.query(
				`INSERT INTO "Quote" (
           id, "organizationId", source, destination, "amountSide", "amountValue",
           "amountCurrency", route, fees, "expectedReceive", "receiveCurrency",
           "priceRiskBearer", "validUntil", alternatives, reasons
         ) VALUES (
           'quo_m1','org_m1','{}','{}','receive','1','USDC','[]','{}','1','USDC',
           'payer','2099-01-01','[]','[]'
         )`,
			);
			await client.query(
				`INSERT INTO "Payment" (
           id, "organizationId", "quoteId", "recipientId", delivery, profile, status, "updatedAt"
         ) VALUES (
           'pay_m1','org_m1','quo_m1','rcp_m1','claim_link','one_off','processing', NOW()
         )`,
			);
			await client.query(
				`INSERT INTO "ClaimLink" ("paymentId", "tokenHash", "expiresAt", status)
         VALUES ('pay_m1','tok_m1','2099-01-01','open')`,
			);

			await client.query(
				`INSERT INTO "Leg" (
           id, "paymentId", position, kind, rail, "providerId",
           "amountInValue", "amountInCurrency", "amountOutValue", "amountOutCurrency",
           status, "releaseTxRef", "updatedAt"
         ) VALUES (
           'leg_m1','pay_m1',0,'settle','solana_usdc','solana_usdc',
           '1','USDC','1','USDC','succeeded','sig-unique-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', NOW()
         )`,
			);

			await client.query(
				`INSERT INTO "Payment" (
           id, "organizationId", "quoteId", "recipientId", delivery, profile, status, "updatedAt"
         ) VALUES (
           'pay_m2','org_m1','quo_m1','rcp_m1','claim_link','one_off','processing', NOW()
         )`,
			);

			let rejected = false;
			try {
				await client.query(
					`INSERT INTO "Leg" (
             id, "paymentId", position, kind, rail, "providerId",
             "amountInValue", "amountInCurrency", "amountOutValue", "amountOutCurrency",
             status, "releaseTxRef", "updatedAt"
           ) VALUES (
             'leg_m2','pay_m2',0,'settle','solana_usdc','solana_usdc',
             '1','USDC','1','USDC','succeeded','sig-unique-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', NOW()
           )`,
				);
			} catch (cause) {
				rejected = true;
				const msg = cause instanceof Error ? cause.message : String(cause);
				assert.match(msg, /Leg_releaseTxRef_key|unique/i);
			}
			assert.equal(rejected, true, "duplicate releaseTxRef must violate unique index");

			// Rollback/recovery risk: Prisma ships no down migration for this folder.
			const migrations = await prisma(pg.url, "migrate", "status");
			assert.match(migrations, /Database schema is up to date|lane_b_solana_security/i);
		} finally {
			await client.end().catch(() => {});
			await pg.stop();
		}
	}, 120_000);
});
