import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FundDepositVerifyError,
	SettlementError,
	money,
} from "@flexipay/domain";
import {
	Account,
	Keypair,
	Networks,
	Operation,
	StrKey,
	TransactionBuilder,
	nativeToScVal,
} from "@stellar/stellar-sdk";
import { Api, Server } from "@stellar/stellar-sdk/rpc";
import { StellarSettlementAdapter } from "../src/settlement.ts";
import { CustodialDemoWalletProvider } from "../src/demo-wallets.ts";
import type { Payout, PayoutVault } from "../src/vault-client.ts";
import { VaultError } from "../src/vault-errors.ts";
import { externalIdFor } from "../src/vault-math.ts";

const VAULT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
const OTHER_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 8));
const payerKp = Keypair.random();
const workerA = Keypair.random();
const workerB = Keypair.random();
const PAYER = payerKp.publicKey();

const walletEnv = {
	FP_PAYER_DEMO_ADDRESS: PAYER,
	FP_PAYER_DEMO_SECRET: payerKp.secret(),
	FP_RECIPIENT_A_ADDRESS: workerA.publicKey(),
	FP_RECIPIENT_A_SECRET: workerA.secret(),
	FP_RECIPIENT_B_ADDRESS: workerB.publicKey(),
	FP_RECIPIENT_B_SECRET: workerB.secret(),
};
const wallets = CustodialDemoWalletProvider.fromEnv(walletEnv);

const HASH32 = "ab".repeat(32);
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

function payout(overrides: Partial<Payout> = {}): Payout {
	return {
		id: 5n,
		payer: PAYER,
		externalId: Buffer.alloc(32, 1),
		claimHash: Buffer.alloc(32, 2),
		gross: 100_0000000n,
		fee: 1_0000000n,
		net: 99_0000000n,
		locked: 100_0000000n,
		expiresAt: nowSec() + 3600n,
		status: "Pending",
		...overrides,
	};
}

function fakeVault(overrides: Record<string, unknown> = {}) {
	return {
		feeBps: vi.fn(async () => 100),
		deposit: vi.fn(async () => ({ result: undefined, txHash: "DEPOSIT_HASH" })),
		createPayout: vi.fn(async () => ({ result: 5n, txHash: "LOCK_HASH" })),
		claim: vi.fn(async () => ({ result: 99_0000000n, txHash: "CLAIM_HASH" })),
		cancel: vi.fn(async () => ({ result: undefined, txHash: "CANCEL_HASH" })),
		refund: vi.fn(async () => ({ result: undefined, txHash: "REFUND_HASH" })),
		getPayout: vi.fn(async () => payout()),
		payoutByExternal: vi.fn(async () => 5n as bigint | undefined),
		...overrides,
	};
}

function adapter(
	vault = fakeVault(),
	extra: Partial<ConstructorParameters<typeof StellarSettlementAdapter>[0]> = {},
) {
	return {
		vault,
		a: new StellarSettlementAdapter({
			vault: vault as unknown as PayoutVault,
			wallets,
			vaultId: VAULT_ID,
			rpcUrl: "https://rpc.invalid",
			networkPassphrase: Networks.TESTNET,
			...extra,
		}),
	};
}

const lockReq = (o: Record<string, unknown> = {}) => ({
	paymentId: "pay_1",
	attempt: 1,
	payer: PAYER,
	amount: money("1000000000", "USDC"),
	feeMode: "RecipientPays" as const,
	expiresAt: new Date(1_900_000_000_500),
	claimHashHex: HASH32,
	...o,
});

async function settlementCode(p: Promise<unknown>): Promise<number | undefined> {
	const err = await p.catch((e) => e);
	expect(err).toBeInstanceOf(SettlementError);
	return (err as SettlementError).code;
}

afterEach(() => vi.restoreAllMocks());

