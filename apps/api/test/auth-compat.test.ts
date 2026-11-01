import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./helpers.ts";

// TASK 06 compatibility gate: Better Auth on THIS repo's Express 5 + Prisma 7 + embedded
// Postgres. Real HTTP, real database, real migrations; only the mailer is in-memory.

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer({ auth: true });
}, 120_000);
afterAll(async () => {
	await s?.stop();
});

const json = (origin: string, extra: Record<string, string> = {}) => ({
	"content-type": "application/json",
	origin,
	...extra,
});

describe("Better Auth x Express 5 x Prisma 7", () => {
	it("sign-up writes through the Prisma adapter and sends a verification mail", async () => {
		const r = await fetch(`${s.base}/api/auth/sign-up/email`, {
			method: "POST",
			headers: json(s.origin),
			body: JSON.stringify({ email: "gate@example.com", password: "correct-horse-1", name: "Gate" }),
		});
		expect(r.status).toBe(200);
		expect(await s.db.authUser.count({ where: { email: "gate@example.com" } })).toBe(1);
		expect(s.mail.outbox.at(-1)?.to).toBe("gate@example.com");
		expect(s.mail.outbox.at(-1)?.text).toContain("/api/auth/verify-email?token=");
	});
});
