import { afterEach, describe, expect, it, vi } from "vitest";
import {
	Account,
	Keypair,
	Networks,
	Operation,
	SorobanDataBuilder,
	StrKey,
	TransactionBuilder,
	contract,
	nativeToScVal,
	type Transaction,
} from "@stellar/stellar-sdk";
import { PayoutVault, VaultConfigMismatch } from "../src/vault-client.ts";
import { VaultError } from "../src/vault-errors.ts";
import { VaultTxFeeError } from "../src/vault-tx-fee.ts";
import type { StellarEnv } from "../src/stellar-env.ts";

// No network: contract.Client.from is replaced with fakes that hand back
// AssembledTransaction-shaped objects (result / simulation / built / send).

const VAULT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
const TOKEN_ID = StrKey.encodeContract(Buffer.alloc(32, 9));
const TREASURY = Keypair.random().publicKey();

const env: StellarEnv = {
	network: "testnet",
	rpcUrl: "https://rpc.invalid",
	networkPassphrase: Networks.TESTNET,
	usdcAsset: "USDC:GXXX",
	usdcContractId: TOKEN_ID,
	payoutVaultId: VAULT_ID,
	vaultFeeBps: 100,
	treasuryAddress: TREASURY,
	sorobanTxFeeCeilingStroops: 1_000_000n,
};

function builtTx(signer: Keypair, resourceFee = 1000) {
	const sorobanData = new SorobanDataBuilder().setResourceFee(resourceFee).build();
	const built = new TransactionBuilder(new Account(signer.publicKey(), "1"), {
		fee: "100",
		networkPassphrase: Networks.TESTNET,
	})
		.addOperation(
			Operation.invokeContractFunction({
				contract: VAULT_ID,
				function: "deposit",
				args: [
					nativeToScVal(signer.publicKey(), { type: "address" }),
					nativeToScVal(5n, { type: "i128" }),
				],
			}),
		)
		.setSorobanData(sorobanData)
		.setTimeout(30)
		.build();
	return { built, sorobanData };
}

type FakeTx = Record<string, unknown>;

function readTx(result: unknown, simError?: string): FakeTx {
	return { result, simulation: simError ? { error: simError } : {} };
}

function writeTx(
	signer: Keypair,
	opts: {
		simResult?: unknown;
		simError?: string;
		sentResult?: unknown;
		hash?: string | undefined;
		send?: () => Promise<unknown>;
		otherSigners?: string[];
		noSimData?: boolean;
		resourceFee?: number;
		timeoutInSeconds?: number;
	} = {},
): FakeTx & { built: Transaction } {
	const { built, sorobanData } = builtTx(signer, opts.resourceFee);
	const tx: FakeTx & { built: Transaction } = {
		result: opts.simResult,
		simulation: opts.simError ? { error: opts.simError } : {},
		options: { timeoutInSeconds: opts.timeoutInSeconds },
		built,
		needsNonInvokerSigningBy: () => opts.otherSigners ?? [],
		send:
			opts.send ??
			(async () => ({
				sendTransactionResponse: "hash" in opts ? (opts.hash ? { hash: opts.hash } : {}) : { hash: "TXHASH" },
				result: opts.sentResult,
			})),
	};
	Object.defineProperty(tx, "simulationData", {
		get() {
			if (opts.noSimData) throw new Error("no simulation yet");
			return { transactionData: sorobanData, result: {} };
		},
	});
	return tx;
}

type Handlers = Record<string, (args?: object) => FakeTx | Promise<FakeTx>>;

function installClients(reader: Handlers, writer: Handlers = {}) {
	const calls: { method: string; args: unknown; publicKey?: string }[] = [];
	const fromSpy = vi.spyOn(contract.Client, "from").mockImplementation((async (
		opts: contract.ClientOptions,
	) => {
		const handlers = opts.publicKey ? writer : reader;
		return new Proxy(
			{},
			{
				get(_t, method: string) {
					if (method === "then") return undefined;
					return async (args?: object) => {
						calls.push({ method, args, publicKey: opts.publicKey });
						const h = handlers[method];
						if (!h) throw new Error(`unexpected call ${method}`);
						return h(args);
					};
				},
			},
		);
	}) as never);
	return { calls, fromSpy };
}

