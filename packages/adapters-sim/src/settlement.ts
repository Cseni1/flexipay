import { randomBytes } from "node:crypto"
import type {
	ConfirmedFundDeposit,
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
import { FundDepositVerifyError } from "@flexipay/domain"
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
	/** CCR-23 mock vault id (fund identity). Defaults to a stable mock id. */
	vaultId?: string
	/** Mirrors the contract's events; a demo and test hook, not a contract operation. */
	onEvent?: (event: MockVaultEvent) => void
}

interface RecordedDeposit {
	opIndex: number
	payer: string
	amountValue: string
	amountCurrency: string
}

export class MockSettlementAdapter implements SettlementAdapter {
	readonly network = "mock" as const
	readonly vaultId: string
	private readonly vault: MockVault
	private readonly now: () => Date
	private transactions = 0
	/** Distinguishes mock tx refs across adapter instances (CCR-23 unique deposit identity). */
	private readonly instanceId = randomBytes(6).toString("hex")
	/** txRef → deposit invokes recorded for that mock transaction (CCR-23 decode). */
	private readonly depositsByTx = new Map<string, RecordedDeposit[]>()

	constructor(options: MockSettlementOptions) {
		this.vault = new MockVault(options)
		this.now = options.now
		this.vaultId = options.vaultId ?? "mock-payout-vault"
	}

	/** Read from the vault's config(), like the contract's `config()` (ARCHITECTURE §8). */
	async feeBps(): Promise<number> {
		return this.vault.config().feeBps
	}

	async fundVault(payer: string, amount: Money): Promise<SettlementRef> {
		this.vault.deposit(payer, amount)
		const ref = this.ref()
		this.depositsByTx.set(ref.txRef, [
			{
				opIndex: 0,
				payer,
				amountValue: amount.amount,
				amountCurrency: amount.currency,
			},
		])
		return ref
	}

	/**
	 * Test/CLI helper: append another deposit invoke on an existing mock tx so CCR-23
	 * ambiguous-match rejection can be exercised. Does not move vault balances again.
	 */
	recordAdditionalDepositOnTx(
		txRef: string,
		deposit: { payer: string; amount: Money; opIndex: number },
	): void {
		const list = this.depositsByTx.get(txRef) ?? []
		list.push({
			opIndex: deposit.opIndex,
			payer: deposit.payer,
			amountValue: deposit.amount.amount,
			amountCurrency: deposit.amount.currency,
		})
		this.depositsByTx.set(txRef, list)
	}

	async verifyFundDeposit(input: {
		txRef: string
		payer: string
		amount: Money
	}): Promise<ConfirmedFundDeposit> {
		const list = this.depositsByTx.get(input.txRef) ?? []
		const matches = list.filter(
			(d) =>
				d.payer === input.payer &&
				d.amountValue === input.amount.amount &&
				d.amountCurrency === input.amount.currency,
		)
		if (matches.length === 0) {
			throw new FundDepositVerifyError(
				"not_found",
				`no matching mock vault deposit in ${input.txRef}`,
			)
		}
		if (matches.length > 1) {
			throw new FundDepositVerifyError(
				"ambiguous",
				`multiple matching mock vault deposits in ${input.txRef}`,
			)
		}
		const hit = matches[0]!
		return {
			fundTxRef: input.txRef,
			fundOpIndex: hit.opIndex,
			fundAmountValue: hit.amountValue,
			fundAmountCurrency: hit.amountCurrency,
			fundNetwork: "mock",
			fundVaultId: this.vaultId,
		}
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

	/**
	 * Returns a pending payout to the payer (SettlementAdapter.refund): the vault's `cancel` before
	 * expiry, which the payer authorises, and its permissionless `refund` once the payout has
	 * expired. A payout that is not pending, or does not exist, fails as in the contract.
	 */
	async refund(payoutId: string): Promise<SettlementRef> {
		const payout = this.vault.getPayout(payoutId)
		if (payout.status === "Pending" && this.now() < payout.expiresAt) {
			this.vault.cancel(payoutId)
		} else {
			this.vault.refund(payoutId)
		}
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

	/** Transaction references are per adapter instance, unique across instances, mock-only. */
	private ref(): SettlementRef {
		this.transactions += 1
		return {
			network: "mock",
			txRef: `mock-tx-${this.instanceId}-${this.transactions}`,
		}
	}
}
