/**
 * Revoke a local API key by plaintext value (sets ApiKey.revokedAt).
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/revoke-api-key.ts --key "$FP_API_KEY"
 *
 * Does not print the key back. Exit 0 if revoked or already revoked; 1 if unknown.
 */
import { createDb } from "../src/db.ts";
import { revokeApiKey } from "../src/orgs/bootstrap.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error("DATABASE_URL is required.");
	process.exit(1);
}

const keyFlag = process.argv.indexOf("--key");
const key =
	keyFlag >= 0 && process.argv[keyFlag + 1]
		? process.argv[keyFlag + 1]
		: process.env.FP_API_KEY_TO_REVOKE?.trim();

if (!key) {
	console.error("Pass --key <plaintext> or set FP_API_KEY_TO_REVOKE.");
	process.exit(1);
}

const db = createDb(databaseUrl);
try {
	const result = await revokeApiKey(db, key);
	if (!result.orgId) {
		console.error(JSON.stringify({ ok: false, error: "unknown_key" }));
		process.exit(1);
	}
	console.log(
		JSON.stringify({
			ok: true,
			orgId: result.orgId,
			revoked: result.revoked,
			alreadyRevoked: result.alreadyRevoked,
		}),
	);
} finally {
	await db.$disconnect();
}
