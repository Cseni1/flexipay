/**
 * Mint a local Demo Platform API key (plaintext printed once).
 *
 *   DATABASE_URL=... npx tsx apps/api/scripts/bootstrap-demo-org.ts
 *   DATABASE_URL=... npx tsx apps/api/scripts/bootstrap-demo-org.ts --name "Acme Corp"
 *
 * Export the printed key as FP_API_KEY for the Vite proxy / seed scripts.
 * Never commit the key. This is not a customer login endpoint.
 */
import { createDb } from "../src/db.ts";
import { createOrganizationWithApiKey } from "../src/orgs/bootstrap.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error("DATABASE_URL is required (same Postgres the API uses).");
	process.exit(1);
}

const nameArg = process.argv.indexOf("--name");
const name =
	nameArg >= 0 && process.argv[nameArg + 1]
		? process.argv[nameArg + 1]
		: "Demo Platform";

const db = createDb(databaseUrl);
try {
	const result = await createOrganizationWithApiKey(db, {
		name,
		reuseExistingName: true,
		label: "cli-bootstrap",
	});
	// Single JSON object (includes apiKey once). Do not commit the value.
	console.log(
		JSON.stringify(
			{
				ok: true,
				orgId: result.orgId,
				orgName: result.orgName,
				keyId: result.keyId,
				keyPrefix: result.keyPrefix,
				createdOrganization: result.createdOrganization,
				apiKey: result.apiKey,
				note: "Export apiKey as FP_API_KEY for the Vite server only. Never put it in the browser bundle or git.",
			},
			null,
			2,
		),
	);
} finally {
	await db.$disconnect();
}