describe("feeBps / fundVault", () => {
	it("reads the fee from the vault", async () => {
		expect(await adapter().a.feeBps()).toBe(100);
	});

	it("fundVault deposits as the payer's custodial key", async () => {
		const { a, vault } = adapter();
		const ref = await a.fundVault(PAYER, money("500", "USDC"));
		expect(ref).toEqual({ network: "stellar", txRef: "DEPOSIT_HASH" });
		const [kp, amt] = vault.deposit.mock.calls[0]! as unknown as [Keypair, bigint];
		expect(kp.publicKey()).toBe(PAYER);
		expect(amt).toBe(500n);
	});

	it("rejects a different asset or zero amount with SettlementError #3", async () => {
		const { a } = adapter();
		expect(await settlementCode(a.fundVault(PAYER, money("5", "EURC")))).toBe(3);
		expect(await settlementCode(a.fundVault(PAYER, money("0", "USDC")))).toBe(3);
	});

	it("honours a custom asset currency", async () => {
		const { a } = adapter(fakeVault(), { assetCurrency: "TUSDC" });
		await expect(a.fundVault(PAYER, money("5", "TUSDC"))).resolves.toBeTruthy();
		expect(await settlementCode(a.fundVault(PAYER, money("5", "USDC")))).toBe(3);
	});

	it("unknown payer address is not signed for", async () => {
		const { a } = adapter();
		await expect(a.fundVault(Keypair.random().publicKey(), money("5", "USDC"))).rejects.toThrow(
			/no custodial demo keypair/,
		);
	});

	it("maps vault InsufficientBalance on deposit", async () => {
		const { a } = adapter(
			fakeVault({ deposit: vi.fn(async () => Promise.reject(new VaultError(5))) }),
		);
		const err = (await a.fundVault(PAYER, money("5", "USDC")).catch((e) => e)) as SettlementError;
		expect(err.code).toBe(5);
		expect(err.errorName).toBe("InsufficientBalance");
		expect((err as Error & { cause?: unknown }).cause).toBeInstanceOf(VaultError);
	});
});

describe("lock", () => {
	it("creates the payout with externalId, claim hash and unix-second expiry", async () => {
		const { a, vault } = adapter();
		const res = await a.lock(lockReq());
		const [kp, p] = vault.createPayout.mock.calls[0]! as unknown as [
			Keypair,
			{ externalId: Buffer; claimHash: Buffer; amount: bigint; mode: string; expiresAt: bigint },
		];
		expect(kp.publicKey()).toBe(PAYER);
		expect(p.externalId.equals(externalIdFor("pay_1", 1))).toBe(true);
		expect(p.claimHash.toString("hex")).toBe(HASH32);
		expect(p.amount).toBe(1_000_000_000n);
		expect(p.mode).toBe("RecipientPays");
		expect(p.expiresAt).toBe(1_900_000_000n);
		expect(res).toEqual({
			network: "stellar",
			txRef: "LOCK_HASH",
			payoutId: "5",
			externalIdHex: externalIdFor("pay_1", 1).toString("hex"),
			fee: money("10000000", "USDC"),
			locked: money("1000000000", "USDC"),
			net: money("990000000", "USDC"),
		});
	});

	it("PayerPays: locked = amount + fee, net = amount; fee from on-chain bps", async () => {
		const { a } = adapter(fakeVault({ feeBps: vi.fn(async () => 150) }));
		const res = await a.lock(lockReq({ feeMode: "PayerPays" }));
		expect(res.fee.amount).toBe("15000000");
		expect(res.locked.amount).toBe("1015000000");
		expect(res.net.amount).toBe("1000000000");
	});

	it("attempt changes the on-chain external id", async () => {
		const { a } = adapter();
		const r2 = await a.lock(lockReq({ attempt: 2 }));
		expect(r2.externalIdHex).toBe(externalIdFor("pay_1", 2).toString("hex"));
	});

	it.each([
		["not hex", "zz".repeat(32)],
		["odd length", "a".repeat(63)],
		["wrong size", "ab".repeat(16)],
	])("rejects claimHashHex %s", async (_label, hex) => {
		const { a, vault } = adapter();
		await expect(a.lock(lockReq({ claimHashHex: hex }))).rejects.toThrow(/invalid claimHashHex/);
		expect(vault.createPayout).not.toHaveBeenCalled();
	});

	it("maps DuplicateExternalId (#12) and InvalidExpiry (#11) from host error text", async () => {
		const { a } = adapter(
			fakeVault({
				createPayout: vi
					.fn()
					.mockRejectedValueOnce(new Error("HostError: Error(Contract, #12)"))
					.mockRejectedValueOnce(new Error("HostError: Error(Contract, #11)")),
			}),
		);
		expect(await settlementCode(a.lock(lockReq()))).toBe(12);
		expect(await settlementCode(a.lock(lockReq()))).toBe(11);
	});

	it("fee read failure is mapped too", async () => {
		const { a } = adapter(
			fakeVault({ feeBps: vi.fn(async () => Promise.reject(new VaultError(2))) }),
		);
		expect(await settlementCode(a.lock(lockReq()))).toBe(2);
	});

	it("non-contract errors pass through unchanged", async () => {
		const boom = new Error("ECONNRESET");
		const { a } = adapter(fakeVault({ createPayout: vi.fn(async () => Promise.reject(boom)) }));
		await expect(a.lock(lockReq())).rejects.toBe(boom);
	});

	it("SettlementError from the vault is rethrown as-is", async () => {
		const se = new SettlementError(4);
		const { a } = adapter(fakeVault({ createPayout: vi.fn(async () => Promise.reject(se)) }));
		await expect(a.lock(lockReq())).rejects.toBe(se);
	});

	it("rejects wrong asset before any vault call", async () => {
		const { a, vault } = adapter();
		expect(await settlementCode(a.lock(lockReq({ amount: money("5", "GBP") })))).toBe(3);
		expect(vault.feeBps).not.toHaveBeenCalled();
	});
});

