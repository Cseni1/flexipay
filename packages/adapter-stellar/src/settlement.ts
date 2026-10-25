import {
	SettlementError,
	money,
	toMinor,
	type ConfirmedFundDeposit,
	type LockRequest,
	type LockResult,
	type Money,
	type ReleaseRequest,
	type ReleaseResult,
	type SettlementAdapter,
	type SettlementPayoutState,
	type SettlementRef,
	type SettlementStatus,
} from "@flexipay/domain";
import { Server } from "@stellar/stellar-sdk/rpc";
import type { CustodialDemoWalletProvider } from "./demo-wallets.ts";
import { PayoutVault, type Payout } from "./vault-client.ts";
import { VaultError, toVaultError } from "./vault-errors.ts";
import { externalIdFor, payoutAmounts } from "./vault-math.ts";
import {
	listVaultDepositInvokes,
	matchSingleVaultDeposit,
} from "./vault-deposit-decode.ts";

// Stellar settlement adapter (ARCHITECTURE §11.2, DEV_PLAN SC2). Same SettlementAdapter
// contract as MockSettlementAdapter; real testnet tx hashes; fee from vault config().

const SETTLEMENT_ASSET = "USDC";

export interface StellarSettlementOptions {
	vault: PayoutVault;
	/** Custodial demo keypairs used to sign payer and recipient vault calls. */
	wallets: CustodialDemoWalletProvider;
	/** CCR-23: vault contract id (FP_PAYOUT_VAULT_ID). */
	vaultId: string;
	rpcUrl: string;
	networkPassphrase: string;
	/**
	 * Asset code reported on Money fields. Must match the vault's test USDC (7 decimals).
	 * Defaults to USDC.
	 */
	assetCurrency?: string;
	/** Test override: supply envelope XDR instead of RPC fetch. */
	fetchFundTxEnvelopeXdr?: (txRef: string) => Promise<string>;
}

export class StellarSettlementAdapter implements SettlementAdapter {
	readonly network = "stellar" as const;
	readonly vaultId: string;
	private readonly vault: PayoutVault;
	private readonly wallets: CustodialDemoWalletProvider;
	private readonly asset: string;
	private readonly rpcUrl: string;
	private readonly networkPassphrase: string;
	private readonly fetchFundTxEnvelopeXdr?: (txRef: string) => Promise<string>;

	constructor(options: StellarSettlementOptions) {
		this.vault = options.vault;
		this.wallets = options.wallets;
		this.vaultId = options.vaultId;
		this.rpcUrl = options.rpcUrl;
		this.networkPassphrase = options.networkPassphrase;
		this.asset = options.assetCurrency ?? SETTLEMENT_ASSET;
		this.fetchFundTxEnvelopeXdr = options.fetchFundTxEnvelopeXdr;
	}

	/** Read from the vault's on-chain config(), never from a local invented fee. */
	async feeBps(): Promise<number> {
		return this.mapCall(() => this.vault.feeBps());
	}

	async fundVault(payer: string, amount: Money): Promise<SettlementRef> {
		this.assertAsset(amount);
		const keypair = this.wallets.keypairForAddress(payer);
		const receipt = await this.mapCall(() =>
			this.vault.deposit(keypair, toMinor(amount)),
		);
		return this.ref(receipt.txHash);
	}

	async verifyFundDeposit(input: {
		txRef: string;
		payer: string;
		amount: Money;
	}): Promise<ConfirmedFundDeposit> {
		this.assertAsset(input.amount);
		const envelopeXdr = this.fetchFundTxEnvelopeXdr
			? await this.fetchFundTxEnvelopeXdr(input.txRef)
			: await this.fetchEnvelopeXdrFromRpc(input.txRef);
		const invokes = listVaultDepositInvokes(envelopeXdr, this.networkPassphrase);
		const hit = matchSingleVaultDeposit({
			invokes,
			vaultId: this.vaultId,
			payer: input.payer,
			amountMinor: toMinor(input.amount),
		});
		return {
			fundTxRef: input.txRef,
			fundOpIndex: hit.opIndex,
			fundAmountValue: input.amount.amount,
			fundAmountCurrency: input.amount.currency,
			fundNetwork: "stellar",
			fundVaultId: this.vaultId,
		};
	}

	async lock(req: LockRequest): Promise<LockResult> {
		this.assertAsset(req.amount);
		const payer = this.wallets.keypairForAddress(req.payer);
		const externalId = externalIdFor(req.paymentId, req.attempt);
		const feeBps = await this.feeBps();
		const expected = payoutAmounts(toMinor(req.amount), feeBps, req.feeMode);
		const receipt = await this.mapCall(() =>
			this.vault.createPayout(payer, {
				externalId,
				claimHash: hexToBuf(req.claimHashHex, "claimHashHex"),
				amount: toMinor(req.amount),
				mode: req.feeMode,
				expiresAt: toUnixSeconds(req.expiresAt),
			}),
		);
		return {
			...this.ref(receipt.txHash),
			payoutId: receipt.result.toString(),
			externalIdHex: externalId.toString("hex"),
			fee: money(expected.fee, this.asset),
			locked: money(expected.locked, this.asset),
			net: money(expected.net, this.asset),
		};
	}

