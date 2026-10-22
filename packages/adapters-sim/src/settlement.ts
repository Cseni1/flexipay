import type {
	LockRequest,
	LockResult,
	Money,
	ReleaseRequest,
	ReleaseResult,
	SettlementAdapter,
	SettlementPayoutState,
	SettlementRef,
	SettlementStatus,
} from "@flexipay/domain"
import { lockExternalIdHex } from "./hash.ts"
import { MockVault, type MockVaultEvent } from "./vault.ts"

// The offline settlement adapter (ARCHITECTURE §11.2, DEV_PLAN SF2). It implements the merged
// SettlementAdapter over the in-memory payout vault, so tests and the offline demo follow
// contracts/payout_vault/RULES.md: the same per-attempt external id, fee rule, expiry boundaries,
// error numbers and events. Nothing here touches the network, a key or real funds.

export interface MockSettlementOptions {
	/** Settlement asset the vault is deployed for (config/providers.json settlementRails asset). */
	token: string
	/** Fee recipient, fixed at deployment. */
	treasury: string
	/** The vault's fixed fee in basis points, at most 1000. */
	feeBps: number
	/** The vault's clock, supplied by the caller so the demo and tests are deterministic. */
	now: () => Date
	/** Mirrors the contract's events; a demo and test hook, not a contract operation. */
	onEvent?: (event: MockVaultEvent) => void
}

export class MockSettlementAdapter implements SettlementAdapter {
	readonly network = "mock" as const
	private readonly vault: MockVault
	private transactions = 0

	constructor(options: MockSettlementOptions) {
		this.vault = new MockVault(options)
	}

	/** Read from the vault's config(), like the contract's `config()` (ARCHITECTURE §8). */
	async feeBps(): Promise<number> {
		return this.vault.config().feeBps
	}

	async fundVault(payer: string, amount: Money): Promise<SettlementRef> {
		this.vault.deposit(payer, amount)
		return this.ref()
	}

	async lock(req: LockRequest): Promise<LockResult> {
		const externalIdHex = lockExternalIdHex(req.paymentId, req.attempt)
		const payout = this.vault.createPayout({
			payer: req.payer,
			externalIdHex,
			claimHashHex: req.claimHashHex,
			amount: req.amount,
			feeMode: req.feeMode,
			expiresAt: req.expiresAt,
		})
		return {
			...this.ref(),
			payoutId: payout.id,
			externalIdHex,
			fee: payout.fee,
			locked: payout.locked,
			net: payout.net,
		}
	}

	async release(req: ReleaseRequest): Promise<ReleaseResult> {
		const received = this.vault.claim(
			req.payoutId,
			req.secretHex,
			req.destination,
		)
		return { ...this.ref(), received }
	}

	/** The vault's `refund`: a pending payout can only be returned once it has expired. */
	async refund(payoutId: string): Promise<SettlementRef> {
		this.vault.refund(payoutId)
		return this.ref()
	}

	async status(payoutId: string): Promise<SettlementStatus> {
		const payout = this.vault.getPayout(payoutId)
		return {
			payoutId: payout.id,
			state: payout.status.toLowerCase() as SettlementPayoutState,
			expiresAt: payout.expiresAt,
			net: payout.net,
		}
	}

	/** `payout_by_external`: recovery when a lock succeeded but its response was lost. */
	async findLock(
		payer: string,
		paymentId: string,
		attempt: number,
	): Promise<string | undefined> {
		return this.vault.payoutByExternal(
			payer,
			lockExternalIdHex(paymentId, attempt),
		)
	}

	/** Transaction references are per adapter instance, deterministic and clearly mock-only. */
	private ref(): SettlementRef {
		this.transactions += 1
		return { network: "mock", txRef: `mock-tx-${this.transactions}` }
	}
}
