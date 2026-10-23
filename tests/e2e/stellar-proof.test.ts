import { createHash } from "node:crypto"
import {
	Account,
	Keypair,
	Networks,
	Operation,
	StrKey,
	TransactionBuilder,
	xdr,
} from "@stellar/stellar-sdk"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AssertionFailure } from "../../scripts/demo/lib/assertions.ts"
import { BlockedError } from "../../scripts/demo/lib/report.ts"
import {
	parseContractInvocation,
	parseNetworkPassphrase,
	parseReturnValue,
	parseTransactionResult,
	verifyStellarTransaction,
	verifyVaultRelease,
} from "../../scripts/demo/lib/stellar-proof.ts"

// The verifier is what turns a 64-hex string into settlement evidence. These tests use a fake
// RPC; they never touch testnet.

const TESTNET = "Test SDF Network ; September 2015"
const HASH = "b".repeat(64)
const LOCK_HASH = "c".repeat(64)
const RELEASE_HASH = "d".repeat(64)
const VAULT = StrKey.encodeContract(Buffer.alloc(32, 7))
const source = Keypair.random()
const recipient = Keypair.random()
const otherRecipient = Keypair.random()

const contractAddress = (): xdr.ScAddress =>
	xdr.ScAddress.scAddressTypeContract(
		StrKey.decodeContract(VAULT) as unknown as xdr.Hash,
	)

const addressValue = (address: string): xdr.ScVal =>
	xdr.ScVal.scvAddress(
		xdr.ScAddress.scAddressTypeAccount(
			Keypair.fromPublicKey(address).xdrAccountId(),
		),
	)

const bytesValue = (hex: string): xdr.ScVal =>
	xdr.ScVal.scvBytes(Buffer.from(hex, "hex"))

const u64Value = (value: string): xdr.ScVal =>
	xdr.ScVal.scvU64(xdr.Uint64.fromString(value))

const envelope = (functionName: string, args: xdr.ScVal[]): string => {
	const invocation = new xdr.InvokeContractArgs({
		contractAddress: contractAddress(),
		functionName,
		args,
	})
	const host = xdr.HostFunction.hostFunctionTypeInvokeContract(invocation)
	const operation = Operation.invokeHostFunction({ func: host, auth: [] })
	const tx = new TransactionBuilder(new Account(source.publicKey(), "1"), {
		fee: "100",
		networkPassphrase: Networks.TESTNET,
	})
		.addOperation(operation)
		.setTimeout(30)
		.build()
	return tx.toEnvelope().toXDR("base64")
}

const resultMeta = (returnValue: xdr.ScVal): string => {
	const soroban = new xdr.SorobanTransactionMetaV2({
		ext: new xdr.SorobanTransactionMetaExt(0),
		returnValue,
	})
	const meta = new xdr.TransactionMetaV4({
		ext: new xdr.ExtensionPoint(0),
		txChangesBefore: [],
		operations: [],
		txChangesAfter: [],
		sorobanMeta: soroban,
		events: [],
		diagnosticEvents: [],
	})
	return new xdr.TransactionMeta(4, meta).toXDR("base64")
}

const externalId = (paymentId: string): string =>
	createHash("sha256").update(`${paymentId}:1`, "utf8").digest("hex")

const CLAIM_SECRET = "2".repeat(64)
const claimHash = (secret = CLAIM_SECRET): string =>
	createHash("sha256").update(Buffer.from(secret, "hex")).digest("hex")

const createPayoutArgs = (
	paymentId: string,
	secret = CLAIM_SECRET,
): xdr.ScVal[] => [
	addressValue(source.publicKey()),
	bytesValue(externalId(paymentId)),
	bytesValue(claimHash(secret)),
	u64Value("10000000"),
	// Soroban contract enums decode as a one-element vec of the variant symbol.
	xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("PayerPays")]),
	u64Value("2000000000"),
]

const claimArgs = (
	payoutId: string,
	to: string,
	secret = CLAIM_SECRET,
): xdr.ScVal[] => [u64Value(payoutId), bytesValue(secret), addressValue(to)]

