import { createHash } from "node:crypto"
import type { FeeMode } from "@flexipay/domain"
import {
	FeeBumpTransaction,
	StrKey,
	TransactionBuilder,
	scValToNative,
	xdr,
} from "@stellar/stellar-sdk"
import { AssertionFailure, fail } from "./assertions.ts"
import { BlockedError } from "./report.ts"

// A 64-hex string only looks like a Stellar hash. DF3 proves the vault release, not merely a
// successful transaction: the lock must be a create_payout for this payment, and the release must
// be the claim of that same payout to the intended recipient. `getTransaction` returns the
// envelope and result meta needed for both checks; no API field is invented.

export interface StellarProof {
	hash: string
	status: string
	ledger: number
	/** Passphrase reported by the RPC, compared with the configured testnet passphrase. */
	passphrase: string
}

export interface VaultReleaseProof extends StellarProof {
	lockHash: string
	payoutId: string
	recipient: string
	contractId: string
	/** Lock input principal P (settle amountIn), from create_payout (CCR-13). */
	principal: string
	feeMode: FeeMode
	fee: string
	/** Release return value: P for PayerPays, P − fee for RecipientPays. */
	net: string
}

export interface ContractInvocation {
	functionName: string
	contractId: string
	args: unknown[]
}

interface JsonRpcError {
	message?: string
}

interface TransactionEvidence {
	status: string
	ledger: number
	envelopeXdr: string
	resultMetaXdr: string
}

const call = async (
	url: string,
	method: string,
	params: Record<string, unknown>,
	timeoutMs: number,
): Promise<unknown> => {
	let response: Response
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
			signal: AbortSignal.timeout(timeoutMs),
		})
	} catch (error) {
		throw new BlockedError([
			{
				what: `Stellar RPC ${method} is unreachable`,
				owner: "caller / Csaba (integration)",
				detail: error instanceof Error ? error.message : String(error),
			},
		])
	}
	let body: { result?: unknown; error?: JsonRpcError }
	try {
		body = (await response.json()) as typeof body
	} catch {
		throw new AssertionFailure(`Stellar RPC ${method} returned a non-JSON body`)
	}
	if (body.error) {
		throw new AssertionFailure(
			`Stellar RPC ${method}: ${body.error.message ?? "request failed"}`,
		)
	}
	if (!response.ok)
		throw new AssertionFailure(
			`Stellar RPC ${method} returned HTTP ${response.status}`,
		)
	return body.result
}

export function parseNetworkPassphrase(result: unknown): string {
	if (typeof result !== "object" || result === null)
		fail("RPC getNetwork returned no result")
	const passphrase = (result as { passphrase?: unknown }).passphrase
	if (typeof passphrase !== "string" || passphrase.length === 0)
		fail("RPC getNetwork returned no passphrase")
	return passphrase
}

export function parseTransactionResult(result: unknown): {
	status: string
	ledger: number
} {
	if (typeof result !== "object" || result === null)
		fail("RPC getTransaction returned no result")
	const { status, ledger } = result as { status?: unknown; ledger?: unknown }
	if (typeof status !== "string") fail("RPC getTransaction returned no status")
	if (typeof ledger !== "number") fail("RPC getTransaction returned no ledger")
	return { status, ledger }
}

function parseTransactionEvidence(
	result: unknown,
	label: string,
): TransactionEvidence {
	const { status, ledger } = parseTransactionResult(result)
	if (status !== "SUCCESS") {
		fail(`${label} transaction is ${status}, not SUCCESS`)
	}
	const record = result as {
		envelopeXdr?: unknown
		resultMetaXdr?: unknown
	}
	if (
		typeof record.envelopeXdr !== "string" ||
		record.envelopeXdr.length === 0
	) {
		fail(`${label} getTransaction returned no envelopeXdr`)
	}
	if (
		typeof record.resultMetaXdr !== "string" ||
		record.resultMetaXdr.length === 0
	) {
		fail(`${label} getTransaction returned no resultMetaXdr`)
	}
	return {
		status,
		ledger,
		envelopeXdr: record.envelopeXdr,
		resultMetaXdr: record.resultMetaXdr,
	}
}