describe("release", () => {
	it("claims as the destination's custodial key and reports received", async () => {
		const { a, vault } = adapter();
		const res = await a.release({
			payoutId: "5",
			secretHex: HASH32,
			destination: workerA.publicKey(),
		});
		expect(res).toEqual({
			network: "stellar",
			txRef: "CLAIM_HASH",
			received: money("990000000", "USDC"),
		});
		const [kp, p] = vault.claim.mock.calls[0]! as unknown as [Keypair, { id: bigint; secret: Buffer }];
		expect(kp.publicKey()).toBe(workerA.publicKey());
		expect(p.id).toBe(5n);
		expect(p.secret.toString("hex")).toBe(HASH32);
	});

	it("maps BadSecret (#10), Expired (#8), NotPending (#7)", async () => {
		const { a } = adapter(
			fakeVault({
				claim: vi
					.fn()
					.mockRejectedValueOnce({ message: "BadSecret" })
					.mockRejectedValueOnce(new VaultError(8))
					.mockRejectedValueOnce("Error(Contract, #7)"),
			}),
		);
		const req = { payoutId: "5", secretHex: HASH32, destination: workerB.publicKey() };
		expect(await settlementCode(a.release(req))).toBe(10);
		expect(await settlementCode(a.release(req))).toBe(8);
		expect(await settlementCode(a.release(req))).toBe(7);
	});

	it("rejects an invalid secret before calling the vault", async () => {
		const { a, vault } = adapter();
		await expect(
			a.release({ payoutId: "5", secretHex: "00", destination: workerA.publicKey() }),
		).rejects.toThrow(/invalid secretHex: expected 32 bytes, got 1/);
		expect(vault.claim).not.toHaveBeenCalled();
	});

	it("rejects a non-numeric payout id", async () => {
		const { a } = adapter();
		await expect(
			a.release({ payoutId: "abc", secretHex: HASH32, destination: workerA.publicKey() }),
		).rejects.toThrow(SyntaxError);
	});
});

