import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

// CCR-22 production anchor gateway (claim-anchor-gateway.ts) over a fake ReferenceAnchorClient:
// lazy connect with retry after a failure, SEP-10 session reuse, the custodial key check and
// the AnchorClientError → HTTP mapping. No network.

const fake = vi.hoisted(() => ({
	connects: 0,
	connectError: null as null | Error,
	authenticated: [] as string[],
	sessions: new Set<string>(),
	priceError: null as null | Error,
	envError: null as null | Error,
	tx: { id: "tx1", status: "completed", amountIn: "5", withdrawAnchorAccount: "GANCHOR", withdrawMemo: "m1", withdrawMemoType: "text", stellarTransactionId: "st1" },
}));

vi.mock("@flexipay/adapter-stellar", async (importOriginal) => {
	const real = await importOriginal<typeof import("@flexipay/adapter-stellar")>();
	class FakeClient {
		asset = { code: "USDC", issuer: "GISSUER" };
		async connect() {
			fake.connects += 1;
			if (fake.connectError) throw fake.connectError;
		}
		hasSession(a: string) {
			return fake.sessions.has(a);
		}
		async authenticate(kp: { publicKey(): string }) {
			fake.authenticated.push(kp.publicKey());
			fake.sessions.add(kp.publicKey());
		}
		async indicativeWithdrawPrice(o: { sellAmount: string }) {
			if (fake.priceError) throw fake.priceError;
			return { sellAmount: o.sellAmount, buyAmount: "4.9", price: "0.98" };
		}
		async startWithdrawInteractive(o: { amount: string }) {
			return { id: `w-${o.amount}`, url: "https://anchor.example/i?token=SECRET", urlSanitised: "https://anchor.example/i" };
		}
		async getTransaction(id: string) {
			return { ...fake.tx, id };
		}
	}
	return {
		...real,
		ReferenceAnchorClient: FakeClient,
		loadAnchorEventEnv: () => {
			if (fake.envError) throw fake.envError;
			return { homeDomain: "testanchor.example", networkPassphrase: "Test", asset: { code: "USDC", issuer: "GISSUER" } };
		},
		sep38AssetString: (a: { code: string; issuer: string }) => `stellar:${a.code}:${a.issuer}`,
	};
});

const { AnchorClientError } = await import("@flexipay/adapter-stellar");
const { ApiError } = await import("../src/errors.ts");
const { createEnvAnchorClaimGateway, resolveClassicAuthSecret } = await import("../src/anchor/claim-anchor-gateway.ts");

const kp = Keypair.random();

beforeEach(() => {
	Object.assign(fake, { connects: 0, connectError: null, authenticated: [], sessions: new Set(), priceError: null, envError: null });
});

async function apiError(p: Promise<unknown>): Promise<InstanceType<typeof ApiError>> {
	try {
		await p;
	} catch (e) {
		if (e instanceof ApiError) return e;
		throw e;
	}
	throw new Error("expected an ApiError");
}

describe("resolveClassicAuthSecret", () => {
	it("returns the secret paired with a known demo address only", () => {
		const env = {
			FP_RECIPIENT_A_ADDRESS: "GA",
			FP_RECIPIENT_A_SECRET: "SA",
			FP_RECIPIENT_B_ADDRESS: "GB",
			FP_PAYER_DEMO_ADDRESS: " GP ",
			FP_PAYER_DEMO_SECRET: "SP",
		};
		expect(resolveClassicAuthSecret("GA", env)).toBe("SA");
		expect(resolveClassicAuthSecret(" GP", env)).toBe("SP");
		// An address without its secret, or an unknown address, resolves to nothing.
		expect(resolveClassicAuthSecret("GB", env)).toBeUndefined();
		expect(resolveClassicAuthSecret("GX", env)).toBeUndefined();
	});
});

