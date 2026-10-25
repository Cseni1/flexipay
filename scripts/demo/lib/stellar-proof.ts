import { createHash } from "node:crypto"
import type { FeeMode } from "@flexipay/domain"
import {
	FeeBumpTransaction,
	StrKey,
	TransactionBuilder,
	contract,
	scValToNative,
	xdr,
} from "@stellar/stellar-sdk"
import { AssertionFailure, fail } from "./assertions.ts"
import { BlockedError } from "./report.ts"
import type { PaymentView, QuoteView } from "./types.ts"

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
	/** The vault’s token contract, read from on-chain config(), not a caller setting. */
	assetContractId: string
	/** Fixed vault fee in bps, read from on-chain config(). */
	vaultFeeBps: number
	/** Fixed vault treasury, read from on-chain config(). */
	treasuryAddress: string
	/** Lock input principal P (settle amountIn), from create_payout (CCR-13). */
	principal: string
	feeMode: FeeMode
	fee: string
	/** Release return value: P for PayerPays, P − fee for RecipientPays. */
	net: string
	/** The matching on-chain token transfer to the recipient (asset proof). */
	transfer: TokenTransfer
}

export interface VaultConfig {
	token: string
	treasury: string
	feeBps: number
}

export interface TokenTransfer {
	contractId: string
	from: string
	to: string
	amount: string
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

// Soroban encodes a contract enum as a one-element vec of its variant symbol, e.g.
// `FeeMode::PayerPays` arrives as ["PayerPays"]. A bare symbol is accepted as well.
const nativeSymbol = (value: unknown, where: string): string => {
	if (typeof value === "string" && value.length > 0) return value
	if (
		Array.isArray(value) &&
		value.length === 1 &&
		typeof value[0] === "string" &&
		value[0].length > 0
	) {
		return value[0]
	}
	return fail(`${where}: expected a contract symbol`)
}

export const vaultExternalId = (paymentId: string, attempt = 1): string =>
	createHash("sha256").update(`${paymentId}:${attempt}`, "utf8").digest("hex")

const secretHash = (secretHex: string): string =>
	createHash("sha256").update(Buffer.from(secretHex, "hex")).digest("hex")

export function parseVaultConfig(value: unknown): VaultConfig {
	if (!Array.isArray(value) || value.length !== 3) {
		fail("vault config() did not return (token, treasury, fee_bps)")
	}
	const [token, treasury, feeBps] = value
	if (typeof token !== "string" || !StrKey.isValidContract(token)) {
		fail("vault config() token is not a Stellar contract address")
	}
	if (
		typeof treasury !== "string" ||
		!StrKey.isValidEd25519PublicKey(treasury)
	) {
		fail("vault config() treasury is not a Stellar account address")
	}
	if (
		typeof feeBps !== "number" ||
		!Number.isInteger(feeBps) ||
		feeBps < 0 ||
		feeBps > 1000
	) {
		fail(`vault config() fee_bps ${String(feeBps)} is outside 0..1000`)
	}
	return { token, treasury, feeBps }
}

function metaEvents(meta: xdr.TransactionMeta): xdr.ContractEvent[] {
	const events: xdr.ContractEvent[] = []
	const version = meta.switch()
	if (version === 3) {
		const soroban = meta.v3().sorobanMeta()
		if (soroban) events.push(...soroban.events())
	} else if (version === 4) {
		const v4 = meta.v4()
		events.push(...v4.events().map((event) => event.event()))
		for (const operation of v4.operations()) {
			events.push(...operation.events())
		}
	}
	return events
}

/** Decodes token-transfer events from result meta; no API field is used for asset proof. */
export function parseTokenTransfers(resultMetaXdr: string): TokenTransfer[] {
	let meta: xdr.TransactionMeta
	try {
		meta = xdr.TransactionMeta.fromXDR(resultMetaXdr, "base64")
	} catch (error) {
		throw new AssertionFailure(
			`transaction resultMetaXdr is not valid XDR: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	const out: TokenTransfer[] = []
	const seen = new Set<string>()
	for (const event of metaEvents(meta)) {
		const encoded = event.toXDR("base64")
		if (seen.has(encoded)) continue
		seen.add(encoded)
		const contractId = event.contractId()
		if (!contractId) continue
		const body = event.body()
		if (body.switch() !== 0) continue
		const v0 = body.v0()
		const topics = v0.topics()
		// SAC transfer events carry [transfer, from, to] and may append the classic asset line.
		if (topics.length < 3) continue
		const kind = scValToNative(topics[0])
		if (kind !== "transfer") continue
		const from = nativeEventAddress(topics[1], "token transfer from")
		const to = nativeEventAddress(topics[2], "token transfer to")
		const amount = scValToNative(v0.data())
		if (typeof amount !== "bigint" || amount < 0n) {
			fail("token transfer event has no non-negative integer amount")
		}
		out.push({
			contractId: StrKey.encodeContract(contractId as unknown as Buffer),
			from,
			to,
			amount: amount.toString(),
		})
	}
	return out
}

const nativeEventAddress = (value: xdr.ScVal, where: string): string => {
	const decoded = scValToNative(value)
	if (typeof decoded === "string" && decoded.length > 0) return decoded
	return fail(`${where}: expected a Stellar address`)
}

interface ContractReader {
	config(): Promise<{ result: unknown }>
	payout_by_external(args: {
		payer: string
		external_id: Buffer
	}): Promise<{ result: unknown }>
}

function contractResult(value: unknown, where: string): unknown {
	if (
		typeof value === "object" &&
		value !== null &&
		"isErr" in value &&
		typeof (value as { isErr?: unknown }).isErr === "function"
	) {
		const result = value as {
			isErr(): boolean
			unwrap(): unknown
			unwrapErr?(): unknown
		}
		if (result.isErr()) {
			fail(`${where}: contract call returned an error`)
		}
		return result.unwrap()
	}
	return value
}

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	what: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(
				new BlockedError([
					{
						what: `${what} timed out after ${timeoutMs}ms`,
						owner: "Stellar RPC / integration",
					},
				]),
			)
		}, timeoutMs)
	})
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer)
	})
}

async function contractReader(options: {
	vaultContractId: string
	rpcUrl: string
	networkPassphrase: string
}): Promise<ContractReader> {
	return (await contract.Client.from({
		contractId: options.vaultContractId,
		rpcUrl: options.rpcUrl,
		networkPassphrase: options.networkPassphrase,
	})) as unknown as ContractReader
}

/** Reads the vault's fixed token, treasury and fee from the contract, not from env. */
export async function readVaultConfig(options: {
	vaultContractId: string
	rpcUrl: string
	networkPassphrase: string
	timeoutMs: number
}): Promise<VaultConfig> {
	if (!StrKey.isValidContract(options.vaultContractId)) {
		fail(`configured vault id is not a Stellar contract address`)
	}
	let tx: { result: unknown }
	try {
		tx = await withTimeout(
			(async () => {
				const reader = await contractReader(options)
				return reader.config()
			})(),
			options.timeoutMs,
			"vault config()",
		)
	} catch (error) {
		if (error instanceof BlockedError) throw error
		throw new BlockedError([
			{
				what: `vault config() is unavailable: ${error instanceof Error ? error.message : String(error)}`,
				owner: "Stellar RPC / integration",
			},
		])
	}
	return parseVaultConfig(contractResult(tx.result, "vault config()"))
}

/** On-chain lookup by (payer, external id); used to prove a domestic row has no lock. */
export async function readVaultPayoutByExternal(options: {
	vaultContractId: string
	payerAddress: string
	externalIdHex: string
	rpcUrl: string
	networkPassphrase: string
	timeoutMs: number
}): Promise<string | undefined> {
	if (!StrKey.isValidContract(options.vaultContractId)) {
		fail(`configured vault id is not a Stellar contract address`)
	}
	if (!StrKey.isValidEd25519PublicKey(options.payerAddress)) {
		fail("payer address is not a Stellar account address")
	}
	if (!/^[0-9a-fA-F]{64}$/.test(options.externalIdHex)) {
		fail("external id must be 32 bytes")
	}
	let tx: { result: unknown }
	try {
		tx = await withTimeout(
			(async () => {
				const reader = await contractReader(options)
				return reader.payout_by_external({
					payer: options.payerAddress,
					external_id: Buffer.from(options.externalIdHex, "hex"),
				})
			})(),
			options.timeoutMs,
			"vault payout_by_external()",
		)
	} catch (error) {
		if (error instanceof BlockedError) throw error
		throw new BlockedError([
			{
				what: `vault payout_by_external() is unavailable: ${error instanceof Error ? error.message : String(error)}`,
				owner: "Stellar RPC / integration",
			},
		])
	}
	const value = contractResult(tx.result, "vault payout_by_external()")
	if (value === null || value === undefined) return undefined
	return nativeId(value, "vault payout_by_external()")
}

/**
 * H3: verifies a paid direct/claim payment's lock and release against the frozen quote and the
 * vault's on-chain token/fee config. Missing refs are BLOCKED; contradictory data is FAIL.
 */
export async function verifyVaultPayment(options: {
	payment: PaymentView
	quote: QuoteView
	recipientAddress: string
	vaultContractId: string
	expectedAssetContractId: string
	rpcUrl: string
	networkPassphrase: string
	timeoutMs: number
}): Promise<VaultReleaseProof> {
	if (options.payment.status !== "paid") {
		fail(
			`payment ${options.payment.id} is ${options.payment.status}, expected paid`,
		)
	}
	const settle = options.payment.legs.find((leg) => leg.kind === "settle")
	if (!settle) fail(`payment ${options.payment.id} has no settle leg`)
	if (settle.status !== "succeeded") {
		fail(
			`payment ${options.payment.id} settle leg is ${settle.status}, not succeeded`,
		)
	}
	const quoteSettle = options.quote.route.find((leg) => leg.kind === "settle")
	if (!quoteSettle?.amountIn || !quoteSettle.amountOut) {
		fail(`quote ${options.quote.id} has no frozen settle amounts`)
	}
	if (!options.quote.feeMode) {
		fail(`quote ${options.quote.id} has no feeMode`)
	}
	if (!options.quote.fees)
		fail(`quote ${options.quote.id} has no fee breakdown`)
	if (!settle.amountIn || !settle.amountOut) {
		fail(`payment ${options.payment.id} settle leg has no frozen amounts`)
	}
	if (
		settle.amountIn.amount !== quoteSettle.amountIn.amount ||
		settle.amountIn.currency !== quoteSettle.amountIn.currency ||
		settle.amountOut.amount !== quoteSettle.amountOut.amount ||
		settle.amountOut.currency !== quoteSettle.amountOut.currency
	) {
		fail(
			`payment ${options.payment.id} settle amounts do not match quote ${options.quote.id}`,
		)
	}
	if (!settle.externalRef) {
		throw new BlockedError([
			{
				what: `payment ${options.payment.id} has no settle payoutId`,
				owner: "CC2 / integration",
				detail: "CCR-12 requires settle.externalRef",
			},
		])
	}
	if (!settle.lockTxRef) {
		throw new BlockedError([
			{
				what: `payment ${options.payment.id} has no settle lockTxRef`,
				owner: "CC2 / integration",
				detail: "CCR-12 requires lockTxRef",
			},
		])
	}
	if (!settle.releaseTxRef) {
		throw new BlockedError([
			{
				what: `payment ${options.payment.id} has no settle releaseTxRef`,
				owner: "CC2 / integration",
				detail: "CCR-12 requires releaseTxRef for a paid payment",
			},
		])
	}
	return verifyVaultRelease({
		paymentId: options.payment.id,
		payoutId: settle.externalRef,
		lockHash: settle.lockTxRef,
		releaseHash: settle.releaseTxRef,
		recipientAddress: options.recipientAddress,
		vaultContractId: options.vaultContractId,
		principal: settle.amountIn.amount,
		feeMode: options.quote.feeMode,
		fee: options.quote.fees.flexiPayFee.amount,
		net: quoteSettle.amountOut.amount,
		expectedAssetContractId: options.expectedAssetContractId,
		rpcUrl: options.rpcUrl,
		networkPassphrase: options.networkPassphrase,
		timeoutMs: options.timeoutMs,
	})
}

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
export async function verifyVaultReleaseWithConfig(options: {
	paymentId: string
	/** CCR-12: settle.externalRef, the vault payoutId returned by the lock. */
	payoutId: string
	lockHash: string
	releaseHash: string
	recipientAddress: string
	vaultContractId: string
	/** Public testnet asset id; must equal the vault's on-chain config token. */
	expectedAssetContractId: string
	/** Read from vault config() by the caller, never from a caller-selected fee env. */
	vaultConfig: VaultConfig
	/** CCR-13 frozen settle principal, fee mode, fee and net from quote/payment. */
	principal: string
	feeMode: FeeMode
	fee: string
	net: string
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
	if (!StrKey.isValidContract(options.expectedAssetContractId)) {
		fail(`expected asset id is not a Stellar contract address`)
	}
	if (options.vaultConfig.token !== options.expectedAssetContractId) {
		fail(
			`vault config token ${options.vaultConfig.token} is not the expected asset ${options.expectedAssetContractId}`,
		)
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
	const expectedExternalId = vaultExternalId(options.paymentId)
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

	// Frozen quote fee (CCR-13), checked against the fixed bps in the vault's on-chain config.
	const principalMinor = BigInt(options.principal)
	const feeMinor = BigInt(options.fee)
	const bps = options.vaultConfig.feeBps
	if (!Number.isInteger(bps) || bps < 0 || bps > 1000) {
		fail(`vault fee bps ${bps} is outside 0..1000`)
	}
	const computedFee = ((principalMinor * BigInt(bps)) / 10_000n).toString()
	if (computedFee !== options.fee) {
		fail(
			`frozen fee ${options.fee} is not f(P)=${computedFee} at on-chain ${bps} bps`,
		)
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

	// Asset/net must be proven from token-transfer metadata. If the release has no transfer
	// events at all, this is an evidence gap (BLOCKED / NOT VERIFIED), not a pass.
	const transfers = parseTokenTransfers(release.resultMetaXdr)
	if (transfers.length === 0) {
		throw new BlockedError([
			{
				what: "NOT VERIFIED: release transaction has no token-transfer event; asset and net are not proven",
				owner: "Stellar RPC / transaction metadata",
				detail: `release ${options.releaseHash}`,
			},
		])
	}
	const transfer = transfers.find(
		(candidate) =>
			candidate.contractId === options.expectedAssetContractId &&
			candidate.from === options.vaultContractId &&
			candidate.to === options.recipientAddress &&
			candidate.amount === net,
	)
	if (!transfer) {
		fail(
			`release has no ${options.expectedAssetContractId} transfer from vault ${options.vaultContractId} to ${options.recipientAddress} for ${net}`,
		)
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
		assetContractId: options.vaultConfig.token,
		vaultFeeBps: options.vaultConfig.feeBps,
		treasuryAddress: options.vaultConfig.treasury,
		principal,
		feeMode,
		fee: options.fee,
		net,
		transfer,
	}
}

/** Reads the vault config from chain, then verifies the payment against it. */
export async function verifyVaultRelease(options: {
	paymentId: string
	payoutId: string
	lockHash: string
	releaseHash: string
	recipientAddress: string
	vaultContractId: string
	expectedAssetContractId: string
	principal: string
	feeMode: FeeMode
	fee: string
	net: string
	rpcUrl: string
	networkPassphrase: string
	timeoutMs: number
}): Promise<VaultReleaseProof> {
	const vaultConfig = await readVaultConfig({
		vaultContractId: options.vaultContractId,
		rpcUrl: options.rpcUrl,
		networkPassphrase: options.networkPassphrase,
		timeoutMs: options.timeoutMs,
	})
	return verifyVaultReleaseWithConfig({ ...options, vaultConfig })
}