describe("refund", () => {
	it("before expiry: payer cancels", async () => {
		const { a, vault } = adapter();
		expect(await a.refund("5")).toEqual({ network: "stellar", txRef: "CANCEL_HASH" });
		const [kp, id] = vault.cancel.mock.calls[0]! as unknown as [Keypair, bigint];
		expect(kp.publicKey()).toBe(PAYER);
		expect(id).toBe(5n);
		expect(vault.refund).not.toHaveBeenCalled();
	});

	it("after expiry: permissionless refund", async () => {
		const { a, vault } = adapter(
			fakeVault({ getPayout: vi.fn(async () => payout({ expiresAt: nowSec() - 10n })) }),
		);
		expect(await a.refund("5")).toEqual({ network: "stellar", txRef: "REFUND_HASH" });
		expect(vault.cancel).not.toHaveBeenCalled();
	});

	it("expired boundary: cancel says Expired (VaultError) → falls back to refund", async () => {
		const { a, vault } = adapter(
			fakeVault({ cancel: vi.fn(async () => Promise.reject(new VaultError(8))) }),
		);
		expect(await a.refund("5")).toEqual({ network: "stellar", txRef: "REFUND_HASH" });
		expect(vault.refund).toHaveBeenCalledTimes(1);
	});

	it("expired boundary via host error text also falls back", async () => {
		const { a } = adapter(
			fakeVault({
				cancel: vi.fn(async () => Promise.reject(new Error("Error(Contract, #8)"))),
			}),
		);
		expect((await a.refund("5")).txRef).toBe("REFUND_HASH");
	});

	it("boundary refund failure is mapped", async () => {
		const { a } = adapter(
			fakeVault({
				cancel: vi.fn(async () => Promise.reject(new VaultError(8))),
				refund: vi.fn(async () => Promise.reject(new VaultError(9))),
			}),
		);
		expect(await settlementCode(a.refund("5"))).toBe(9);
	});

	it("other cancel errors are mapped, not refunded", async () => {
		const { a, vault } = adapter(
			fakeVault({ cancel: vi.fn(async () => Promise.reject(new VaultError(7))) }),
		);
		expect(await settlementCode(a.refund("5"))).toBe(7);
		expect(vault.refund).not.toHaveBeenCalled();
	});

	it("non-vault cancel errors pass through", async () => {
		const boom = new Error("timeout");
		const { a } = adapter(fakeVault({ cancel: vi.fn(async () => Promise.reject(boom)) }));
		await expect(a.refund("5")).rejects.toBe(boom);
	});

	it.each(["Claimed", "Refunded"] as const)("%s payout → SettlementError #7 NotPending", async (status) => {
		const { a, vault } = adapter(fakeVault({ getPayout: vi.fn(async () => payout({ status })) }));
		expect(await settlementCode(a.refund("5"))).toBe(7);
		expect(vault.cancel).not.toHaveBeenCalled();
	});

	it("PayoutNotFound (#6) from getPayout", async () => {
		const { a } = adapter(
			fakeVault({ getPayout: vi.fn(async () => Promise.reject(new VaultError(6))) }),
		);
		expect(await settlementCode(a.refund("404"))).toBe(6);
	});

	it("expired refund failure is mapped", async () => {
		const { a } = adapter(
			fakeVault({
				getPayout: vi.fn(async () => payout({ expiresAt: 0n })),
				refund: vi.fn(async () => Promise.reject(new Error("Error(Contract, #7)"))),
			}),
		);
		expect(await settlementCode(a.refund("5"))).toBe(7);
	});
});

describe("status / findLock", () => {
	it.each([
		["Pending", "pending"],
		["Claimed", "claimed"],
		["Refunded", "refunded"],
	] as const)("maps %s → %s", async (status, state) => {
		const { a, vault } = adapter(
			fakeVault({
				getPayout: vi.fn(async () => payout({ status, expiresAt: 1_900_000_000n })),
			}),
		);
		expect(await a.status("5")).toEqual({
			payoutId: "5",
			state,
			expiresAt: new Date(1_900_000_000_000),
			net: money("990000000", "USDC"),
		});
		expect(vault.getPayout).toHaveBeenCalledWith(5n);
	});

	it("status maps PayoutNotFound", async () => {
		const { a } = adapter(
			fakeVault({ getPayout: vi.fn(async () => Promise.reject(new VaultError(6))) }),
		);
		const err = (await a.status("9").catch((e) => e)) as SettlementError;
		expect(err.code).toBe(6);
		expect(err.errorName).toBe("PayoutNotFound");
	});

	it("findLock recovers an existing payout id by payer + external id", async () => {
		const { a, vault } = adapter();
		expect(await a.findLock(PAYER, "pay_1", 2)).toBe("5");
		const [payer, ext] = vault.payoutByExternal.mock.calls[0]! as unknown as [string, Buffer];
		expect(payer).toBe(PAYER);
		expect(ext.equals(externalIdFor("pay_1", 2))).toBe(true);
	});

	it("findLock returns undefined when no lock exists", async () => {
		const { a } = adapter(fakeVault({ payoutByExternal: vi.fn(async () => undefined) }));
		expect(await a.findLock(PAYER, "pay_1", 1)).toBeUndefined();
	});

	it("findLock rejects invalid attempts before any call", async () => {
		const { a, vault } = adapter();
		await expect(a.findLock(PAYER, "pay_1", 0)).rejects.toThrow(/attempt/);
		expect(vault.payoutByExternal).not.toHaveBeenCalled();
	});

	it("findLock maps vault errors", async () => {
		const { a } = adapter(
			fakeVault({ payoutByExternal: vi.fn(async () => Promise.reject(new VaultError(2))) }),
		);
		expect(await settlementCode(a.findLock(PAYER, "pay_1", 1))).toBe(2);
	});
});