/** Decodes one Soroban contract invocation from the transaction envelope. */
export function parseContractInvocation(
	envelopeXdr: string,
	networkPassphrase: string,
): ContractInvocation {
	let parsed: unknown
	try {
		parsed = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase)
	} catch (error) {
		throw new AssertionFailure(
			`transaction envelope is not valid XDR: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	const transaction =
		parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed
	if (
		typeof transaction !== "object" ||
		transaction === null ||
		!("operations" in transaction) ||
		!Array.isArray(transaction.operations)
	) {
		throw new AssertionFailure("transaction envelope has no operations")
	}
	if (transaction.operations.length !== 1) {
		fail(
			`transaction has ${transaction.operations.length} operations, expected one contract invocation`,
		)
	}
	const operation = transaction.operations[0]
	if (
		!operation ||
		operation.type !== "invokeHostFunction" ||
		!operation.func
	) {
		fail("transaction is not a Soroban contract invocation")
	}
	const hostFunction = operation.func
	if (hostFunction.switch().name !== "hostFunctionTypeInvokeContract") {
		fail("transaction host function is not an invokeContract")
	}
	const invoke = hostFunction.invokeContract()
	const address = invoke.contractAddress()
	if (address.switch().name !== "scAddressTypeContract") {
		fail("invocation target is not a contract address")
	}
	const contractId = StrKey.encodeContract(address.contractId())
	const functionName = invoke.functionName().toString("utf8")
	if (functionName.length === 0)
		fail("contract invocation has no function name")
	let args: unknown[]
	try {
		args = invoke.args().map((arg: xdr.ScVal) => scValToNative(arg))
	} catch (error) {
		throw new AssertionFailure(
			`contract invocation arguments are not decodable: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	return { functionName, contractId, args }
}

/** The Soroban return value from transaction result meta (protocol 23 uses v3/v4). */
export function parseReturnValue(resultMetaXdr: string): unknown {
	let meta: xdr.TransactionMeta
	try {
		meta = xdr.TransactionMeta.fromXDR(resultMetaXdr, "base64")
	} catch (error) {
		throw new AssertionFailure(
			`transaction resultMetaXdr is not valid XDR: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	const version = meta.switch()
	const soroban =
		version === 3
			? meta.v3().sorobanMeta()
			: version === 4
				? meta.v4().sorobanMeta()
				: undefined
	if (!soroban) {
		fail(
			`transaction resultMeta version ${version} has no Soroban return value`,
		)
	}
	const returnValue = soroban.returnValue()
	if (!returnValue) fail("transaction resultMeta has no Soroban return value")
	try {
		return scValToNative(returnValue)
	} catch (error) {
		throw new AssertionFailure(
			`Soroban return value is not decodable: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

const nativeId = (value: unknown, where: string): string => {
	if (typeof value === "bigint" && value >= 0n) return value.toString()
	if (typeof value === "number" && Number.isInteger(value) && value >= 0)
		return String(value)
	if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return value
	return fail(`${where}: expected a non-negative integer payout id`)
}

const nativeHex = (value: unknown, where: string): string => {
	if (value instanceof Uint8Array) return Buffer.from(value).toString("hex")
	if (typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value)) {
		return value.toLowerCase()
	}
	return fail(`${where}: expected 32 bytes`)
}

const nativeAddress = (value: unknown, where: string): string => {
	if (typeof value === "string" && StrKey.isValidEd25519PublicKey(value)) {
		return value
	}
	return fail(`${where}: expected a Stellar account address`)
}

const nativeSymbol = (value: unknown, where: string): string => {
	if (typeof value === "string" && value.length > 0) return value
	return fail(`${where}: expected a contract symbol`)
}

const lockExternalId = (paymentId: string, attempt = 1): string =>
	createHash("sha256").update(`${paymentId}:${attempt}`, "utf8").digest("hex")

const secretHash = (secretHex: string): string =>
	createHash("sha256").update(Buffer.from(secretHex, "hex")).digest("hex")

/** Verifies that `hash` is a successful transaction on the configured testnet. */
export async function verifyStellarTransaction(options: {
	hash: string
	rpcUrl: string
	networkPassphrase: string
	timeoutMs: number
}): Promise<StellarProof> {
	const passphrase = parseNetworkPassphrase(
		await call(options.rpcUrl, "getNetwork", {}, options.timeoutMs),
	)
	if (passphrase !== options.networkPassphrase) {
		fail(
			`RPC reports network "${passphrase}", expected the configured testnet passphrase`,
		)
	}

	const result = await call(
		options.rpcUrl,
		"getTransaction",
		{ hash: options.hash },
		options.timeoutMs,
	)
	const { status, ledger } = parseTransactionResult(result)
	if (status !== "SUCCESS") {
		fail(`testnet transaction ${options.hash} is ${status}, not SUCCESS`)
	}
	return { hash: options.hash, status, ledger, passphrase }
}

/**
 * Proves the release is the vault claim of the lock created for this payment, paid to
 * `recipientAddress`:
 * - lock: create_payout on the configured vault, external id = sha256("<paymentId>:1"),
 *   result payout id P;
 * - release: claim(P, …, recipientAddress) on the same vault.
 * Both transactions must be SUCCESS, distinct, and on the configured testnet.
 */
export async function verifyVaultRelease(options: {
	paymentId: string
	/** CCR-12: settle.externalRef, the vault payoutId returned by the lock. */
	payoutId: string
	lockHash: string
	releaseHash: string
	recipientAddress: string
	vaultContractId: string
	/** CCR-13 frozen settle principal, fee mode, fee and net from quote/payment. */
	principal: string
	feeMode: FeeMode
	fee: string
	net: string
	/**
	 * Deployed vault fee bps from public testnet evidence (`testnet-ids.env`). When set, fee must
	 * equal f(P) at that rate. When omitted, fee must equal f(P) for some 0..1000 bps (mock).
	 * Never a caller-chosen acceptance env override.
	 */
	vaultFeeBps?: number
	rpcUrl: string
	networkPassphrase: string
	timeoutMs: number
}): Promise<VaultReleaseProof> {
	if (options.lockHash === options.releaseHash) {
		fail(
			"lock and release are the same transaction; a claim cannot be its own lock",
		)
	}
	if (!StrKey.isValidContract(options.vaultContractId)) {
		fail(`configured vault id is not a Stellar contract address`)
	}
	// Adapter returns vault u64 ids via BigInt.toString() (decimal). Reject hashes/labels.
	if (!/^[1-9][0-9]*$/.test(options.payoutId)) {
		fail(`settle payoutId "${options.payoutId}" is not a positive decimal id`)
	}

	const passphrase = parseNetworkPassphrase(
		await call(options.rpcUrl, "getNetwork", {}, options.timeoutMs),
	)
	if (passphrase !== options.networkPassphrase) {
		fail(
			`RPC reports network "${passphrase}", expected the configured testnet passphrase`,
		)
	}

	const lock = parseTransactionEvidence(
		await call(
			options.rpcUrl,
			"getTransaction",
			{ hash: options.lockHash },
			options.timeoutMs,
		),
		"lock",
	)
	const release = parseTransactionEvidence(
		await call(
			options.rpcUrl,
			"getTransaction",
			{ hash: options.releaseHash },
			options.timeoutMs,
		),
		"release",
	)

	const lockInvocation = parseContractInvocation(lock.envelopeXdr, passphrase)
	if (lockInvocation.contractId !== options.vaultContractId) {
		fail(
			`lock invokes ${lockInvocation.contractId}, expected vault ${options.vaultContractId}`,
		)
	}
	if (lockInvocation.functionName !== "create_payout") {
		fail(`lock invokes ${lockInvocation.functionName}, expected create_payout`)
	}
	if (lockInvocation.args.length < 5) {
		fail(
			"lock create_payout has no external id, claim hash, amount or fee mode",
		)
	}
	const expectedExternalId = lockExternalId(options.paymentId)
	const seenExternalId = nativeHex(lockInvocation.args[1], "lock external id")
	if (seenExternalId !== expectedExternalId) {
		fail(
			`lock external id ${seenExternalId} is not sha256("${options.paymentId}:1")`,
		)
	}
	const lockClaimHash = nativeHex(lockInvocation.args[2], "lock claim hash")
	const payoutId = nativeId(
		parseReturnValue(lock.resultMetaXdr),
		"lock return value",
	)
	if (payoutId !== options.payoutId) {
		fail(
			`lock returned payout ${payoutId}, but settle.externalRef is ${options.payoutId}`,
		)
	}
	const principal = nativeId(lockInvocation.args[3], "lock principal")
	if (principal !== options.principal) {
		fail(
			`lock principal ${principal} does not match the frozen settle amountIn ${options.principal}`,
		)
	}
	const feeMode = nativeSymbol(lockInvocation.args[4], "lock fee mode")
	if (feeMode !== options.feeMode) {
		fail(
			`lock fee mode ${feeMode} does not match the quoted ${options.feeMode}`,
		)
	}

	// Frozen quote fee (CCR-13). Against deployed evidence use that bps; otherwise any 0..1000.
	const principalMinor = BigInt(options.principal)
	const feeMinor = BigInt(options.fee)
	if (options.vaultFeeBps !== undefined) {
		const bps = options.vaultFeeBps
		if (!Number.isInteger(bps) || bps < 0 || bps > 1000) {
			fail(`vault fee bps ${bps} is outside 0..1000`)
		}
		const computedFee = ((principalMinor * BigInt(bps)) / 10_000n).toString()
		if (computedFee !== options.fee) {
			fail(
				`frozen fee ${options.fee} is not f(P)=${computedFee} at deployed ${bps} bps`,
			)
		}
	} else {
		let feeMatchesVaultMath = false
		for (let bps = 0; bps <= 1000; bps++) {
			if ((principalMinor * BigInt(bps)) / 10_000n === feeMinor) {
				feeMatchesVaultMath = true
				break
			}
		}
		if (!feeMatchesVaultMath) {
			fail(
				`frozen fee ${options.fee} is not f(P)=floor(P*bps/10000) for any vault fee 0..1000 bps`,
			)
		}
	}
	const computedNet =
		options.feeMode === "PayerPays"
			? options.principal
			: (principalMinor - feeMinor).toString()
	if (computedNet !== options.net) {
		fail(
			`frozen net ${options.net} is not ${computedNet} for ${options.feeMode}`,
		)
	}

	if (release.ledger < 1 || lock.ledger < 1) {
		fail("lock and release must be included in a ledger")
	}
	if (release.ledger < lock.ledger) {
		fail(
			`release ledger ${release.ledger} precedes lock ledger ${lock.ledger}; the claim cannot predate the lock`,
		)
	}

	const releaseInvocation = parseContractInvocation(
		release.envelopeXdr,
		passphrase,
	)
	if (releaseInvocation.contractId !== options.vaultContractId) {
		fail(
			`release invokes ${releaseInvocation.contractId}, expected vault ${options.vaultContractId}`,
		)
	}
	if (releaseInvocation.functionName !== "claim") {
		fail(`release invokes ${releaseInvocation.functionName}, expected claim`)
	}
	if (releaseInvocation.args.length < 3) {
		fail("release claim has no payout id, secret or destination argument")
	}
	const releasedPayoutId = nativeId(
		releaseInvocation.args[0],
		"release payout id",
	)
	if (releasedPayoutId !== payoutId) {
		fail(
			`release claims payout ${releasedPayoutId}, expected the lock payout ${payoutId}`,
		)
	}
	const releaseSecret = nativeHex(releaseInvocation.args[1], "release secret")
	if (secretHash(releaseSecret) !== lockClaimHash) {
		fail(
			"release secret does not hash to the lock's claim hash; this is not the claim of this payment's payout",
		)
	}
	const recipient = nativeAddress(
		releaseInvocation.args[2],
		"release destination",
	)
	if (recipient !== options.recipientAddress) {
		fail(`release pays ${recipient}, expected the claimed recipient address`)
	}
	const net = nativeId(
		parseReturnValue(release.resultMetaXdr),
		"release return value",
	)
	if (net !== computedNet) {
		fail(`release returned net ${net}, expected ${computedNet}`)
	}

	return {
		hash: options.releaseHash,
		status: release.status,
		ledger: release.ledger,
		passphrase,
		lockHash: options.lockHash,
		payoutId,
		recipient,
		contractId: options.vaultContractId,
		principal,
		feeMode,
		fee: options.fee,
		net,
	}
}