	async release(req: ReleaseRequest): Promise<ReleaseResult> {
		const receiver = this.wallets.keypairForAddress(req.destination);
		const receipt = await this.mapCall(() =>
			this.vault.claim(receiver, {
				id: BigInt(req.payoutId),
				secret: hexToBuf(req.secretHex, "secretHex"),
			}),
		);
		return {
			...this.ref(receipt.txHash),
			received: money(receipt.result, this.asset),
		};
	}

	/**
	 * Returns a pending payout to the payer: vault `cancel` before expiry (payer signs),
	 * permissionless `refund` after ledger expiry. The sandbox API clock does not move ledger time.
	 */
	async refund(payoutId: string): Promise<SettlementRef> {
		const id = BigInt(payoutId);
		const payout = await this.mapCall(() => this.vault.getPayout(id));
		if (payout.status !== "Pending") throw new SettlementError(7);
		const payer = this.wallets.keypairForAddress(payout.payer);
		const nowSec = BigInt(Math.floor(Date.now() / 1000));

		if (nowSec < payout.expiresAt) {
			try {
				const receipt = await this.vault.cancel(payer, id);
				return this.ref(receipt.txHash);
			} catch (err) {
				const vaultErr = err instanceof VaultError ? err : toVaultError(err);
				// Boundary: ledger already past expiry between our check and the call.
				if (vaultErr?.code === 8) {
					const receipt = await this.mapCall(() => this.vault.refund(payer, id));
					return this.ref(receipt.txHash);
				}
				this.rethrow(err);
			}
		}

		const receipt = await this.mapCall(() => this.vault.refund(payer, id));
		return this.ref(receipt.txHash);
	}

	async status(payoutId: string): Promise<SettlementStatus> {
		const payout = await this.mapCall(() => this.vault.getPayout(BigInt(payoutId)));
		return statusOf(payout, this.asset);
	}

	async findLock(
		payer: string,
		paymentId: string,
		attempt: number,
	): Promise<string | undefined> {
		const id = await this.mapCall(() =>
			this.vault.payoutByExternal(payer, externalIdFor(paymentId, attempt)),
		);
		return id === undefined ? undefined : id.toString();
	}

	private ref(txHash: string): SettlementRef {
		return { network: "stellar", txRef: txHash };
	}

	private async fetchEnvelopeXdrFromRpc(txRef: string): Promise<string> {
		const server = new Server(this.rpcUrl);
		const got = await server.getTransaction(txRef);
		const envelope =
			got && typeof got === "object" && "envelopeXdr" in got
				? (got as { envelopeXdr?: string | { toXDR?: (fmt: string) => string } })
						.envelopeXdr
				: undefined;
		if (!envelope) {
			throw new Error(`fund tx ${txRef} has no envelopeXdr on RPC`);
		}
		if (typeof envelope === "string") return envelope;
		if (typeof envelope.toXDR === "function") return envelope.toXDR("base64");
		throw new Error(`fund tx ${txRef} envelopeXdr is not decodable`);
	}

	private assertAsset(amount: Money): void {
		if (amount.currency !== this.asset) {
			throw new SettlementError(3);
		}
		if (amount.amount === "0") throw new SettlementError(3);
	}

	private async mapCall<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (err) {
			this.rethrow(err);
		}
	}

	private rethrow(err: unknown): never {
		if (err instanceof SettlementError) throw err;
		const vaultErr = err instanceof VaultError ? err : toVaultError(err);
		if (vaultErr) throw new SettlementError(vaultErr.code, { cause: vaultErr });
		throw err;
	}
}

function statusOf(payout: Payout, asset: string): SettlementStatus {
	return {
		payoutId: payout.id.toString(),
		state: payout.status.toLowerCase() as SettlementPayoutState,
		expiresAt: new Date(Number(payout.expiresAt) * 1000),
		net: money(payout.net, asset),
	};
}

function toUnixSeconds(date: Date): bigint {
	return BigInt(Math.floor(date.getTime() / 1000));
}

function hexToBuf(hex: string, label: string): Buffer {
	if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
		throw new Error(`invalid ${label}: expected even-length hex`);
	}
	const buf = Buffer.from(hex, "hex");
	if (buf.length !== 32) {
		throw new Error(`invalid ${label}: expected 32 bytes, got ${buf.length}`);
	}
	return buf;
}
