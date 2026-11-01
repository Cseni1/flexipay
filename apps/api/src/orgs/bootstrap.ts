/**
 * Local/dev organization + API-key provisioning.
 * Plaintext keys are returned once to the caller; only keyHash is persisted.
 * Not an HTTP customer signup — use CLI (`scripts/bootstrap-demo-org.ts`).
 */
import type { Db } from "../db.ts";
import { newApiKey, newId, sha256Hex } from "../ids.ts";

export type BootstrappedOrg = {
	orgId: string;
	orgName: string;
	keyId: string;
	keyPrefix: string;
	/** Full Bearer secret — show once; never log in production paths. */
	apiKey: string;
	createdOrganization: boolean;
};

export async function createOrganizationWithApiKey(
	db: Db,
	opts: {
		name?: string;
		kind?: "business" | "individual";
		label?: string;
		/**
		 * When true (default for CLI), if an org with this name exists, mint another
		 * key for that org. When false, always insert a new Organization row
		 * (name is not unique — used by tests for isolation).
		 */
		reuseExistingName?: boolean;
	} = {},
): Promise<BootstrappedOrg> {
	const name = opts.name?.trim() || "Demo Platform";
	const kind = opts.kind ?? "business";
	const reuse = opts.reuseExistingName ?? true;

	let org = reuse
		? await db.organization.findFirst({ where: { name } })
		: null;
	let createdOrganization = false;
	if (!org) {
		org = await db.organization.create({
			data: { id: newId("org"), name, kind },
		});
		createdOrganization = true;
	}

	const minted = newApiKey();
	const keyRow = await db.apiKey.create({
		data: {
			id: newId("key"),
			organizationId: org.id,
			prefix: minted.prefix,
			keyHash: minted.keyHash,
			label: opts.label ?? "local-bootstrap",
		},
	});

	return {
		orgId: org.id,
		orgName: org.name,
		keyId: keyRow.id,
		keyPrefix: minted.prefix,
		apiKey: minted.key,
		createdOrganization,
	};
}

/** Revoke by full plaintext key (hashes then updates). Idempotent if already revoked. */
export async function revokeApiKey(
	db: Db,
	plaintextKey: string,
): Promise<{ revoked: boolean; alreadyRevoked: boolean; orgId: string | null }> {
	const keyHash = sha256Hex(plaintextKey);
	const row = await db.apiKey.findUnique({ where: { keyHash } });
	if (!row) {
		return { revoked: false, alreadyRevoked: false, orgId: null };
	}
	if (row.revokedAt) {
		return { revoked: false, alreadyRevoked: true, orgId: row.organizationId };
	}
	await db.apiKey.update({
		where: { id: row.id },
		data: { revokedAt: new Date() },
	});
	return { revoked: true, alreadyRevoked: false, orgId: row.organizationId };
}
