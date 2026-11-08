import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlindPayAdapter, type FetchLike, type UploadFetch } from "@flexipay/adapters-live";
import type { Provider } from "@flexipay/domain";
import { termsReturnUrl } from "../src/blindpay/onboarding.ts";
import { auth, startTestServer, type TestServer } from "./helpers.ts";

// CCR-46: BlindPay onboarding usable by people: terms return automatically, documents upload.

const ROW: Provider = {
	id: "blindpay_sandbox",
	kind: "bank",
	countries: ["BR"],
	currencies: ["USDC", "BRL"],
	endpointTypes: ["bank_account"],
	legKinds: ["convert", "payout"],
	fee: { fixed: { amount: "0", currency: "USDC" }, bps: 0 },
	fxSpreadBps: 0,
	estimatedTimeSeconds: 600,
	limits: null,
	simulated: true,
	placeholder: false,
	implementation: "blindpay",
};

describe("termsReturnUrl", () => {
	const env = { WEB_ORIGIN: "https://my.getflexipay.app", WEB_ORIGIN_EXTRA: "https://x.vercel.app" };
	it("defaults to our own terms-done page", () => {
		expect(termsReturnUrl(undefined, env)).toBe("https://my.getflexipay.app/blindpay/terms-done");
	});
	it("accepts a caller address only on a trusted origin", () => {
		expect(termsReturnUrl("https://x.vercel.app/blindpay/terms-done", env)).toBe(
			"https://x.vercel.app/blindpay/terms-done",
		);
		expect(termsReturnUrl("https://evil.example/steal", env)).toBe(
			"https://my.getflexipay.app/blindpay/terms-done",
		);
		expect(termsReturnUrl("not a url", env)).toBe("https://my.getflexipay.app/blindpay/terms-done");
	});
	it("is undefined when no web origin is configured", () => {
		expect(termsReturnUrl("https://evil.example", {})).toBeUndefined();
	});
});

describe("CCR-46 onboarding routes", () => {
	let s: TestServer;
	let key = "";
	let businessKey = "";
	const tosBodies: unknown[] = [];
	const uploads: { url: string; bucket: unknown; type: string; size: number }[] = [];
	let uploadReply: { status: number; json: unknown } = {
		status: 200,
		json: { file_url: "https://files.blindpay.com/1712345678901-kyc.png" },
	};

	const fetch: FetchLike = async (url, init) => {
		const path = new URL(url).pathname;
		if (path.endsWith("/tos")) {
			tosBodies.push(init.body ? JSON.parse(init.body) : undefined);
			return {
				status: 200,
				text: async () =>
					JSON.stringify({ url: "https://app.blindpay.com/e/terms-of-service?session_token=t" }),
			};
		}
		return { status: 500, text: async () => "{}" };
	};
	const uploadFetch: UploadFetch = async (url, init) => {
		const file = init.body.get("file") as Blob;
		uploads.push({ url, bucket: init.body.get("bucket"), type: file.type, size: file.size });
		return { status: uploadReply.status, text: async () => JSON.stringify(uploadReply.json) };
	};

	beforeAll(async () => {
		process.env.WEB_ORIGIN_TEST_BACKUP = process.env.WEB_ORIGIN ?? "";
		process.env.WEB_ORIGIN = "https://my.getflexipay.app";
		s = await startTestServer();
		const person = await s.newOrg("Person");
		key = person.key;
		await s.db.organization.update({ where: { id: person.orgId }, data: { kind: "individual" } });
		businessKey = (await s.newOrg("Business")).key;
		const adapter = new BlindPayAdapter(ROW, {
			apiKey: "bp_test",
			instanceId: "in_test",
			sandbox: null,
			liveApproved: false,
			fetch,
			uploadFetch,
		});
		const original = s.runtime.getProvider;
		s.runtime.getProvider = (id) => (id === "blindpay_sandbox" ? adapter : original(id));
	}, 60_000);

	afterAll(async () => {
		process.env.WEB_ORIGIN = process.env.WEB_ORIGIN_TEST_BACKUP || undefined;
		if (!process.env.WEB_ORIGIN) delete process.env.WEB_ORIGIN;
		await s?.stop();
	});

	const upload = (body: Uint8Array | string, type: string, k = key) =>
		globalThis.fetch(`${s.base}/v1/blindpay/onboarding/upload`, {
			method: "POST",
			headers: { authorization: `Bearer ${k}`, "content-type": type },
			body: typeof body === "string" ? body : new Blob([new Uint8Array(body)]),
		});

	it("the terms link always returns to our own page, whatever the caller asks", async () => {
		const res = await globalThis.fetch(`${s.base}/v1/blindpay/onboarding`, {
			method: "POST",
			headers: auth(key, { "idempotency-key": "ob-1" }),
			body: JSON.stringify({ redirectUrl: "https://evil.example/steal" }),
		});
		expect(res.status).toBe(200);
		expect(tosBodies.at(-1)).toMatchObject({
			redirect_url: "https://my.getflexipay.app/blindpay/terms-done",
		});
	});

	it("streams an ID photo to BlindPay's onboarding bucket and returns the file URL", async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		const res = await upload(png, "image/png");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ fileUrl: "https://files.blindpay.com/1712345678901-kyc.png" });
		expect(uploads.at(-1)).toMatchObject({ bucket: "onboarding", type: "image/png", size: 7 });
		expect(uploads.at(-1)!.url).toContain("/v1/upload?instance_id=in_test");
	});

	it("refuses other file types, empty and oversized files", async () => {
		expect((await upload("<svg/>", "image/svg+xml")).status).toBe(415);
		expect((await upload(new Uint8Array(0), "image/png")).status).toBe(413);
		const big = await upload(new Uint8Array(5 * 1024 * 1024 + 1), "image/jpeg");
		expect(big.status).toBe(413);
	});

	it("needs a signed-in individual", async () => {
		const anon = await globalThis.fetch(`${s.base}/v1/blindpay/onboarding/upload`, {
			method: "POST",
			headers: { "content-type": "image/png" },
			body: new Uint8Array([1]),
		});
		expect(anon.status).toBe(401);
		expect((await upload(new Uint8Array([1]), "image/png", businessKey)).status).toBe(422);
	});

	it("a BlindPay refusal is a clear 502, without BlindPay's raw message", async () => {
		uploadReply = { status: 400, json: { message: "file_type_not_allowed" } };
		const res = await upload(new Uint8Array([1, 2]), "image/jpeg");
		expect(res.status).toBe(502);
		expect((await res.json()).code).toBe("upload_failed");
		uploadReply = { status: 200, json: { file_url: "http://insecure.example/x" } };
		expect((await upload(new Uint8Array([1, 2]), "image/jpeg")).status).toBe(502);
	});
});
