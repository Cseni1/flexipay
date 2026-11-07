import { Keypair, StellarToml, WebAuth } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AnchorClientError,
	ReferenceAnchorClient,
	isSep24Terminal,
	type Sep24TransactionView,
} from "../src/anchor-client.ts";
import { parseClassicAssetLine } from "../src/anchor-asset.ts";
import { ANCHOR_ENV_NAMES, loadAnchorEventEnv } from "../src/anchor-env.ts";
import * as toml from "../src/anchor-toml.ts";

// No network: TOML resolution and fetch are faked. SEP-10 uses a real challenge built
// offline with a throwaway server key, so readChallengeTx validation runs for real.

const NET = "Test SDF Network ; September 2015";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const OTHER_ISSUER = "GBBO6NHB3RZQ6UYRAQUD5RQ3EQ3GFAJNCQ3XGJ4UYHAF4FYYTLD4ZY6B";
const HOME = "testanchor.stellar.org";
const server = Keypair.random();
const asset = parseClassicAssetLine(`USDC:${ISSUER}`, NET);

const endpoints = {
	homeDomain: HOME,
	networkPassphrase: NET,
	signingKey: server.publicKey(),
	webAuthEndpoint: `https://${HOME}/auth`,
	transferServerSep24: `https://${HOME}/sep24`,
	anchorQuoteServer: `https://${HOME}/sep38/`,
};

function json(body: unknown, status = 200): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

type FetchFn = (url: string, init?: RequestInit) => Response | Promise<Response>;

async function connected(fetchImpl: FetchFn = () => json({}), currencies = [asset]) {
	vi.spyOn(toml, "loadAnchorToml").mockResolvedValue({ endpoints, currencies });
	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
		fetchImpl(String(input), init),
	);
	const client = new ReferenceAnchorClient({
		homeDomain: `https://${HOME}/`,
		networkPassphrase: NET,
		asset,
		fetch: fetchMock as unknown as typeof fetch,
	});
	await client.connect();
	return { client, fetchMock };
}

function withToken(client: ReferenceAnchorClient, account = Keypair.random().publicKey()) {
	const c = client as unknown as { token: string; tokenAccount: string };
	c.token = "jwt-test";
	c.tokenAccount = account;
}