const rawPayout = {
	id: 3n,
	payer: TREASURY,
	external_id: Buffer.alloc(32, 1),
	claim_hash: Buffer.alloc(32, 2),
	gross: 100n,
	fee: 1n,
	net: 100n,
	locked: 101n,
	expires_at: 1_900_000_000n,
	status: { tag: "Pending" },
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("PayoutVault.connect / verifyConfig", () => {
	it("connects with the env contract id, rpc and error types; verifies config", async () => {
		const { fromSpy } = installClients({
			config: () => readTx([TOKEN_ID, TREASURY, 100]),
		});
		const vault = await PayoutVault.connect(env);
		expect(vault.env).toBe(env);
		const opts = fromSpy.mock.calls[0]![0];
		expect(opts.contractId).toBe(VAULT_ID);
		expect(opts.rpcUrl).toBe(env.rpcUrl);
		expect(opts.networkPassphrase).toBe(Networks.TESTNET);
		expect(opts.errorTypes?.[8]).toEqual({ message: "Expired" });
	});

	it("skips config check with verify: false", async () => {
		const { calls } = installClients({});
		await PayoutVault.connect(env, { verify: false });
		expect(calls).toHaveLength(0);
	});

	it("fee drift: on-chain fee_bps differing from FP_VAULT_FEE_BPS stops the adapter", async () => {
		installClients({ config: () => readTx([TOKEN_ID, TREASURY, 150]) });
		const err = await PayoutVault.connect(env).catch((e) => e);
		expect(err).toBeInstanceOf(VaultConfigMismatch);
		expect((err as VaultConfigMismatch).mismatches).toEqual([
			"fee_bps 150 != FP_VAULT_FEE_BPS 100",
		]);
	});

	it("lists every mismatch (token, treasury, fee)", async () => {
		const otherToken = StrKey.encodeContract(Buffer.alloc(32, 1));
		installClients({ config: () => readTx([otherToken, "GOTHER", 0]) });
		const err = (await PayoutVault.connect(env).catch((e) => e)) as VaultConfigMismatch;
		expect(err.mismatches).toHaveLength(3);
		expect(err.message).toMatch(/token .* FP_USDC_CONTRACT_ID/);
		expect(err.message).toMatch(/treasury GOTHER/);
		expect(err.name).toBe("VaultConfigMismatch");
	});
});

describe("PayoutVault reads", () => {
	async function vaultWith(reader: Handlers) {
		const installed = installClients(reader);
		return { vault: await PayoutVault.connect(env, { verify: false }), ...installed };
	}

	it("feeBps reads config()[2]", async () => {
		const { vault } = await vaultWith({ config: () => readTx([TOKEN_ID, TREASURY, 42]) });
		expect(await vault.feeBps()).toBe(42);
	});

	it("getPayout maps snake_case + status tag; unwraps Ok results", async () => {
		const { vault, calls } = await vaultWith({
			get_payout: () => readTx(new contract.Ok(rawPayout)),
		});
		const p = await vault.getPayout(3n);
		expect(calls[0]).toMatchObject({ method: "get_payout", args: { id: 3n } });
		expect(p).toMatchObject({
			id: 3n,
			payer: TREASURY,
			gross: 100n,
			fee: 1n,
			net: 100n,
			locked: 101n,
			expiresAt: 1_900_000_000n,
			status: "Pending",
		});
		expect(Buffer.isBuffer(p.externalId)).toBe(true);
		expect(p.claimHash.equals(Buffer.alloc(32, 2))).toBe(true);
	});

	it("getPayout Err(PayoutNotFound) becomes VaultError #6", async () => {
		const { vault } = await vaultWith({
			get_payout: () => readTx(new contract.Err({ message: "PayoutNotFound" })),
		});
		const err = await vault.getPayout(99n).catch((e) => e);
		expect(err).toBeInstanceOf(VaultError);
		expect((err as VaultError).code).toBe(6);
		expect((err as VaultError).errorName).toBe("PayoutNotFound");
	});

	it("falls back to the simulation error text when the Err is not decodable", async () => {
		const { vault } = await vaultWith({
			get_payout: () =>
				readTx(new contract.Err({ message: "???" }), "HostError: Error(Contract, #6)"),
		});
		const err = await vault.getPayout(1n).catch((e) => e);
		expect((err as VaultError).code).toBe(6);
	});

	it("non-contract Err becomes a plain error naming the simulation error", async () => {
		const { vault } = await vaultWith({
			get_payout: () => readTx(new contract.Err({ message: "weird" }), "wasm trap"),
		});
		await expect(vault.getPayout(1n)).rejects.toThrow(
			"payout_vault call failed: wasm trap",
		);
		const { vault: v2 } = await vaultWith({
			get_payout: () => readTx(new contract.Err({ message: "weird" })),
		});
		await expect(v2.getPayout(1n)).rejects.toThrow("unknown error");
	});

	it("payoutByExternal returns the id or undefined for null (findLock recovery)", async () => {
		const ext = Buffer.alloc(32, 5);
		const { vault, calls } = await vaultWith({
			payout_by_external: (args) =>
				readTx((args as { payer: string }).payer === "GHIT" ? 12n : null),
		});
		expect(await vault.payoutByExternal("GHIT", ext)).toBe(12n);
		expect(await vault.payoutByExternal("GMISS", ext)).toBeUndefined();
		expect(calls[0]!.args).toEqual({ payer: "GHIT", external_id: ext });
	});

	it("balance reads the payer's vault balance", async () => {
		const { vault } = await vaultWith({ balance: () => readTx(500n) });
		expect(await vault.balance("GPAYER")).toBe(500n);
	});
});

describe("PayoutVault writes", () => {
	const payer = Keypair.random();

	async function vaultWithWriter(writer: Handlers, envOverride: Partial<StellarEnv> = {}) {
		const installed = installClients({}, writer);
		const vault = await PayoutVault.connect({ ...env, ...envOverride }, { verify: false });
		return { vault, ...installed };
	}

	it("deposit: rebuilds fee once, signs, sends and returns the tx hash", async () => {
		const tx = writeTx(payer, { sentResult: undefined });
		const original = tx.built;
		const { vault, calls, fromSpy } = await vaultWithWriter({ deposit: () => tx });
		const receipt = await vault.deposit(payer, 1000n);
		expect(receipt).toEqual({ result: undefined, txHash: "TXHASH" });
		expect(calls[0]).toMatchObject({
			method: "deposit",
			args: { payer: payer.publicKey(), amount: 1000n },
			publicKey: payer.publicKey(),
		});
		const signed = tx.signed as Transaction;
		expect(signed).toBe(tx.built);
		expect(signed).not.toBe(original);
		expect(signed.fee).toBe(original.fee);
		expect(signed.signatures).toHaveLength(1);
		// writer options carry a signer
		const writerOpts = fromSpy.mock.calls.find((c) => c[0].publicKey)![0];
		expect(typeof writerOpts.signTransaction).toBe("function");
	});

	it("reuses one writer client per signer", async () => {
		const { vault, fromSpy } = await vaultWithWriter({
			deposit: () => writeTx(payer),
			withdraw: () => writeTx(payer),
		});
		await vault.deposit(payer, 1n);
		await vault.withdraw(payer, 1n);
		expect(fromSpy.mock.calls.filter((c) => c[0].publicKey)).toHaveLength(1);
	});

	it("createPayout (lock) passes snake_case args and returns the payout id", async () => {
		const { vault, calls } = await vaultWithWriter({
			create_payout: () =>
				writeTx(payer, { simResult: new contract.Ok(7n), sentResult: new contract.Ok(7n) }),
		});
		const receipt = await vault.createPayout(payer, {
			externalId: Buffer.alloc(32, 1),
			claimHash: Buffer.alloc(32, 2),
			amount: 100n,
			mode: "RecipientPays",
			expiresAt: 1_900_000_000n,
		});
		expect(receipt).toEqual({ result: 7n, txHash: "TXHASH" });
		expect(calls[0]!.args).toEqual({
			payer: payer.publicKey(),
			external_id: Buffer.alloc(32, 1),
			claim_hash: Buffer.alloc(32, 2),
			amount: 100n,
			mode: { tag: "RecipientPays", values: undefined },
			expires_at: 1_900_000_000n,
		});
	});

	it("createPayout simulation error DuplicateExternalId fails before sending", async () => {
		const send = vi.fn();
		const { vault } = await vaultWithWriter({
			create_payout: () =>
				writeTx(payer, {
					simResult: new contract.Err({ message: "DuplicateExternalId" }),
					send,
				}),
		});
		const err = await vault
			.createPayout(payer, {
				externalId: Buffer.alloc(32),
				claimHash: Buffer.alloc(32),
				amount: 1n,
				mode: "PayerPays",
				expiresAt: 1n,
			})
			.catch((e) => e);
		expect((err as VaultError).code).toBe(12);
		expect(send).not.toHaveBeenCalled();
	});

	it("claim (release): receiver signs and is the `to`", async () => {
		const receiver = Keypair.random();
		const { vault, calls } = await vaultWithWriter({
			claim: () => writeTx(receiver, { sentResult: 99n }),
		});
		const secret = Buffer.alloc(32, 3);
		const receipt = await vault.claim(receiver, { id: 4n, secret });
		expect(receipt.result).toBe(99n);
		expect(calls[0]).toMatchObject({
			args: { id: 4n, secret, to: receiver.publicKey() },
			publicKey: receiver.publicKey(),
		});
	});

	it("claim with bad secret maps host error text from send to VaultError #10", async () => {
		const { vault } = await vaultWithWriter({
			claim: () =>
				writeTx(payer, {
					send: async () => {
						throw new Error("Transaction simulation failed: Error(Contract, #10)");
					},
				}),
		});
		const err = await vault.claim(payer, { id: 1n, secret: Buffer.alloc(32) }).catch((e) => e);
		expect(err).toBeInstanceOf(VaultError);
		expect((err as VaultError).code).toBe(10);
	});

	it("cancel / refund: Expired and NotExpired are mapped", async () => {
		const { vault } = await vaultWithWriter({
			cancel: () => writeTx(payer, { simResult: new contract.Err({ message: "Expired" }) }),
			refund: () => writeTx(payer, { simError: "Error(Contract, #9)", simResult: new contract.Err({ message: "" }) }),
		});
		expect(((await vault.cancel(payer, 1n).catch((e) => e)) as VaultError).code).toBe(8);
		expect(((await vault.refund(payer, 1n).catch((e) => e)) as VaultError).code).toBe(9);
	});

	it("refund success returns the tx hash", async () => {
		const { vault, calls } = await vaultWithWriter({
			refund: () => writeTx(payer, { hash: "REFUNDHASH" }),
		});
		expect(await vault.refund(payer, 5n)).toEqual({ result: undefined, txHash: "REFUNDHASH" });
		expect(calls[0]!.args).toEqual({ id: 5n });
	});

	it("non-vault send failures pass through unchanged", async () => {
		const boom = new Error("socket hang up");
		const { vault } = await vaultWithWriter({
			withdraw: () =>
				writeTx(payer, {
					send: async () => {
						throw boom;
					},
				}),
		});
		await expect(vault.withdraw(payer, 1n)).rejects.toBe(boom);
	});

	it("missing tx hash after send is an error", async () => {
		const { vault } = await vaultWithWriter({
			deposit: () => writeTx(payer, { hash: undefined }),
		});
		await expect(vault.deposit(payer, 1n)).rejects.toThrow(
			"payout_vault deposit: no transaction hash returned",
		);
	});

	it("missing simulation data is a typed VaultTxFeeError", async () => {
		const { vault } = await vaultWithWriter({
			deposit: () => writeTx(payer, { noSimData: true }),
		});
		const err = await vault.deposit(payer, 1n).catch((e) => e);
		expect(err).toBeInstanceOf(VaultTxFeeError);
		expect((err as VaultTxFeeError).reason).toBe("missing_simulation_data");
		expect((err as Error).message).toMatch(/no simulation yet/);
	});

	it("refuses when other classic signers are still needed (contract ids ignored)", async () => {
		const other = Keypair.random().publicKey();
		const { vault } = await vaultWithWriter({
			deposit: () => writeTx(payer, { otherSigners: [VAULT_ID, other] }),
			withdraw: () => writeTx(payer, { otherSigners: [VAULT_ID] }),
		});
		await expect(vault.deposit(payer, 1n)).rejects.toThrow(
			`transaction needs signatures from ${other}`,
		);
		await expect(vault.withdraw(payer, 1n)).resolves.toMatchObject({ txHash: "TXHASH" });
	});

	it("fee ceiling not configured: write fails typed and never sends", async () => {
		const send = vi.fn();
		const { vault } = await vaultWithWriter(
			{ deposit: () => writeTx(payer, { send }) },
			{ sorobanTxFeeCeilingStroops: null },
		);
		const err = await vault.deposit(payer, 1n).catch((e) => e);
		expect((err as VaultTxFeeError).reason).toBe("ceiling_not_configured");
		expect(send).not.toHaveBeenCalled();
	});

	it("fee above ceiling: write fails typed", async () => {
		const { vault } = await vaultWithWriter(
			{ deposit: () => writeTx(payer, { resourceFee: 5000 }) },
			{ sorobanTxFeeCeilingStroops: 1000n },
		);
		const err = await vault.deposit(payer, 1n).catch((e) => e);
		expect((err as VaultTxFeeError).reason).toBe("fee_exceeds_ceiling");
	});

	it("honours a custom timeoutInSeconds on rebuild", async () => {
		const tx = writeTx(payer, { timeoutInSeconds: 120 });
		const { vault } = await vaultWithWriter({ deposit: () => tx });
		await vault.deposit(payer, 1n);
		const tb = (tx.signed as Transaction).timeBounds!;
		const span = Number(tb.maxTime) - Math.floor(Date.now() / 1000);
		expect(span).toBeGreaterThan(100);
		expect(span).toBeLessThanOrEqual(120);
	});
});
