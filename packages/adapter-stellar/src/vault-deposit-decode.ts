import {
	FeeBumpTransaction,
	StrKey,
	Transaction,
	TransactionBuilder,
	scValToNative,
	xdr,
} from "@stellar/stellar-sdk"
import { FundDepositVerifyError } from "@flexipay/domain"

/**
 * CCR-23: list vault `deposit` invokes inside a Stellar transaction envelope.
 * `opIndex` is the 0-based operation index in the (inner) transaction.
 */

export interface DecodedVaultDepositInvoke {
	opIndex: number
	contractId: string
	payer: string
	amount: bigint
}

export function listVaultDepositInvokes(
	envelopeXdr: string,
	networkPassphrase: string,
): DecodedVaultDepositInvoke[] {
	let parsed: unknown
	try {
		parsed = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase)
	} catch (error) {
		throw new Error(
			`fund tx envelope is not valid XDR: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	const transaction =
		parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed
	if (!(transaction instanceof Transaction)) {
		throw new Error("fund tx envelope is not a Transaction")
	}

	const out: DecodedVaultDepositInvoke[] = []
	transaction.operations.forEach((operation, opIndex) => {
		if (operation.type !== "invokeHostFunction" || !operation.func) return
		const hostFunction = operation.func
		if (hostFunction.switch().name !== "hostFunctionTypeInvokeContract") return
		const invoke = hostFunction.invokeContract()
		const address = invoke.contractAddress()
		if (address.switch().name !== "scAddressTypeContract") return
		const contractId = StrKey.encodeContract(
			Buffer.from(address.contractId() as unknown as Uint8Array),
		)
		const functionName = invoke.functionName().toString("utf8")
		if (functionName !== "deposit") return
		let args: unknown[]
		try {
			args = invoke.args().map((arg: xdr.ScVal) => scValToNative(arg))
		} catch (error) {
			throw new Error(
				`deposit args not decodable at op ${opIndex}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		if (args.length < 2) return
		const payer = String(args[0])
		const amountRaw = args[1]
		const amount =
			typeof amountRaw === "bigint"
				? amountRaw
				: typeof amountRaw === "number"
					? BigInt(amountRaw)
					: typeof amountRaw === "string"
						? BigInt(amountRaw)
						: null
		if (amount === null) return
		out.push({ opIndex, contractId, payer, amount })
	})
	return out
}

export function matchSingleVaultDeposit(input: {
	invokes: DecodedVaultDepositInvoke[]
	vaultId: string
	payer: string
	amountMinor: bigint
}): DecodedVaultDepositInvoke {
	const matches = input.invokes.filter(
		(d) =>
			d.contractId === input.vaultId &&
			d.payer === input.payer &&
			d.amount === input.amountMinor,
	)
	if (matches.length === 0) {
		throw new FundDepositVerifyError(
			"not_found",
			"no matching vault deposit invoke in transaction",
		)
	}
	if (matches.length > 1) {
		throw new FundDepositVerifyError(
			"ambiguous",
			"multiple matching vault deposit invokes in transaction",
		)
	}
	return matches[0]!
}