// ---- fund deposit verification with real envelopes (built offline) ----

function depositEnvelope(
	ops: { contract?: string; fn?: string; payer?: string; amount?: bigint; args?: unknown[] }[],
): string {
	const source = Keypair.random();
	let b = new TransactionBuilder(new Account(source.publicKey(), "1"), {
		fee: "100",
		networkPassphrase: Networks.TESTNET,
	});
	for (const op of ops) {
		b = b.addOperation(
			Operation.invokeContractFunction({
				contract: op.contract ?? VAULT_ID,
				function: op.fn ?? "deposit",
				args: (op.args as never) ?? [
					nativeToScVal(op.payer ?? PAYER, { type: "address" }),
					nativeToScVal(op.amount ?? 101n, { type: "i128" }),
				],
			}),
		);
	}
	return b.setTimeout(30).build().toXDR();
}

describe("verifyFundDeposit", () => {
	const input = { txRef: "FUNDTX", payer: PAYER, amount: money("101", "USDC") };

	it("confirms exactly one matching deposit and reports its op index", async () => {
		const xdrB64 = depositEnvelope([
			{ contract: OTHER_CONTRACT },
			{ fn: "withdraw" },
			{ amount: 5n },
			{},
		]);
		const { a } = adapter(fakeVault(), {
			fetchFundTx: async () => ({ status: "SUCCESS", envelopeXdr: xdrB64 }),
		});
		expect(await a.verifyFundDeposit(input)).toEqual({
			fundTxRef: "FUNDTX",
			fundOpIndex: 3,
			fundAmountValue: "101",
			fundAmountCurrency: "USDC",
			fundNetwork: "stellar",
			fundVaultId: VAULT_ID,
		});
	});

	it("legacy envelope-only fetcher is treated as SUCCESS", async () => {
		const fetchFundTxEnvelopeXdr = vi.fn(async () => depositEnvelope([{}]));
		const { a } = adapter(fakeVault(), { fetchFundTxEnvelopeXdr });
		expect((await a.verifyFundDeposit(input)).fundOpIndex).toBe(0);
		expect(fetchFundTxEnvelopeXdr).toHaveBeenCalledWith("FUNDTX");
	});

	async function verifyCode(xdrB64: string | undefined, status = "SUCCESS" as const) {
		const { a } = adapter(fakeVault(), {
			fetchFundTx: async () => ({ status, envelopeXdr: xdrB64 }),
		});
		const err = await a.verifyFundDeposit(input).catch((e) => e);
		expect(err).toBeInstanceOf(FundDepositVerifyError);
		return (err as FundDepositVerifyError).code;
	}

	it("wrong amount / wrong payer / wrong contract → not_found", async () => {
		expect(await verifyCode(depositEnvelope([{ amount: 100n }]))).toBe("not_found");
		expect(
			await verifyCode(depositEnvelope([{ payer: Keypair.random().publicKey() }])),
		).toBe("not_found");
		expect(await verifyCode(depositEnvelope([{ contract: OTHER_CONTRACT }]))).toBe("not_found");
	});

	it("two matching deposits → ambiguous", async () => {
		expect(await verifyCode(depositEnvelope([{}, {}]))).toBe("ambiguous");
	});

	it("deposit with too few args is ignored", async () => {
		expect(
			await verifyCode(
				depositEnvelope([{ args: [nativeToScVal(PAYER, { type: "address" })] }]),
			),
		).toBe("not_found");
	});

	it("deposit with a non-numeric amount arg is ignored", async () => {
		expect(
			await verifyCode(
				depositEnvelope([
					{
						args: [
							nativeToScVal(PAYER, { type: "address" }),
							nativeToScVal(true),
						],
					},
				]),
			),
		).toBe("not_found");
	});

	it("u32 amount arg (decoded as number) still matches", async () => {
		const { a } = adapter(fakeVault(), {
			fetchFundTx: async () => ({
				status: "SUCCESS",
				envelopeXdr: depositEnvelope([
					{
						args: [
							nativeToScVal(PAYER, { type: "address" }),
							nativeToScVal(101, { type: "u32" }),
						],
					},
				]),
			}),
		});
		expect((await a.verifyFundDeposit(input)).fundOpIndex).toBe(0);
	});

	it("SUCCESS without envelope → not_found", async () => {
		expect(await verifyCode(undefined)).toBe("not_found");
	});

	it("invalid XDR is a plain error", async () => {
		const { a } = adapter(fakeVault(), {
			fetchFundTx: async () => ({ status: "SUCCESS", envelopeXdr: "bm90LXhkcg==" }),
		});
		await expect(a.verifyFundDeposit(input)).rejects.toThrow(/not valid XDR/);
	});

	it("non-invoke operations are skipped", async () => {
		const source = Keypair.random();
		const xdrB64 = new TransactionBuilder(new Account(source.publicKey(), "1"), {
			fee: "100",
			networkPassphrase: Networks.TESTNET,
		})
			.addOperation(Operation.bumpSequence({ bumpTo: "5" }))
			.setTimeout(30)
			.build()
			.toXDR();
		expect(await verifyCode(xdrB64)).toBe("not_found");
	});

	it("rejects wrong asset before fetching", async () => {
		const fetchFundTx = vi.fn();
		const { a } = adapter(fakeVault(), { fetchFundTx });
		expect(
			await settlementCode(a.verifyFundDeposit({ ...input, amount: money("1", "GBP") })),
		).toBe(3);
		expect(fetchFundTx).not.toHaveBeenCalled();
	});
});