describe("createEnvAnchorClaimGateway", () => {
	it("reads the asset and home domain without connecting", () => {
		const g = createEnvAnchorClaimGateway({});
		expect(g.sellAsset()).toBe("stellar:USDC:GISSUER");
		expect(g.homeDomain()).toBe("testanchor.example");
		expect(createEnvAnchorClaimGateway({}).homeDomain()).toBe("testanchor.example");
		expect(fake.connects).toBe(0);
	});

	it("connects once and quotes an indicative SEP-38 price", async () => {
		const g = createEnvAnchorClaimGateway({});
		const price = await g.indicativePrice("5");
		expect(price).toEqual({
			indicative: true,
			context: "sep6",
			sellAmount: "5",
			buyAmount: "4.9",
			buyAsset: "iso4217:USD",
			sellAsset: "stellar:USDC:GISSUER",
			price: "0.98",
		});
		await g.indicativePrice("6");
		expect(fake.connects).toBe(1);
	});

	it("a failed connect is retried on the next call and maps to 502 anchor_unavailable", async () => {
		const g = createEnvAnchorClaimGateway({});
		fake.connectError = new AnchorClientError("not_connected", "toml unreachable");
		const e = await apiError(g.indicativePrice("5"));
		expect(e.status).toBe(502);
		expect(e.code).toBe("anchor_unavailable");
		fake.connectError = null;
		await g.indicativePrice("5");
		expect(fake.connects).toBe(2);
	});

	it("maps SEP-24 / SEP-10 failures to sep24_failed and anything else to anchor_unavailable", async () => {
		const g = createEnvAnchorClaimGateway({});
		for (const [err, code] of [
			[new AnchorClientError("sep24_timeout", "slow"), "sep24_failed"],
			[new AnchorClientError("sep10_token_failed", "jwt"), "sep24_failed"],
			[new AnchorClientError("sep38_price_failed", "no price"), "anchor_unavailable"],
			[new AnchorClientError("something_else", "?"), "anchor_unavailable"],
			[new Error("socket"), "anchor_unavailable"],
		] as const) {
			fake.priceError = err;
			const e = await apiError(g.indicativePrice("5"));
			expect(e.code, err.message).toBe(code);
			expect(e.message).toBe(err.message);
		}
		fake.priceError = "plain string" as unknown as Error;
		expect((await apiError(g.indicativePrice("5"))).message).toBe("anchor error");
	});

	it("an env that cannot be loaded maps to 502", async () => {
		fake.envError = new Error("FP_ANCHOR_HOME_DOMAIN missing");
		const e = await apiError(createEnvAnchorClaimGateway({}).indicativePrice("5"));
		expect(e.status).toBe(502);
		expect(e.message).toMatch(/FP_ANCHOR_HOME_DOMAIN/);
	});

	it("starts a withdrawal with one SEP-10 session per account and reads its status", async () => {
		const g = createEnvAnchorClaimGateway({});
		const started = await g.startWithdraw({ amount: "5", classicAccount: kp.publicKey(), authSecret: kp.secret() });
		expect(started).toEqual({
			anchorTxId: "w-5",
			urlSanitised: "https://anchor.example/i",
			interactiveUrl: "https://anchor.example/i?token=SECRET",
			kind: "withdrawal",
		});
		const status = await g.getWithdrawStatus({ anchorTxId: "tx9", classicAccount: kp.publicKey(), authSecret: kp.secret() });
		expect(status).toMatchObject({
			anchorTxId: "tx9",
			status: "completed",
			withdrawMemoPresent: true,
			terminal: true,
			success: true,
			failure: false,
			anchorStellarTransactionId: "st1",
		});
		expect(fake.authenticated).toEqual([kp.publicKey()]);
	});

	it("refuses an auth key that is not the vault-release classic address (409)", async () => {
		const g = createEnvAnchorClaimGateway({});
		const other = Keypair.random();
		const e = await apiError(g.startWithdraw({ amount: "5", classicAccount: other.publicKey(), authSecret: kp.secret() }));
		expect(e.status).toBe(409);
		expect(e.code).toBe("invalid_state");
		expect(fake.authenticated).toEqual([]);
	});
});
