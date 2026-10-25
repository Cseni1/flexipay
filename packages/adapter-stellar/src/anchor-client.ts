import { Keypair, WebAuth } from "@stellar/stellar-sdk";
import {
	type StellarAssetIdentity,
	assertAssetIdentity,
	sameAsset,
	sep38AssetString,
} from "./anchor-asset.ts";
import { loadAnchorToml, type AnchorTomlEndpoints } from "./anchor-toml.ts";
import { sanitiseHostedUrl } from "./anchor-url.ts";

/**
 * Reference-anchor client (SDF testanchor) for M1 classic-account cash-out.
 * Sessions tokens stay in memory on this object — never log or return them in
 * evidence helpers. SEP-45 / contract auth is out of scope (M2).
 */

/** SEP-24 statuses treated as successful completion for M1 PASS. */
export const SEP24_SUCCESS_STATUSES = new Set(["completed"]);

/** Terminal but unsuccessful — never report as M1 PASS. */
export const SEP24_FAILURE_STATUSES = new Set([
	"error",
	"expired",
	"no_market",
	"too_small",
	"too_large",
]);

export type Sep24TxStatus = string;

export interface IndicativePrice {
	/** Always labelled indicative: test anchor rejects context=sep24. */
	indicative: true;
	context: "sep6";
	price: string;
	totalPrice?: string;
	sellAmount: string;
	buyAmount: string;
	feeTotal?: string;
	feeAsset?: string;
}

export interface Sep24InteractiveSession {
	/** Anchor transaction id (safe for evidence). */
	id: string;
	/** Sanitised URL for evidence (no query/token). */
	urlSanitised: string;
	/**
	 * Full interactive URL including any session material. Server-side only;
	 * do not put in evidence JSON or git.
	 */
	url: string;
	type: string;
	/** `deposit` funds the classic account with anchor USDC; `withdrawal` is M1 cash-out. */
	kind: "deposit" | "withdrawal";
}

/** @deprecated Use {@link Sep24InteractiveSession}. */
export type Sep24InteractiveWithdraw = Sep24InteractiveSession;

export interface Sep24TransactionView {
	id: string;
	kind: string;
	status: Sep24TxStatus;
	/** Amount fields as returned by the anchor (strings). */
	amountIn?: string;
	amountOut?: string;
	amountFee?: string;
	/** Stellar account that should receive the payment (anchor) — withdraw path. */
	withdrawAnchorAccount?: string;
	/** Memo the customer must include on the classic payment to the anchor. */
	withdrawMemo?: string;
	withdrawMemoType?: string;
	/** Deposit: account the anchor will credit (often the authenticated account). */
	to?: string;
	/** Deposit memo fields when the anchor instructs an inbound Stellar payment. */
	depositMemo?: string;
	depositMemoType?: string;
	/** On-chain payment hash once published by the anchor. */
	stellarTransactionId?: string;
	/** Raw status for evidence; interpret with {@link isSep24Success}. */
	raw: Record<string, unknown>;
}

export interface AnchorPaymentExpectation {
	asset: StellarAssetIdentity;
	/** Decimal string amount the wallet must send (from the transaction record). */
	amount: string;
	destination: string;
	memo: string;
	memoType?: string;
}

export interface ReferenceAnchorClientOptions {
	homeDomain: string;
	/** Expected network passphrase; must match TOML. */
	networkPassphrase: string;
	/** Withdraw / price asset — full identity, not ticker-only. */
	asset: StellarAssetIdentity;
	fetch?: typeof fetch;
}

export class AnchorClientError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "AnchorClientError";
		this.code = code;
	}
}

export function isSep24Success(status: string): boolean {
	return SEP24_SUCCESS_STATUSES.has(status);
}

export function isSep24Failure(status: string): boolean {
	return SEP24_FAILURE_STATUSES.has(status);
}

