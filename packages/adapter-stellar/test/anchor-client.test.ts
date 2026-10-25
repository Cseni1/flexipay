import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import {
	AnchorClientError,
	ReferenceAnchorClient,
	isSep24Success,
	isSep24Failure,
} from "../src/anchor-client.ts";
import { parseClassicAssetLine } from "../src/anchor-asset.ts";
import * as toml from "../src/anchor-toml.ts";

const NET = "Test SDF Network ; September 2015";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const SIGNING = "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR";

const asset = parseClassicAssetLine(`USDC:${ISSUER}`, NET);

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("SEP-24 status helpers", () => {
	it("treats only completed as success for M1", () => {
		expect(isSep24Success("completed")).toBe(true);
		expect(isSep24Success("pending_user_transfer_start")).toBe(false);
		expect(isSep24Success("error")).toBe(false);
		expect(isSep24Failure("error")).toBe(true);
		expect(isSep24Failure("expired")).toBe(true);
	});
});

describe("ReferenceAnchorClient", () => {
	it("connect refuses network mismatch from TOML", async () => {
		vi.spyOn(toml, "loadAnchorToml").mockResolvedValue({
			endpoints: {
				homeDomain: "testanchor.stellar.org",
				networkPassphrase: "Public Global Stellar Network ; September 2015",
				signingKey: SIGNING,
				webAuthEndpoint: "https://testanchor.stellar.org/auth",
				transferServerSep24: "https://testanchor.stellar.org/sep24",
				anchorQuoteServer: "https://testanchor.stellar.org/sep38",
			},
			currencies: [asset],
		});
		const client = new ReferenceAnchorClient({
			homeDomain: "testanchor.stellar.org",
			networkPassphrase: NET,
			asset,
		});
		await expect(client.connect()).rejects.toMatchObject({
			code: "network_mismatch",
		});
		vi.restoreAllMocks();
	});

	it("indicative price uses context=sep6 and never returns a token", async () => {
		vi.spyOn(toml, "loadAnchorToml").mockResolvedValue({
			endpoints: {
				homeDomain: "testanchor.stellar.org",
				networkPassphrase: NET,
				signingKey: SIGNING,
				webAuthEndpoint: "https://testanchor.stellar.org/auth",
				transferServerSep24: "https://testanchor.stellar.org/sep24",
				anchorQuoteServer: "https://testanchor.stellar.org/sep38",
			},
			currencies: [asset],
		});
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			expect(url).toContain("context=sep6");
			expect(url).toContain(`sell_asset=stellar%3AUSDC%3A${ISSUER}`);
			return jsonResponse({
				price: "1.05",
				sell_amount: "5",
				buy_amount: "3.8",
				fee: { total: "1.00", asset: `stellar:USDC:${ISSUER}` },
			});
		});
		const client = new ReferenceAnchorClient({
			homeDomain: "testanchor.stellar.org",
			networkPassphrase: NET,
			asset,
			fetch: fetchMock as unknown as typeof fetch,
		});
		await client.connect();
		const price = await client.indicativeWithdrawPrice({ sellAmount: "5" });
		expect(price.indicative).toBe(true);
		expect(price.context).toBe("sep6");
		expect(price.price).toBe("1.05");
		expect(client.hasSession("GANY")).toBe(false);
		vi.restoreAllMocks();
	});

	it("startWithdrawInteractive keeps full URL server-side and sanitises for evidence", async () => {
		vi.spyOn(toml, "loadAnchorToml").mockResolvedValue({
			endpoints: {
				homeDomain: "testanchor.stellar.org",
				networkPassphrase: NET,
				signingKey: SIGNING,
				webAuthEndpoint: "https://testanchor.stellar.org/auth",
				transferServerSep24: "https://testanchor.stellar.org/sep24",
				anchorQuoteServer: "https://testanchor.stellar.org/sep38",
			},
			currencies: [asset],
		});
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				id: "tx-1",
				url: "https://testanchor.stellar.org/sep24/interactive?token=super-secret",
				type: "interactive_customer_info_needed",
			}),
		);
		const client = new ReferenceAnchorClient({
			homeDomain: "testanchor.stellar.org",
			networkPassphrase: NET,
			asset,
			fetch: fetchMock as unknown as typeof fetch,
		});
		await client.connect();
		// Inject a fake session without SEP-10 crypto in unit tests.
		;(client as unknown as { token: string; tokenAccount: string }).token =
			"jwt-test";
		;(client as unknown as { token: string; tokenAccount: string }).tokenAccount =
			Keypair.random().publicKey();

		const started = await client.startWithdrawInteractive({ amount: "5" });
		expect(started.id).toBe("tx-1");
		expect(started.url).toContain("token=super-secret");
		expect(started.urlSanitised).toBe(
			"https://testanchor.stellar.org/sep24/interactive",
		);
		expect(started.urlSanitised).not.toContain("token");
		vi.restoreAllMocks();
	});

	it("assertSuccessfulWithdraw requires completed and matching payment fields", () => {
		const client = new ReferenceAnchorClient({
			homeDomain: "testanchor.stellar.org",
			networkPassphrase: NET,
			asset,
		});
		const expected = {
			asset,
			amount: "5.0000000",
			destination: "GCSGSR6KQQ5BP2FXVPWRL6SWPUSFWLVONLIBJZUKTVQB5FYJFVL6XOXE",
			memo: "memo-1",
		};
		expect(() =>
			client.assertSuccessfulWithdraw({
				tx: {
					id: "1",
					kind: "withdrawal",
					status: "error",
					raw: {},
				},
				expected,
			}),
		).toThrow(AnchorClientError);

		expect(() =>
			client.assertSuccessfulWithdraw({
				tx: {
					id: "1",
					kind: "withdrawal",
					status: "completed",
					amountIn: "5.0000000",
					withdrawAnchorAccount: expected.destination,
					withdrawMemo: "memo-1",
					raw: {},
				},
				expected,
			}),
		).not.toThrow();
	});

	it("evidenceSafeTx never embeds memos in clear when recording presence only", () => {
		const client = new ReferenceAnchorClient({
			homeDomain: "testanchor.stellar.org",
			networkPassphrase: NET,
			asset,
		});
		const snap = client.evidenceSafeTx({
			id: "tx",
			kind: "withdrawal",
			status: "completed",
			withdrawMemo: "secret-memo",
			raw: {},
		});
		expect(snap.withdrawMemoPresent).toBe(true);
		expect(JSON.stringify(snap)).not.toContain("secret-memo");
		expect(snap.referenceAnchorSimulation).toBe(true);
	});
});
