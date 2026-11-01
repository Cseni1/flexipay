import type { Db } from "../db.ts";
import { newId } from "../ids.ts";

// TASK 06: organization bootstrap for a verified user.
// Atomic: Organization + Membership are created in one transaction, so a crash can never leave
// an orphan organization. Idempotent and race-safe: Membership.userId is unique; if a
// concurrent call won, we roll back ours and return the winner's organization. Called from the
// user-create hook (best effort) and lazily on the first session request (recovery).

export interface OrgRef {
	id: string;
	name: string;
}

function isUniqueViolation(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

async function findOrg(db: Db, userId: string): Promise<OrgRef | null> {
	const m = await db.membership.findUnique({
		where: { userId },
		include: { organization: true },
	});
	return m ? { id: m.organization.id, name: m.organization.name } : null;
}

export async function ensureOrganization(
	db: Db,
	user: { id: string; name: string; email: string },
): Promise<OrgRef> {
	const existing = await findOrg(db, user.id);
	if (existing) return existing;
	const name = (user.name.trim() || user.email).slice(0, 200);
	try {
		return await db.$transaction(async (tx) => {
			const org = await tx.organization.create({
				data: { id: newId("org"), name, kind: "individual" },
			});
			await tx.membership.create({
				data: { id: newId("mem"), userId: user.id, organizationId: org.id, role: "owner" },
			});
			return { id: org.id, name: org.name };
		});
	} catch (err) {
		if (isUniqueViolation(err)) {
			const winner = await findOrg(db, user.id);
			if (winner) return winner;
		}
		throw err;
	}
}