const transaction = (
	envelopeXdr: string,
	resultMetaXdr: string,
	status = "SUCCESS",
	ledger = 100,
) => ({ status, ledger, envelopeXdr, resultMetaXdr })

const rpc = (byHash: Record<string, unknown>) =>
	vi.fn(async (_url: string, init: RequestInit) => {
		const { method, params } = JSON.parse(String(init.body)) as {
			method: string
			params: { hash?: string }
		}
		if (method === "getNetwork") return response({ passphrase: TESTNET })
		return response(
			byHash[params.hash ?? ""] ?? { status: "NOT_FOUND", ledger: 0 },
		)
	})

const response = (result: unknown): Response =>
	new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
		status: 200,
		headers: { "content-type": "application/json" },
	})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("Stellar RPC result parsing", () => {
	it("reads the passphrase and transaction result", () => {
		expect(parseNetworkPassphrase({ passphrase: TESTNET })).toBe(TESTNET)
		expect(parseTransactionResult({ status: "SUCCESS", ledger: 42 })).toEqual({
			status: "SUCCESS",
			ledger: 42,
		})
	})

	it("rejects a missing passphrase, status or ledger", () => {
		expect(() => parseNetworkPassphrase({})).toThrow(/no passphrase/)
		expect(() => parseTransactionResult({ ledger: 1 })).toThrow(/no status/)
		expect(() => parseTransactionResult({ status: "SUCCESS" })).toThrow(
			/no ledger/,
		)
	})
})

type ReleaseOptions = Parameters<typeof verifyVaultRelease>[0]

const releaseOptions = (
	overrides: Partial<ReleaseOptions> = {},
): ReleaseOptions => ({
	paymentId: "pay_demo_1",
	payoutId: "42",
	lockHash: LOCK_HASH,
	releaseHash: RELEASE_HASH,
	recipientAddress: recipient.publicKey(),
	vaultContractId: VAULT,
	principal: "10000000",
	feeMode: "PayerPays",
	fee: "50000",
	net: "10000000",
	rpcUrl: "https://rpc.example",
	networkPassphrase: TESTNET,
	timeoutMs: 1_000,
	...overrides,
})

const pairRpc = (
	options: {
		lockArgs?: xdr.ScVal[]
		releaseArgs?: xdr.ScVal[]
		releaseFunction?: string
		releaseStatus?: string
		lockReturn?: string
		releaseReturn?: string
		lockLedger?: number
		releaseLedger?: number
	} = {},
) => {
	const lockArgs = options.lockArgs ?? createPayoutArgs("pay_demo_1")
	const releaseArgs =
		options.releaseArgs ?? claimArgs("42", recipient.publicKey())
	return rpc({
		[LOCK_HASH]: transaction(
			envelope("create_payout", lockArgs),
			resultMeta(u64Value(options.lockReturn ?? "42")),
			"SUCCESS",
			options.lockLedger ?? 100,
		),
		[RELEASE_HASH]: transaction(
			envelope(options.releaseFunction ?? "claim", releaseArgs),
			resultMeta(u64Value(options.releaseReturn ?? "10000000")),
			options.releaseStatus,
			options.releaseLedger ?? 100,
		),
	})
}

