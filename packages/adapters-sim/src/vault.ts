import {
	addMoney,
	applyBps,
	compareMoney,
	money,
	SettlementError,
	subtractMoney,
	type FeeMode,
	type Money,
} from "@flexipay/domain"
import { sha256Hex } from "./hash.ts"

// The `payout_vault` contract ported to memory (contracts/payout_vault/RULES.md,
// ARCHITECTURE §12). Every check order, error number, fee rule and event below is the contract's,
// so the mock and Stellar testnet behave the same. Amounts are integer minor units of the vault's
// token; the fee is fixed at deployment; there is no admin key and nothing here can change it.

export interface MockVaultConfig {
	/** Settlement asset the vault was deployed for, e.g. USDC. */
	token: string
	/** Address that receives the fee on a claim. */
	treasury: string
	/** Fixed at deployment, at most 1000 (10%) or deployment fails with FeeTooHigh. */
	feeBps: number
}

export type VaultPayoutStatus = "Pending" | "Claimed" | "Refunded"

export interface VaultPayout {
	id: string
	payer: string
	externalIdHex: string
	claimHashHex: string
	gross: Money
	fee: Money
	net: Money
	locked: Money
	expiresAt: Date
	status: VaultPayoutStatus
}

export interface CreatePayoutRequest {
	payer: string
	externalIdHex: string
	claimHashHex: string
	amount: Money
	feeMode: FeeMode
	expiresAt: Date
}

/** The contract's three events, with the topics and data RULES.md lists. */
export type MockVaultEvent =
	| {
			type: "payout_created"
			simulated: true
			payoutId: string
			payer: string
			externalIdHex: string
			gross: Money
			fee: Money
			net: Money
			expiresAt: Date
	  }
	| {
			type: "payout_claimed"
			simulated: true
			payoutId: string
			destination: string
			net: Money
			fee: Money
	  }
	| {
			type: "payout_refunded"
			simulated: true
			payoutId: string
			payer: string
			amount: Money
			cancelled: boolean
	  }

export interface MockVaultOptions extends MockVaultConfig {
	/** The vault's clock. Supplied by the caller so tests and the demo are deterministic. */
	now: () => Date
	onEvent?: (event: MockVaultEvent) => void
}

const usedKey = (payer: string, externalIdHex: string): string =>
	`${payer}\u0000${externalIdHex}`

const copyPayout = (payout: VaultPayout): VaultPayout => ({
	...payout,
	gross: { ...payout.gross },
	fee: { ...payout.fee },
	net: { ...payout.net },
	locked: { ...payout.locked },
	expiresAt: new Date(payout.expiresAt.getTime()),
})

export class MockVault {
	private readonly settings: MockVaultConfig
	private readonly now: () => Date
	private readonly onEvent?: (event: MockVaultEvent) => void
	private readonly balances = new Map<string, bigint>()
	private readonly payouts = new Map<string, VaultPayout>()
	/** (payer, external id) -> payout id. An id is never removed: it stays used after a refund. */
	private readonly usedExternalIds = new Map<string, string>()
	private nextPayoutId = 1

	constructor(options: MockVaultOptions) {
		if (
			!Number.isInteger(options.feeBps) ||
			options.feeBps < 0 ||
			options.feeBps > 1000
		) {
			throw new SettlementError(4)
		}
		this.settings = {
			token: options.token,
			treasury: options.treasury,
			feeBps: options.feeBps,
		}
		this.now = options.now
		this.onEvent = options.onEvent
	}

	config(): MockVaultConfig {
		return { ...this.settings }
	}

	balance(payer: string): Money {
		return money(this.balances.get(payer) ?? 0n, this.settings.token)
	}

	/** The mock token has no ledger of its own, so funding is a faucet transfer; the deposit
	 * rule the vault enforces is the one in RULES.md: a positive amount in its token. */
	deposit(payer: string, amount: Money): void {
		this.assertPositive(amount)
		this.addTo(payer, BigInt(amount.amount))
	}

	withdraw(payer: string, amount: Money): void {
		this.assertPositive(amount)
		if (compareMoney(this.balance(payer), amount) < 0) {
			throw new SettlementError(5)
		}
		this.addTo(payer, -BigInt(amount.amount))
	}