export function isSep24Terminal(status: string): boolean {
	return isSep24Success(status) || isSep24Failure(status);
}

export class ReferenceAnchorClient {
	readonly homeDomain: string;
	readonly networkPassphrase: string;
	readonly asset: StellarAssetIdentity;
	private readonly fetchFn: typeof fetch;
	private endpoints: AnchorTomlEndpoints | null = null;
	/** SEP-10 JWT — server-side only. */
	private token: string | null = null;
	private tokenAccount: string | null = null;

	constructor(options: ReferenceAnchorClientOptions) {
		assertAssetIdentity(options.asset);
		if (options.asset.networkPassphrase !== options.networkPassphrase) {
			throw new AnchorClientError(
				"network_mismatch",
				"asset.networkPassphrase must equal the client networkPassphrase",
			);
		}
		this.homeDomain = options.homeDomain
			.replace(/^https?:\/\//, "")
			.replace(/\/$/, "");
		this.networkPassphrase = options.networkPassphrase;
		this.asset = options.asset;
		this.fetchFn = options.fetch ?? fetch;
	}

	/** Discover endpoints from stellar.toml (read-only). */
	async connect(): Promise<AnchorTomlEndpoints> {
		const { endpoints, currencies } = await loadAnchorToml(this.homeDomain);
		if (endpoints.networkPassphrase !== this.networkPassphrase) {
			throw new AnchorClientError(
				"network_mismatch",
				`TOML network ${endpoints.networkPassphrase} != client ${this.networkPassphrase}`,
			);
		}
		const listed = currencies.some((c) => sameAsset(c, this.asset));
		if (!listed && this.asset.code !== "native") {
			throw new AnchorClientError(
				"asset_not_listed",
				`TOML currencies do not list ${this.asset.code}:${this.asset.issuer}`,
			);
		}
		this.endpoints = endpoints;
		return endpoints;
	}

	getEndpoints(): AnchorTomlEndpoints {
		if (!this.endpoints) {
			throw new AnchorClientError("not_connected", "call connect() first");
		}
		return this.endpoints;
	}

	/** True when a SEP-10 token is held for this G-account (token never returned). */
	hasSession(account: string): boolean {
		return this.token !== null && this.tokenAccount === account;
	}

	clearSession(): void {
		this.token = null;
		this.tokenAccount = null;
	}

	/**
	 * SEP-10 for a classic G-account. The JWT is stored on this instance only.
	 */
	async authenticate(keypair: Keypair): Promise<void> {
		const endpoints = this.getEndpoints();
		const account = keypair.publicKey();
		const challengeUrl = new URL(endpoints.webAuthEndpoint);
		challengeUrl.searchParams.set("account", account);
		const challengeRes = await this.fetchFn(challengeUrl.toString(), {
			method: "GET",
			headers: { Accept: "application/json" },
		});
		const challengeBody = await readJson(challengeRes);
		if (!challengeRes.ok) {
			throw new AnchorClientError(
				"sep10_challenge_failed",
				`SEP-10 challenge HTTP ${challengeRes.status}: ${summariseBody(challengeBody)}`,
			);
		}
		const txXdr = strField(challengeBody, "transaction");
		const networkPassphrase =
			typeof challengeBody.network_passphrase === "string"
				? challengeBody.network_passphrase
				: this.networkPassphrase;
		if (networkPassphrase !== this.networkPassphrase) {
			throw new AnchorClientError(
				"network_mismatch",
				"SEP-10 challenge network_passphrase mismatch",
			);
		}
		const webAuthHostname = new URL(endpoints.webAuthEndpoint).hostname;
		const { tx } = WebAuth.readChallengeTx(
			txXdr,
			endpoints.signingKey,
			networkPassphrase,
			this.homeDomain,
			webAuthHostname,
		);
		tx.sign(keypair);
		const tokenRes = await this.fetchFn(endpoints.webAuthEndpoint, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ transaction: tx.toXDR() }),
		});
		const tokenBody = await readJson(tokenRes);
		if (!tokenRes.ok) {
			throw new AnchorClientError(
				"sep10_token_failed",
				`SEP-10 token HTTP ${tokenRes.status}: ${summariseBody(tokenBody)}`,
			);
		}
		const token = strField(tokenBody, "token");
		this.token = token;
		this.tokenAccount = account;
	}

	/**
	 * Indicative SEP-38 price. Always uses context=sep6 (sep24 is rejected by the
	 * SDF test anchor). Label as indicative in any UI.
	 */
	async indicativeWithdrawPrice(opts: {
		sellAmount: string;
		/** iso4217 code, default USD. */
		buyFiat?: "USD" | "CAD";
	}): Promise<IndicativePrice> {
		const endpoints = this.getEndpoints();
		const buy = `iso4217:${opts.buyFiat ?? "USD"}`;
		const url = new URL("price", ensureSlash(endpoints.anchorQuoteServer));
		url.searchParams.set("sell_asset", sep38AssetString(this.asset));
		url.searchParams.set("buy_asset", buy);
		url.searchParams.set("sell_amount", opts.sellAmount);
		url.searchParams.set("context", "sep6");
		const res = await this.fetchFn(url.toString(), {
			method: "GET",
			headers: this.authHeaders(false),
		});
		const body = await readJson(res);
		if (!res.ok) {
			throw new AnchorClientError(
				"sep38_price_failed",
				`SEP-38 price HTTP ${res.status}: ${summariseBody(body)}`,
			);
		}
		return {
			indicative: true,
			context: "sep6",
			price: strField(body, "price"),
			totalPrice:
				typeof body.total_price === "string" ? body.total_price : undefined,
			sellAmount: strField(body, "sell_amount"),
			buyAmount: strField(body, "buy_amount"),
			feeTotal:
				typeof body.fee === "object" &&
				body.fee !== null &&
				typeof (body.fee as { total?: unknown }).total === "string"
					? (body.fee as { total: string }).total
					: undefined,
			feeAsset:
				typeof body.fee === "object" &&
				body.fee !== null &&
				typeof (body.fee as { asset?: unknown }).asset === "string"
					? (body.fee as { asset: string }).asset
					: undefined,
		};
	}

	/**
	 * Starts a SEP-24 interactive **deposit** (fund classic account with reference-anchor
	 * USDC for vault #2). Requires {@link authenticate}. Hosted URL is server-side only.
	 */
	async startDepositInteractive(opts: {
		amount: string;
		type?: string;
		lang?: string;
	}): Promise<Sep24InteractiveSession> {
		return this.startInteractive("deposit", opts);
	}

	/**
	 * Starts a SEP-24 interactive **withdraw** (M1 cash-out). Requires {@link authenticate}.
	 * Returns the full URL for the server to open; evidence must use urlSanitised.
	 */
	async startWithdrawInteractive(opts: {
		amount: string;
		/** SEP-24 type; test anchor often accepts bank_account after interactive. */
		type?: string;
		lang?: string;
	}): Promise<Sep24InteractiveSession> {
		return this.startInteractive("withdrawal", opts);
	}

	private async startInteractive(
		kind: "deposit" | "withdrawal",
		opts: { amount: string; type?: string; lang?: string },
	): Promise<Sep24InteractiveSession> {
		const endpoints = this.getEndpoints();
		this.requireToken();
		const path =
			kind === "deposit"
				? "transactions/deposit/interactive"
				: "transactions/withdraw/interactive";
		const url = new URL(path, ensureSlash(endpoints.transferServerSep24));
		// SDF testanchor rejects application/x-www-form-urlencoded; use multipart.
		const form = new FormData();
		form.set(
			"asset_code",
			this.asset.code === "native" ? "native" : this.asset.code,
		);
		if (this.asset.issuer) form.set("asset_issuer", this.asset.issuer);
		form.set("amount", opts.amount);
		if (opts.type) form.set("type", opts.type);
		if (opts.lang) form.set("lang", opts.lang);
		const res = await this.fetchFn(url.toString(), {
			method: "POST",
			headers: this.authHeaders(true),
			body: form,
		});
		const body = await readJson(res);
		if (!res.ok) {
			throw new AnchorClientError(
				"sep24_interactive_failed",
				`SEP-24 ${kind}/interactive HTTP ${res.status}: ${summariseBody(body)}`,
			);
		}
		const id = strField(body, "id");
		const interactiveUrl = strField(body, "url");
		return {
			id,
			url: interactiveUrl,
			urlSanitised: sanitiseHostedUrl(interactiveUrl),
			type:
				typeof body.type === "string"
					? body.type
					: "interactive_customer_info_needed",
			kind,
		};
	}

	/** GET SEP-24 transaction by id. */
	async getTransaction(id: string): Promise<Sep24TransactionView> {
		const endpoints = this.getEndpoints();
		this.requireToken();
		const url = new URL("transaction", ensureSlash(endpoints.transferServerSep24));
		url.searchParams.set("id", id);
		const res = await this.fetchFn(url.toString(), {
			method: "GET",
			headers: this.authHeaders(true),
		});
		const body = await readJson(res);
		if (!res.ok) {
			throw new AnchorClientError(
				"sep24_tx_failed",
				`SEP-24 transaction HTTP ${res.status}: ${summariseBody(body)}`,
			);
		}
		const tx =
			typeof body.transaction === "object" && body.transaction !== null
				? (body.transaction as Record<string, unknown>)
				: (body as Record<string, unknown>);
		return {
			id: strField(tx, "id"),
			kind: typeof tx.kind === "string" ? tx.kind : "withdrawal",
			status: strField(tx, "status"),
			amountIn: optStr(tx, "amount_in"),
			amountOut: optStr(tx, "amount_out"),
			amountFee: optStr(tx, "amount_fee"),
			withdrawAnchorAccount: optStr(tx, "withdraw_anchor_account"),
			withdrawMemo: optStr(tx, "withdraw_memo"),
			withdrawMemoType: optStr(tx, "withdraw_memo_type"),
			to: optStr(tx, "to"),
			depositMemo: optStr(tx, "deposit_memo"),
			depositMemoType: optStr(tx, "deposit_memo_type"),
			stellarTransactionId: optStr(tx, "stellar_transaction_id"),
			raw: tx,
		};
	}

	/**
	 * Poll until terminal status or timeout. M1 PASS requires {@link isSep24Success}.
	 */
	async waitForTerminal(
		id: string,
		opts: { timeoutMs?: number; intervalMs?: number } = {},
	): Promise<Sep24TransactionView> {
		const timeoutMs = opts.timeoutMs ?? 180_000;
		const intervalMs = opts.intervalMs ?? 2_000;
		const deadline = Date.now() + timeoutMs;
		let last: Sep24TransactionView | undefined;
		while (Date.now() < deadline) {
			last = await this.getTransaction(id);
			if (isSep24Terminal(last.status)) return last;
			await sleep(intervalMs);
		}
		throw new AnchorClientError(
			"sep24_timeout",
			`SEP-24 transaction ${id} not terminal after ${timeoutMs}ms (last=${last?.status ?? "none"})`,
		);
	}

	/**
	 * Builds the on-chain payment expectation from a pending SEP-24 withdraw tx.
	 * Call after interactive KYC when memo / anchor account are present.
	 */
	paymentExpectationFromTx(tx: Sep24TransactionView): AnchorPaymentExpectation {
		const destination = tx.withdrawAnchorAccount;
		const memo = tx.withdrawMemo;
		const amount = tx.amountIn;
		if (!destination || !memo || !amount) {
			throw new AnchorClientError(
				"sep24_missing_payment_fields",
				"transaction lacks withdraw_anchor_account, withdraw_memo or amount_in",
			);
		}
		return {
			asset: this.asset,
			amount,
			destination,
			memo,
			memoType: tx.withdrawMemoType,
		};
	}

	/**
	 * M1 completion check: successful status plus matching amount / destination / memo
	 * against the values used when paying the anchor. Does not prove a real bank credit —
	 * reference-anchor simulation only.
	 */
	assertSuccessfulWithdraw(opts: {
		tx: Sep24TransactionView;
		expected: AnchorPaymentExpectation;
	}): void {
		const { tx, expected } = opts;
		if (!isSep24Success(tx.status)) {
			throw new AnchorClientError(
				"sep24_not_success",
				`status ${tx.status} is not a successful completion (M1 requires completed)`,
			);
		}
		if (!sameAsset(expected.asset, this.asset)) {
			throw new AnchorClientError(
				"asset_mismatch",
				"expected payment asset does not match client asset identity",
			);
		}
		if (tx.amountIn && tx.amountIn !== expected.amount) {
			throw new AnchorClientError(
				"amount_mismatch",
				`amount_in ${tx.amountIn} != expected ${expected.amount}`,
			);
		}
		if (
			tx.withdrawAnchorAccount &&
			tx.withdrawAnchorAccount !== expected.destination
		) {
			throw new AnchorClientError(
				"destination_mismatch",
				"withdraw_anchor_account does not match the paid destination",
			);
		}
		if (tx.withdrawMemo && tx.withdrawMemo !== expected.memo) {
			throw new AnchorClientError(
				"memo_mismatch",
				"withdraw_memo does not match the paid memo",
			);
		}
	}

	/** Evidence-safe snapshot (no JWT, sanitised URL fields only). */
	evidenceSafeTx(tx: Sep24TransactionView): Record<string, unknown> {
		return {
			id: tx.id,
			kind: tx.kind,
			status: tx.status,
			amountIn: tx.amountIn,
			amountOut: tx.amountOut,
			amountFee: tx.amountFee,
			withdrawAnchorAccount: tx.withdrawAnchorAccount,
			withdrawMemoPresent: Boolean(tx.withdrawMemo),
			withdrawMemoType: tx.withdrawMemoType,
			stellarTransactionId: tx.stellarTransactionId,
			asset: {
				code: this.asset.code,
				issuer: this.asset.issuer,
				networkPassphrase: this.networkPassphrase,
				contractId: this.asset.contractId,
			},
			referenceAnchorSimulation: true,
			note: "Bank payout is reference-anchor simulation, not a real bank receipt",
		};
	}

	private requireToken(): void {
		if (!this.token || !this.tokenAccount) {
			throw new AnchorClientError(
				"not_authenticated",
				"call authenticate(keypair) before authenticated SEP-24 calls",
			);
		}
	}

	private authHeaders(required: boolean): Record<string, string> {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (this.token) {
			headers.Authorization = `Bearer ${this.token}`;
		} else if (required) {
			this.requireToken();
		}
		return headers;
	}
}

function ensureSlash(base: string): string {
	return base.endsWith("/") ? base : `${base}/`;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
	const text = await res.text();
	if (!text) return {};
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null) {
			return parsed as Record<string, unknown>;
		}
		return { value: parsed };
	} catch {
		return { raw: text.slice(0, 200) };
	}
}

function strField(body: Record<string, unknown>, key: string): string {
	const v = body[key];
	if (typeof v !== "string" || !v) {
		throw new AnchorClientError("bad_response", `missing string field ${key}`);
	}
	return v;
}

function optStr(body: Record<string, unknown>, key: string): string | undefined {
	const v = body[key];
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function summariseBody(body: Record<string, unknown>): string {
	if (typeof body.error === "string") return body.error;
	if (typeof body.detail === "string") return body.detail;
	return JSON.stringify(body).slice(0, 180);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