describe("vault release proof", () => {
	it("decodes the contract invocation and the Soroban return value", () => {
		const release = envelope("claim", claimArgs("42", recipient.publicKey()))
		const invocation = parseContractInvocation(release, TESTNET)
		expect(invocation.functionName).toBe("claim")
		expect(invocation.contractId).toBe(VAULT)
		expect(invocation.args[0]).toBe(42n)
		expect(invocation.args[2]).toBe(recipient.publicKey())
		expect(parseReturnValue(resultMeta(u64Value("42")))).toBe(42n)
	})

	it("ties the release claim to the payment lock and intended recipient", async () => {
		const fetchMock = pairRpc()
		vi.stubGlobal("fetch", fetchMock)

		const proof = await verifyVaultRelease(releaseOptions())
		expect(proof).toEqual({
			hash: RELEASE_HASH,
			status: "SUCCESS",
			ledger: 100,
			passphrase: TESTNET,
			lockHash: LOCK_HASH,
			payoutId: "42",
			recipient: recipient.publicKey(),
			contractId: VAULT,
			principal: "10000000",
			feeMode: "PayerPays",
			fee: "50000",
			net: "10000000",
		})
		expect(fetchMock).toHaveBeenCalledTimes(3)
	})

	it("accepts RecipientPays only when the release returns P - f(P)", async () => {
		const recipientPaysArgs = [
			addressValue(source.publicKey()),
			bytesValue(externalId("pay_demo_1")),
			bytesValue(claimHash()),
			u64Value("10000000"),
			xdr.ScVal.scvSymbol("RecipientPays"),
			u64Value("2000000000"),
		]
		vi.stubGlobal(
			"fetch",
			pairRpc({ lockArgs: recipientPaysArgs, releaseReturn: "9950000" }),
		)
		const proof = await verifyVaultRelease(
			releaseOptions({ feeMode: "RecipientPays", net: "9950000" }),
		)
		expect(proof.net).toBe("9950000")
		expect(proof.fee).toBe("50000")

		vi.unstubAllGlobals()
		// the release result is net 10000000; a fee-paying recipient must receive 9995000
		vi.stubGlobal("fetch", pairRpc({ lockArgs: recipientPaysArgs }))
		await expect(
			verifyVaultRelease(
				releaseOptions({ feeMode: "RecipientPays", net: "9950000" }),
			),
		).rejects.toThrow(/release returned net 10000000/)
	})

	it("rejects frozen amounts that do not match the on-chain lock", async () => {
		vi.stubGlobal(
			"fetch",
			pairRpc({ lockArgs: createPayoutArgs("pay_demo_1") }),
		)
		await expect(
			verifyVaultRelease(releaseOptions({ principal: "9999999" })),
		).rejects.toThrow(/frozen settle amountIn/)
		await expect(
			verifyVaultRelease(releaseOptions({ feeMode: "RecipientPays" })),
		).rejects.toThrow(/does not match the quoted/)
		await expect(
			verifyVaultRelease(releaseOptions({ fee: "49999" })),
		).rejects.toThrow(/not f\(P\)/)
		await expect(
			verifyVaultRelease(releaseOptions({ net: "9995000" })),
		).rejects.toThrow(/frozen net 9995000 is not 10000000/)
	})

	it("rejects a payout id that is not the lock's payout", async () => {
		vi.stubGlobal("fetch", pairRpc({ lockReturn: "43" }))
		await expect(verifyVaultRelease(releaseOptions())).rejects.toThrow(
			/lock returned payout 43/,
		)
		vi.unstubAllGlobals()
		await expect(
			verifyVaultRelease(releaseOptions({ payoutId: "0" })),
		).rejects.toThrow(/not a positive decimal id/)
		vi.unstubAllGlobals()
		vi.stubGlobal("fetch", pairRpc())
		await expect(
			verifyVaultRelease(releaseOptions({ fee: "7" })),
		).rejects.toThrow(/not f\(P\)=floor\(P\*bps\/10000\)/)
		vi.unstubAllGlobals()
		vi.stubGlobal("fetch", pairRpc())
		await expect(
			verifyVaultRelease(releaseOptions({ vaultFeeBps: 50, fee: "1" })),
		).rejects.toThrow(/not f\(P\)=.*at deployed 50 bps/)
		vi.unstubAllGlobals()
	})

	it("rejects a release to another recipient", async () => {
		vi.stubGlobal(
			"fetch",
			pairRpc({ releaseArgs: claimArgs("42", otherRecipient.publicKey()) }),
		)
		await expect(verifyVaultRelease(releaseOptions())).rejects.toThrow(
			/expected the claimed recipient/,
		)
	})

	it("rejects a release of another payout", async () => {
		vi.stubGlobal(
			"fetch",
			pairRpc({ releaseArgs: claimArgs("43", recipient.publicKey()) }),
		)
		await expect(verifyVaultRelease(releaseOptions())).rejects.toThrow(
			/expected the lock payout 42/,
		)
	})

	it("rejects a lock created for another payment", async () => {
		vi.stubGlobal("fetch", pairRpc({ lockArgs: createPayoutArgs("pay_other") }))
		await expect(verifyVaultRelease(releaseOptions())).rejects.toThrow(/sha256/)
	})

	it("rejects a release secret that is not the lock's claim hash", async () => {
		vi.stubGlobal(
			"fetch",
			pairRpc({
				releaseArgs: claimArgs("42", recipient.publicKey(), "3".repeat(64)),
			}),
		)
		await expect(verifyVaultRelease(releaseOptions())).rejects.toThrow(
			/does not hash to the lock's claim hash/,
		)
	})

	it("rejects a release ledger before the lock ledger", async () => {
		vi.stubGlobal("fetch", pairRpc({ lockLedger: 100, releaseLedger: 99 }))
		await expect(verifyVaultRelease(releaseOptions())).rejects.toThrow(
			/cannot predate the lock/,
		)
	})

	it("rejects a release that is not a claim", async () => {
		vi.stubGlobal(
			"fetch",
			pairRpc({
				releaseFunction: "create_payout",
				releaseArgs: createPayoutArgs("pay_demo_1"),
			}),
		)
		await expect(verifyVaultRelease(releaseOptions())).rejects.toThrow(
			/expected claim/,
		)
	})

	it("rejects a failed release and a lock/release reuse", async () => {
		vi.stubGlobal("fetch", pairRpc({ releaseStatus: "FAILED" }))
		await expect(verifyVaultRelease(releaseOptions())).rejects.toThrow(
			/not SUCCESS/,
		)

		await expect(
			verifyVaultRelease(
				releaseOptions({ lockHash: RELEASE_HASH, releaseHash: RELEASE_HASH }),
			),
		).rejects.toThrow(/same transaction/)
	})
})