describe("verifyFundDeposit via RPC getTransaction (mocked)", () => {
	const input = { txRef: "RPCTX", payer: PAYER, amount: money("101", "USDC") };

	function mockGetTransaction(impl: () => unknown) {
		return vi
			.spyOn(Server.prototype, "getTransaction")
			.mockImplementation((async () => impl()) as never);
	}

	it("SUCCESS with string envelope", async () => {
		const spy = mockGetTransaction(() => ({
			status: Api.GetTransactionStatus.SUCCESS,
			envelopeXdr: depositEnvelope([{}]),
		}));
		const { a } = adapter();
		expect((await a.verifyFundDeposit(input)).fundOpIndex).toBe(0);
		expect(spy).toHaveBeenCalledWith("RPCTX");
	});

	it("SUCCESS with an XDR object envelope (toXDR)", async () => {
		const b64 = depositEnvelope([{}]);
		mockGetTransaction(() => ({
			status: Api.GetTransactionStatus.SUCCESS,
			envelopeXdr: { toXDR: (fmt: string) => (fmt === "base64" ? b64 : "") },
		}));
		const { a } = adapter();
		expect((await a.verifyFundDeposit(input)).fundOpIndex).toBe(0);
	});

	it.each([
		["no envelope", undefined],
		["unrecognised envelope shape", 42],
	])("SUCCESS with %s → not_found", async (_l, envelopeXdr) => {
		mockGetTransaction(() => ({ status: Api.GetTransactionStatus.SUCCESS, envelopeXdr }));
		const err = await adapter().a.verifyFundDeposit(input).catch((e) => e);
		expect((err as FundDepositVerifyError).code).toBe("not_found");
	});

	it.each([
		[Api.GetTransactionStatus.NOT_FOUND, "not_found"],
		[Api.GetTransactionStatus.FAILED, "not_success"],
		["PENDING", "not_success"],
	])("RPC %s → %s", async (status, code) => {
		mockGetTransaction(() => ({ status, envelopeXdr: depositEnvelope([{}]) }));
		const err = await adapter().a.verifyFundDeposit(input).catch((e) => e);
		expect(err).toBeInstanceOf(FundDepositVerifyError);
		expect((err as FundDepositVerifyError).code).toBe(code);
		expect((err as Error).message).toMatch(/RPCTX/);
	});

	it("RPC failure is wrapped with the tx ref", async () => {
		mockGetTransaction(() => {
			throw new Error("503");
		});
		await expect(adapter().a.verifyFundDeposit(input)).rejects.toThrow(
			"fund tx RPCTX RPC getTransaction failed: 503",
		);
		mockGetTransaction(() => {
			throw "raw";
		});
		await expect(adapter().a.verifyFundDeposit(input)).rejects.toThrow(/failed: raw/);
	});
});
