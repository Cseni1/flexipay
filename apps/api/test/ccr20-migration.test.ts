import pg from "pg";
import { describe, expect, it } from "vitest";
import { migrateDeploy, startEmbeddedDb } from "../src/dev/embedded-db.ts";

/**
 * Disposable embedded Postgres only (no Docker, no shared DB).
 * Uses `pg` directly so migrate proof does not depend on a generated Prisma client.
 */
describe("CCR-21 migration (embedded Postgres)", () => {
	it("applies PasskeyClaimPrepare + ClaimLink passkey columns", async () => {
		const embedded = await startEmbeddedDb();
		try {
			await migrateDeploy(embedded.url);
			const client = new pg.Client({ connectionString: embedded.url });
			await client.connect();
			try {
				const tables = await client.query<{ table_name: string }>(
					`SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'PasskeyClaimPrepare'`,
				);
				expect(tables.rows.map((r) => r.table_name)).toEqual([
					"PasskeyClaimPrepare",
				]);

				const cols = await client.query<{ column_name: string }>(
					`SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'ClaimLink'
             AND column_name LIKE 'passkey%'
           ORDER BY column_name`,
				);
				expect(cols.rows.map((c) => c.column_name)).toEqual([
					"passkeyContractId",
					"passkeyDeployPendingContractId",
					"passkeyDeployPendingSealed",
					"passkeyDeployPendingSealedNonce",
					"passkeyDeployPendingTxHash",
					"passkeyDeployTxHash",
				]);

				const prepareCols = await client.query<{ column_name: string }>(
					`SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'PasskeyClaimPrepare'
             AND column_name IN ('releaseTxHash', 'pendingTxHash', 'signatureExpirationLedger')
           ORDER BY column_name`,
				);
				expect(prepareCols.rows.map((c) => c.column_name)).toEqual([
					"pendingTxHash",
					"signatureExpirationLedger",
				]);
			} finally {
				await client.end();
			}
		} finally {
			await embedded.stop();
		}
	}, 120_000);
});