describe("verifyStellarTransaction", () => {
	it("proves a successful testnet transaction", async () => {
		const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
			const { method } = JSON.parse(String(init.body)) as { method: string }
			return response(
				method === "getNetwork"
					? { passphrase: TESTNET }
					: { status: "SUCCESS", ledger: 12345 },
			)
		})
		vi.stubGlobal("fetch", fetchMock)

		const proof = await verifyStellarTransaction({
			hash: HASH,
			rpcUrl: "https://rpc.example",
			networkPassphrase: TESTNET,
			timeoutMs: 1_000,
		})
		expect(proof).toEqual({
			hash: HASH,
			status: "SUCCESS",
			ledger: 12345,
			passphrase: TESTNET,
		})
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it("rejects a transaction from another network", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				response({
					passphrase: "Public Global Stellar Network ; September 2015",
				}),
			),
		)

		await expect(
			verifyStellarTransaction({
				hash: HASH,
				rpcUrl: "https://rpc.example",
				networkPassphrase: TESTNET,
				timeoutMs: 1_000,
			}),
		).rejects.toThrow(/expected the configured testnet/)
	})

	it("rejects a hash the chain does not know or did not succeed", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				const { method } = JSON.parse(String(init.body)) as { method: string }
				return response(
					method === "getNetwork"
						? { passphrase: TESTNET }
						: { status: "NOT_FOUND", ledger: 0 },
				)
			}),
		)

		await expect(
			verifyStellarTransaction({
				hash: HASH,
				rpcUrl: "https://rpc.example",
				networkPassphrase: TESTNET,
				timeoutMs: 1_000,
			}),
		).rejects.toBeInstanceOf(AssertionFailure)
	})

	it("blocks when the RPC cannot be reached", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed")
			}),
		)

		await expect(
			verifyStellarTransaction({
				hash: HASH,
				rpcUrl: "https://rpc.example",
				networkPassphrase: TESTNET,
				timeoutMs: 1_000,
			}),
		).rejects.toBeInstanceOf(BlockedError)
	})
})