	/** RULES.md order: amount, expiry, unused external id, fee and amounts, then the balance. */
	createPayout(req: CreatePayoutRequest): VaultPayout {
		this.assertPositive(req.amount)
		if (this.seconds(this.now()) >= this.seconds(req.expiresAt)) {
			throw new SettlementError(11)
		}
		const key = usedKey(req.payer, req.externalIdHex)
		if (this.usedExternalIds.has(key)) throw new SettlementError(12)

		const fee = applyBps(req.amount, this.settings.feeBps)
		const payerPays = req.feeMode === "PayerPays"
		let net = req.amount
		if (!payerPays) {
			// RecipientPays: net must stay above zero, otherwise the payout is invalid.
			if (compareMoney(fee, req.amount) >= 0) throw new SettlementError(3)
			net = subtractMoney(req.amount, fee)
		}
		const locked = payerPays ? addMoney(req.amount, fee) : req.amount
		if (compareMoney(this.balance(req.payer), locked) < 0) {
			throw new SettlementError(5)
		}

		this.addTo(req.payer, -BigInt(locked.amount))
		const payout: VaultPayout = {
			id: String(this.nextPayoutId++),
			payer: req.payer,
			externalIdHex: req.externalIdHex,
			claimHashHex: req.claimHashHex,
			gross: { ...req.amount },
			fee,
			net,
			locked,
			expiresAt: new Date(req.expiresAt.getTime()),
			status: "Pending",
		}
		this.payouts.set(payout.id, payout)
		this.usedExternalIds.set(key, payout.id)
		this.emit({
			type: "payout_created",
			simulated: true,
			payoutId: payout.id,
			payer: payout.payer,
			externalIdHex: payout.externalIdHex,
			gross: { ...payout.gross },
			fee: { ...payout.fee },
			net: { ...payout.net },
			expiresAt: new Date(payout.expiresAt.getTime()),
		})
		return copyPayout(payout)
	}

	/** Pending, before expiry (claiming at exactly expires_at fails), and the secret must match. */
	claim(payoutId: string, secretHex: string, destination: string): Money {
		const payout = this.pending(payoutId)
		if (this.seconds(this.now()) >= this.seconds(payout.expiresAt)) {
			throw new SettlementError(8)
		}
		const digest = sha256Hex(Buffer.from(secretHex, "hex"))
		if (digest !== payout.claimHashHex.toLowerCase())
			throw new SettlementError(10)

		payout.status = "Claimed"
		this.emit({
			type: "payout_claimed",
			simulated: true,
			payoutId: payout.id,
			destination,
			net: { ...payout.net },
			fee: { ...payout.fee },
		})
		return { ...payout.net }
	}

	/** The payer can cancel any pending payout; there is no expiry check on this path. */
	cancel(payoutId: string): VaultPayout {
		const payout = this.pending(payoutId)
		this.returnLocked(payout, true)
		return copyPayout(payout)
	}

	/** Anyone can refund a pending payout once it has expired. */
	refund(payoutId: string): VaultPayout {
		const payout = this.pending(payoutId)
		if (this.seconds(this.now()) < this.seconds(payout.expiresAt)) {
			throw new SettlementError(9)
		}
		this.returnLocked(payout, false)
		return copyPayout(payout)
	}

	getPayout(payoutId: string): VaultPayout {
		const payout = this.payouts.get(payoutId)
		if (!payout) throw new SettlementError(6)
		return copyPayout(payout)
	}

	/** `payout_by_external`: the payout id for (payer, external id), or nothing. */
	payoutByExternal(payer: string, externalIdHex: string): string | undefined {
		return this.usedExternalIds.get(usedKey(payer, externalIdHex))
	}

	private pending(payoutId: string): VaultPayout {
		const payout = this.payouts.get(payoutId)
		if (!payout) throw new SettlementError(6)
		if (payout.status !== "Pending") throw new SettlementError(7)
		return payout
	}

	private returnLocked(payout: VaultPayout, cancelled: boolean): void {
		this.addTo(payout.payer, BigInt(payout.locked.amount))
		payout.status = "Refunded"
		this.emit({
			type: "payout_refunded",
			simulated: true,
			payoutId: payout.id,
			payer: payout.payer,
			amount: { ...payout.locked },
			cancelled,
		})
	}

	private assertPositive(amount: Money): void {
		// A different asset is not a valid amount for a vault deployed for `token`; the contract
		// is typed to its token, so the mock refuses it the same way, as an invalid amount.
		if (amount.currency !== this.settings.token) throw new SettlementError(3)
		if (amount.amount === "0") throw new SettlementError(3)
	}

	/** Only ever called with a positive `Money` amount or an explicit signed minor-unit delta. */
	private addTo(payer: string, delta: bigint): void {
		this.balances.set(payer, (this.balances.get(payer) ?? 0n) + delta)
	}

	private seconds(date: Date): number {
		// Ledger timestamps are whole seconds, so the contract's boundaries are whole seconds.
		return Math.floor(date.getTime() / 1000)
	}

	private emit(event: MockVaultEvent): void {
		this.onEvent?.(event)
	}
}