async function code(p: Promise<unknown> | (() => unknown)): Promise<string> {
	try {
		if (typeof p === "function") p();
		else await p;
	} catch (e) {
		expect(e).toBeInstanceOf(AnchorClientError);
		return (e as AnchorClientError).code;
	}
	throw new Error("expected AnchorClientError");
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("construction / connect", () => {
	it("rejects an asset on a different network", () => {
		expect(
			() =>
				new ReferenceAnchorClient({
					homeDomain: HOME,
					networkPassphrase: "Public Global Stellar Network ; September 2015",
					asset,
				}),
		).toThrow(/networkPassphrase/);
	});

	it("strips scheme and trailing slash from the home domain", async () => {
		const { client } = await connected();
		expect(client.homeDomain).toBe(HOME);
		expect(client.getEndpoints()).toEqual(endpoints);
		expect(toml.loadAnchorToml).toHaveBeenCalledWith(HOME);
	});

	it("refuses when the TOML does not list the asset (same code, other issuer)", async () => {
		vi.spyOn(toml, "loadAnchorToml").mockResolvedValue({
			endpoints,
			currencies: [parseClassicAssetLine(`USDC:${OTHER_ISSUER}`, NET)],
		});
		const client = new ReferenceAnchorClient({ homeDomain: HOME, networkPassphrase: NET, asset });
		expect(await code(client.connect())).toBe("asset_not_listed");
	});

	it("native asset does not need a TOML listing", async () => {
		vi.spyOn(toml, "loadAnchorToml").mockResolvedValue({ endpoints, currencies: [] });
		const client = new ReferenceAnchorClient({
			homeDomain: HOME,
			networkPassphrase: NET,
			asset: { code: "native", issuer: "", networkPassphrase: NET },
		});
		await expect(client.connect()).resolves.toEqual(endpoints);
	});

	it("authenticated calls before connect → not_connected", async () => {
		const client = new ReferenceAnchorClient({ homeDomain: HOME, networkPassphrase: NET, asset });
		expect(await code(() => client.getEndpoints())).toBe("not_connected");
		expect(await code(client.getTransaction("x"))).toBe("not_connected");
	});
});

describe("SEP-10 authenticate", () => {
	const user = Keypair.random();

	function challenge(opts: { net?: string; signer?: Keypair } = {}) {
		return WebAuth.buildChallengeTx(
			opts.signer ?? server,
			user.publicKey(),
			HOME,
			300,
			NET,
			HOME,
		);
	}

	it("fetches the challenge, signs it and stores the token (never returned)", async () => {
		let posted: { transaction: string } | undefined;
		const { client, fetchMock } = await connected((url, init) => {
			if (init?.method === "GET") {
				expect(url).toBe(`https://${HOME}/auth?account=${user.publicKey()}`);
				return json({ transaction: challenge(), network_passphrase: NET });
			}
			posted = JSON.parse(String(init?.body));
			return json({ token: "jwt-abc" });
		});
		const out = await client.authenticate(user);
		expect(out).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(client.hasSession(user.publicKey())).toBe(true);
		expect(client.hasSession(Keypair.random().publicKey())).toBe(false);
		// Signed by server + client.
		const { tx } = WebAuth.readChallengeTx(posted!.transaction, server.publicKey(), NET, HOME, HOME);
		expect(tx.signatures).toHaveLength(2);
		client.clearSession();
		expect(client.hasSession(user.publicKey())).toBe(false);
	});

	it("challenge without network_passphrase uses the client network", async () => {
		const { client } = await connected((_u, init) =>
			init?.method === "GET" ? json({ transaction: challenge() }) : json({ token: "t" }),
		);
		await client.authenticate(user);
		expect(client.hasSession(user.publicKey())).toBe(true);
	});

	it("challenge HTTP error → sep10_challenge_failed with the anchor's error text", async () => {
		const { client } = await connected(() => json({ error: "account invalid" }, 400));
		const err = (await client.authenticate(user).catch((e) => e)) as AnchorClientError;
		expect(err.code).toBe("sep10_challenge_failed");
		expect(err.message).toBe("SEP-10 challenge HTTP 400: account invalid");
	});

	it("challenge network mismatch is refused", async () => {
		const { client } = await connected(() =>
			json({ transaction: challenge(), network_passphrase: "Public Global Stellar Network ; September 2015" }),
		);
		expect(await code(client.authenticate(user))).toBe("network_mismatch");
	});

	it("challenge signed by the wrong server key is refused before signing", async () => {
		const { client, fetchMock } = await connected(() =>
			json({ transaction: challenge({ signer: Keypair.random() }) }),
		);
		await expect(client.authenticate(user)).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(client.hasSession(user.publicKey())).toBe(false);
	});

	it("missing transaction field → bad_response", async () => {
		const { client } = await connected(() => json({}));
		expect(await code(client.authenticate(user))).toBe("bad_response");
	});

	it("token HTTP error → sep10_token_failed (detail field)", async () => {
		const { client } = await connected((_u, init) =>
			init?.method === "GET"
				? json({ transaction: challenge() })
				: json({ detail: "bad signature" }, 401),
		);
		const err = (await client.authenticate(user).catch((e) => e)) as AnchorClientError;
		expect(err.code).toBe("sep10_token_failed");
		expect(err.message).toMatch(/401: bad signature/);
		expect(client.hasSession(user.publicKey())).toBe(false);
	});
});

describe("SEP-38 indicative price", () => {
	it("sends bearer token when held, defaults buy to USD, optional fields", async () => {
		const { client, fetchMock } = await connected((url) => {
			expect(url).toContain("buy_asset=iso4217%3ACAD");
			expect(url.startsWith(`https://${HOME}/sep38/price?`)).toBe(true);
			return json({ price: "1.3", total_price: "1.4", sell_amount: "5", buy_amount: "6.5", fee: {} });
		});
		withToken(client);
		const p = await client.indicativeWithdrawPrice({ sellAmount: "5", buyFiat: "CAD" });
		expect(p).toMatchObject({ price: "1.3", totalPrice: "1.4", feeTotal: undefined, feeAsset: undefined });
		const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer jwt-test");
	});

	it("HTTP error → sep38_price_failed; non-JSON body is summarised", async () => {
		const { client } = await connected(() => json("<html>oops</html>", 502));
		const err = (await client.indicativeWithdrawPrice({ sellAmount: "5" }).catch((e) => e)) as AnchorClientError;
		expect(err.code).toBe("sep38_price_failed");
		expect(err.message).toContain("<html>oops</html>");
	});

	it("missing price fields → bad_response", async () => {
		const { client } = await connected(() => json({ price: "1" }));
		expect(await code(client.indicativeWithdrawPrice({ sellAmount: "5" }))).toBe("bad_response");
	});
});

describe("SEP-24 interactive + transactions", () => {
	it("interactive requires a session", async () => {
		const { client, fetchMock } = await connected();
		expect(await code(client.startWithdrawInteractive({ amount: "5" }))).toBe("not_authenticated");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("posts multipart with asset, amount, type and lang; default type when absent", async () => {
		let form: FormData | undefined;
		const { client } = await connected((url, init) => {
			expect(url).toBe(`https://${HOME}/sep24/transactions/withdraw/interactive`);
			form = init?.body as FormData;
			return json({ id: "w1", url: "https://x.example/i?token=t" });
		});
		withToken(client);
		const s = await client.startWithdrawInteractive({ amount: "5", type: "bank_account", lang: "en" });
		expect(s.type).toBe("interactive_customer_info_needed");
		expect(form!.get("asset_code")).toBe("USDC");
		expect(form!.get("asset_issuer")).toBe(ISSUER);
		expect(form!.get("amount")).toBe("5");
		expect(form!.get("type")).toBe("bank_account");
		expect(form!.get("lang")).toBe("en");
	});

	it("interactive HTTP error → sep24_interactive_failed", async () => {
		const { client } = await connected(() => json({ error: "unsupported asset" }, 400));
		withToken(client);
		const err = (await client.startDepositInteractive({ amount: "1" }).catch((e) => e)) as AnchorClientError;
		expect(err.code).toBe("sep24_interactive_failed");
		expect(err.message).toMatch(/deposit\/interactive HTTP 400: unsupported asset/);
	});

	const txBody = {
		id: "t1",
		kind: "withdrawal",
		status: "pending_user_transfer_start",
		amount_in: "5.0000000",
		amount_out: "4.00",
		amount_fee: "1.00",
		withdraw_anchor_account: "GANCHOR",
		withdraw_memo: "123",
		withdraw_memo_type: "id",
		to: "",
		stellar_transaction_id: "abc",
	};

	it("getTransaction reads the nested transaction object", async () => {
		const { client, fetchMock } = await connected(() => json({ transaction: txBody }));
		withToken(client);
		const tx = await client.getTransaction("t1");
		expect(String(fetchMock.mock.calls[0]![0])).toBe(`https://${HOME}/sep24/transaction?id=t1`);
		expect(tx).toMatchObject({
			id: "t1",
			status: "pending_user_transfer_start",
			amountIn: "5.0000000",
			withdrawAnchorAccount: "GANCHOR",
			withdrawMemo: "123",
			withdrawMemoType: "id",
			to: undefined,
			stellarTransactionId: "abc",
		});
		expect(tx.raw).toEqual(txBody);
	});

	it("getTransaction also accepts a flat body and defaults kind", async () => {
		const { client } = await connected(() => json({ id: "t2", status: "completed" }));
		withToken(client);
		const tx = await client.getTransaction("t2");
		expect(tx.kind).toBe("withdrawal");
		expect(tx.status).toBe("completed");
	});

	it("getTransaction HTTP error and empty body", async () => {
		const { client } = await connected(() => new Response("", { status: 404 }));
		withToken(client);
		const err = (await client.getTransaction("nope").catch((e) => e)) as AnchorClientError;
		expect(err.code).toBe("sep24_tx_failed");
		expect(err.message).toBe("SEP-24 transaction HTTP 404: {}");
	});

	it("JSON primitive body is wrapped and then fails field checks", async () => {
		const { client } = await connected(() => json("42"));
		withToken(client);
		expect(await code(client.getTransaction("t"))).toBe("bad_response");
	});

	it("waitForTerminal polls until a terminal status", async () => {
		vi.useFakeTimers();
		const statuses = ["incomplete", "pending_anchor", "completed"];
		const { client, fetchMock } = await connected(() =>
			json({ transaction: { id: "t1", status: statuses.shift() } }),
		);
		withToken(client);
		const p = client.waitForTerminal("t1", { intervalMs: 1000, timeoutMs: 60_000 });
		await vi.advanceTimersByTimeAsync(2500);
		const tx = await p;
		expect(tx.status).toBe("completed");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("waitForTerminal returns failure terminals too (caller must check success)", async () => {
		const { client } = await connected(() => json({ transaction: { id: "t1", status: "expired" } }));
		withToken(client);
		const tx = await client.waitForTerminal("t1");
		expect(isSep24Terminal(tx.status)).toBe(true);
	});

	it("waitForTerminal times out with the last status", async () => {
		vi.useFakeTimers();
		const { client } = await connected(() =>
			json({ transaction: { id: "t1", status: "pending_anchor" } }),
		);
		withToken(client);
		const p = client.waitForTerminal("t1", { intervalMs: 2000, timeoutMs: 5000 });
		const caught = p.catch((e) => e);
		await vi.advanceTimersByTimeAsync(10_000);
		const err = (await caught) as AnchorClientError;
		expect(err.code).toBe("sep24_timeout");
		expect(err.message).toBe("SEP-24 transaction t1 not terminal after 5000ms (last=pending_anchor)");
	});

	it("waitForTerminal with zero timeout never polls", async () => {
		const { client, fetchMock } = await connected();
		withToken(client);
		const err = (await client.waitForTerminal("t1", { timeoutMs: 0 }).catch((e) => e)) as AnchorClientError;
		expect(err.message).toMatch(/last=none/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("waitForTerminal propagates getTransaction errors", async () => {
		const { client } = await connected(() => json({ error: "gone" }, 500));
		withToken(client);
		expect(await code(client.waitForTerminal("t1"))).toBe("sep24_tx_failed");
	});
});

describe("payment expectation / withdraw assertions", () => {
	const client = new ReferenceAnchorClient({ homeDomain: HOME, networkPassphrase: NET, asset });
	const tx = (o: Partial<Sep24TransactionView> = {}): Sep24TransactionView => ({
		id: "t",
		kind: "withdrawal",
		status: "completed",
		amountIn: "5",
		withdrawAnchorAccount: "GDEST",
		withdrawMemo: "m1",
		withdrawMemoType: "text",
		raw: {},
		...o,
	});

	it("builds the expectation from withdraw fields", () => {
		expect(client.paymentExpectationFromTx(tx())).toEqual({
			asset,
			amount: "5",
			destination: "GDEST",
			memo: "m1",
			memoType: "text",
		});
	});

	it.each(["withdrawAnchorAccount", "withdrawMemo", "amountIn"] as const)(
		"missing %s → sep24_missing_payment_fields",
		async (field) => {
			expect(await code(() => client.paymentExpectationFromTx(tx({ [field]: undefined })))).toBe(
				"sep24_missing_payment_fields",
			);
		},
	);

	const expected = { asset, amount: "5", destination: "GDEST", memo: "m1" };

	it.each([
		[{ amountIn: "4" }, expected, "amount_mismatch"],
		[{ withdrawAnchorAccount: "GOTHER" }, expected, "destination_mismatch"],
		[{ withdrawMemo: "m2" }, expected, "memo_mismatch"],
		[{}, { ...expected, asset: parseClassicAssetLine(`USDC:${OTHER_ISSUER}`, NET) }, "asset_mismatch"],
		[{ status: "pending_anchor" }, expected, "sep24_not_success"],
	])("assertSuccessfulWithdraw %j → %s", async (patch, exp, c) => {
		expect(await code(() => client.assertSuccessfulWithdraw({ tx: tx(patch), expected: exp }))).toBe(c);
	});

	it("absent anchor fields are not treated as mismatches", () => {
		expect(() =>
			client.assertSuccessfulWithdraw({
				tx: tx({ amountIn: undefined, withdrawAnchorAccount: undefined, withdrawMemo: undefined }),
				expected,
			}),
		).not.toThrow();
	});
});

describe("loadAnchorToml (resolver mocked)", () => {
	const base = {
		NETWORK_PASSPHRASE: NET,
		SIGNING_KEY: ` ${server.publicKey()} `,
		WEB_AUTH_ENDPOINT: "https://a/auth",
		TRANSFER_SERVER_SEP0024: "https://a/sep24",
		ANCHOR_QUOTE_SERVER: "https://a/sep38",
	};

	it("reads endpoints and currencies; normalises the domain", async () => {
		const spy = vi.spyOn(StellarToml.Resolver, "resolve").mockResolvedValue({
			...base,
			WEB_AUTH_FOR_CONTRACTS_ENDPOINT: "https://a/sep45",
			WEB_AUTH_CONTRACT_ID: "CCONTRACT",
			CURRENCIES: [
				{ code: "USDC", issuer: ISSUER },
				{ code: "native" },
				{ code: "SRT" },
				{ issuer: ISSUER },
				null,
				"junk",
			],
		} as never);
		const res = await toml.loadAnchorToml("https://testanchor.stellar.org/");
		expect(spy).toHaveBeenCalledWith("testanchor.stellar.org");
		expect(res.endpoints).toEqual({
			homeDomain: "testanchor.stellar.org",
			networkPassphrase: NET,
			signingKey: server.publicKey(),
			webAuthEndpoint: "https://a/auth",
			transferServerSep24: "https://a/sep24",
			anchorQuoteServer: "https://a/sep38",
			webAuthForContractsEndpoint: "https://a/sep45",
			webAuthContractId: "CCONTRACT",
		});
		expect(res.currencies).toEqual([
			asset,
			{ code: "native", issuer: "", networkPassphrase: NET },
		]);
	});

	it("no CURRENCIES → empty list; optional SEP-45 fields absent", async () => {
		vi.spyOn(StellarToml.Resolver, "resolve").mockResolvedValue(base as never);
		const res = await toml.loadAnchorToml("x.example");
		expect(res.currencies).toEqual([]);
		expect(res.endpoints.webAuthContractId).toBeUndefined();
	});

	it.each(["SIGNING_KEY", "WEB_AUTH_ENDPOINT", "TRANSFER_SERVER_SEP0024", "ANCHOR_QUOTE_SERVER", "NETWORK_PASSPHRASE"])(
		"missing %s throws",
		async (key) => {
			vi.spyOn(StellarToml.Resolver, "resolve").mockResolvedValue({ ...base, [key]: "  " } as never);
			await expect(toml.loadAnchorToml("x.example")).rejects.toThrow(`stellar.toml missing ${key}`);
		},
	);
});

describe("loadAnchorEventEnv", () => {
	const required = {
		[ANCHOR_ENV_NAMES.homeDomain]: " testanchor.stellar.org ",
		[ANCHOR_ENV_NAMES.networkPassphrase]: NET,
		[ANCHOR_ENV_NAMES.usdcAsset]: `USDC:${ISSUER}`,
	};

	it("loads the required fields, no vault #2 by default", () => {
		const env = loadAnchorEventEnv(required);
		expect(env).toEqual({ homeDomain: "testanchor.stellar.org", networkPassphrase: NET, asset });
	});

	it("loads optional vault #2 fields and contract id", () => {
		const env = loadAnchorEventEnv({
			...required,
			[ANCHOR_ENV_NAMES.usdcContractId]: " CSAC ",
			[ANCHOR_ENV_NAMES.anchorVaultId]: "CVAULT2",
			[ANCHOR_ENV_NAMES.anchorVaultFeeBps]: "0",
			[ANCHOR_ENV_NAMES.anchorVaultTreasury]: "GTREAS",
			[ANCHOR_ENV_NAMES.anchorVaultPurpose]: "anchor cash-out",
		});
		expect(env.asset.contractId).toBe("CSAC");
		expect(env.anchorVaultId).toBe("CVAULT2");
		expect(env.anchorVaultFeeBps).toBe(0);
		expect(env.anchorVaultTreasury).toBe("GTREAS");
		expect(env.anchorVaultPurpose).toBe("anchor cash-out");
	});

	it.each([ANCHOR_ENV_NAMES.homeDomain, ANCHOR_ENV_NAMES.networkPassphrase, ANCHOR_ENV_NAMES.usdcAsset])(
		"missing %s throws",
		(name) => {
			expect(() => loadAnchorEventEnv({ ...required, [name]: " " })).toThrow(`Missing ${name}`);
		},
	);

	it.each(["1001", "-1", "1.5", "abc"])("vault fee %s out of range", (fee) => {
		expect(() =>
			loadAnchorEventEnv({ ...required, [ANCHOR_ENV_NAMES.anchorVaultFeeBps]: fee }),
		).toThrow(/FP_ANCHOR_VAULT_FEE_BPS out of range/);
	});

	it("rejects a ticker-only asset", () => {
		expect(() => loadAnchorEventEnv({ ...required, [ANCHOR_ENV_NAMES.usdcAsset]: "USDC" })).toThrow();
	});
});
