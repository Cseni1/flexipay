import { contract, type Keypair } from "@stellar/stellar-sdk";
import { VAULT_ERRORS, VaultError, toVaultError } from "./vault-errors.ts";
import type { FeeMode } from "./vault-math.ts";
import type { StellarEnv } from "./stellar-env.ts";
import { rebuildAndValidateVaultWriteFee, VaultTxFeeError } from "./vault-tx-fee.ts";

// Typed access to the deployed payout_vault (contracts/payout_vault/RULES.md). It knows the
// chain, not payments: the settlement adapter (SC2) maps payments onto these calls once the
// CC0 settlement adapter interface (ARCHITECTURE §11.2) exists.

export type PayoutStatus = "Pending" | "Claimed" | "Refunded";

export interface Payout {
  id: bigint;
  payer: string;
  externalId: Buffer;
  claimHash: Buffer;
  gross: bigint;
  fee: bigint;
  net: bigint;
  locked: bigint;
  expiresAt: bigint;
  status: PayoutStatus;
}

/** A submitted vault call: its decoded result and the Stellar transaction hash. */
export interface Receipt<T> {
  result: T;
  txHash: string;
}

export class VaultConfigMismatch extends Error {
  readonly mismatches: string[];

  constructor(mismatches: string[]) {
    super(`payout_vault config does not match FP_ settings: ${mismatches.join("; ")}`);
    this.name = "VaultConfigMismatch";
    this.mismatches = mismatches;
  }
}

type Call = (args?: object) => Promise<contract.AssembledTransaction<unknown>>;
type VaultContract = contract.Client & Record<string, Call>;

const ERROR_TYPES = Object.fromEntries(
  Object.entries(VAULT_ERRORS).map(([code, name]) => [code, { message: name }]),
);

interface RawPayout {
  id: bigint;
  payer: string;
  external_id: Buffer;
  claim_hash: Buffer;
  gross: bigint;
  fee: bigint;
  net: bigint;
  locked: bigint;
  expires_at: bigint;
  status: { tag: PayoutStatus };
}

function toPayout(raw: RawPayout): Payout {
  return {
    id: raw.id,
    payer: raw.payer,
    externalId: Buffer.from(raw.external_id),
    claimHash: Buffer.from(raw.claim_hash),
    gross: raw.gross,
    fee: raw.fee,
    net: raw.net,
    locked: raw.locked,
    expiresAt: raw.expires_at,
    status: raw.status.tag,
  };
}

function isResult(value: unknown): value is contract.Result<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { isErr?: unknown }).isErr === "function"
  );
}

/** Unwraps a contract Result, turning a contract error into a VaultError. */
function unwrap<T>(value: unknown, simulationError?: string): T {
  if (!isResult(value)) return value as T;
  if (value.isOk()) return value.unwrap() as T;
  const err = toVaultError(value.unwrapErr()) ?? toVaultError(simulationError ?? "");
  throw err ?? new Error(`payout_vault call failed: ${simulationError ?? "unknown error"}`);
}

function simulationError(tx: contract.AssembledTransaction<unknown>): string | undefined {
  const sim = tx.simulation as { error?: string } | undefined;
  return sim?.error;
}

export class PayoutVault {
  readonly env: StellarEnv;
  private readonly reader: VaultContract;
  private readonly writers = new Map<string, Promise<VaultContract>>();

  private constructor(env: StellarEnv, reader: VaultContract) {
    this.env = env;
    this.reader = reader;
  }

  /** Connects to the vault named by FP_PAYOUT_VAULT_ID and checks its config (fails fast). */
  static async connect(env: StellarEnv, { verify = true } = {}): Promise<PayoutVault> {
    const reader = (await contract.Client.from({
      contractId: env.payoutVaultId,
      rpcUrl: env.rpcUrl,
      networkPassphrase: env.networkPassphrase,
      errorTypes: ERROR_TYPES,
    })) as VaultContract;
    const vault = new PayoutVault(env, reader);
    if (verify) await vault.verifyConfig();
    return vault;
  }

  /** Token, treasury and fee on-chain must equal the FP_ settings, or the adapter stops. */
  async verifyConfig(): Promise<void> {
    const [token, treasury, feeBps] = await this.config();
    const mismatches: string[] = [];
    if (token !== this.env.usdcContractId) {
      mismatches.push(`token ${token} != FP_USDC_CONTRACT_ID ${this.env.usdcContractId}`);
    }
    if (treasury !== this.env.treasuryAddress) {
      mismatches.push(`treasury ${treasury} != FP_TREASURY_ADDRESS ${this.env.treasuryAddress}`);
    }
    if (feeBps !== this.env.vaultFeeBps) {
      mismatches.push(`fee_bps ${feeBps} != FP_VAULT_FEE_BPS ${this.env.vaultFeeBps}`);
    }
    if (mismatches.length > 0) throw new VaultConfigMismatch(mismatches);
  }

  // ---- reads (simulation only, no signature, no fee) ----

  async config(): Promise<[string, string, number]> {
    return this.read<[string, string, number]>("config");
  }

  /** The fixed vault fee a quote must use for vault-settled routes (ARCHITECTURE §8). */
  async feeBps(): Promise<number> {
    return (await this.config())[2];
  }

  async getPayout(id: bigint): Promise<Payout> {
    return toPayout(await this.read<RawPayout>("get_payout", { id }));
  }

  async payoutByExternal(payer: string, externalId: Buffer): Promise<bigint | undefined> {
    const id = await this.read<bigint | null>("payout_by_external", {
      payer,
      external_id: externalId,
    });
    return id ?? undefined;
  }

  async balance(payer: string): Promise<bigint> {
    return this.read<bigint>("balance", { payer });
  }

  // ---- writes (signed by the account that must authorise) ----

  async deposit(payer: Keypair, amount: bigint): Promise<Receipt<void>> {
    return this.write(payer, "deposit", { payer: payer.publicKey(), amount });
  }

  async withdraw(payer: Keypair, amount: bigint): Promise<Receipt<void>> {
    return this.write(payer, "withdraw", { payer: payer.publicKey(), amount });
  }

  /** Locks a payout. Returns the payout id. */
  async createPayout(
    payer: Keypair,
    p: { externalId: Buffer; claimHash: Buffer; amount: bigint; mode: FeeMode; expiresAt: bigint },
  ): Promise<Receipt<bigint>> {
    return this.write(payer, "create_payout", {
      payer: payer.publicKey(),
      external_id: p.externalId,
      claim_hash: p.claimHash,
      amount: p.amount,
      mode: { tag: p.mode, values: undefined },
      expires_at: p.expiresAt,
    });
  }

  /**
   * Releases a payout to `to` with the claim secret. The receiving account signs, because the
   * vault asks the receiver to authorise. Returns the amount received.
   */
  async claim(receiver: Keypair, p: { id: bigint; secret: Buffer }): Promise<Receipt<bigint>> {
    return this.write(receiver, "claim", { id: p.id, secret: p.secret, to: receiver.publicKey() });
  }

  async cancel(payer: Keypair, id: bigint): Promise<Receipt<void>> {
    return this.write(payer, "cancel", { id });
  }

  /** Permissionless after expiry: any funded account can submit it. */
  async refund(submitter: Keypair, id: bigint): Promise<Receipt<void>> {
    return this.write(submitter, "refund", { id });
  }

  // ---- internals ----

  private async read<T>(method: string, args?: object): Promise<T> {
    const tx = await this.reader[method](args);
    return unwrap<T>(tx.result, simulationError(tx));
  }

  private async write<T>(signer: Keypair, method: string, args: object): Promise<Receipt<T>> {
    const client = await this.writerFor(signer);
    const tx = await client[method](args);
    // Fail before sending when the simulation already shows a contract error.
    unwrap<T>(tx.result, simulationError(tx));
    try {
      // Build-once fee path: avoid AssembledTransaction.sign()'s fee: built.fee override,
      // which double-counts resourceFee and can overflow uint32 (M2 fee diagnosis).
      let sorobanData;
      try {
        sorobanData = tx.simulationData.transactionData;
      } catch (err) {
        throw new VaultTxFeeError(
          "missing_simulation_data",
          `payout_vault ${method}: simulationData unavailable: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      // sign() refused a transaction that still needs other classic signers; keep that guard.
      const otherSigners = tx.needsNonInvokerSigningBy().filter((id) => !id.startsWith("C"));
      if (otherSigners.length > 0) {
        throw new Error(
          `payout_vault ${method}: transaction needs signatures from ${otherSigners.join(", ")}`,
        );
      }
      const timeoutInSeconds = tx.options.timeoutInSeconds ?? contract.DEFAULT_TIMEOUT;
      const { tx: rebuilt } = rebuildAndValidateVaultWriteFee({
        built: tx.built,
        sorobanData,
        ceilingStroops: this.env.sorobanTxFeeCeilingStroops,
        timeoutInSeconds,
      });

      // Sign the rebuilt envelope directly (same end state as sign() after its rebuild),
      // then send via AssembledTransaction.send without calling signAndSend.
      rebuilt.sign(signer);
      tx.built = rebuilt;
      tx.signed = rebuilt;
      const sent = await tx.send();
      const txHash = sent.sendTransactionResponse?.hash;
      if (!txHash) throw new Error(`payout_vault ${method}: no transaction hash returned`);
      return { result: unwrap<T>(sent.result), txHash };
    } catch (err) {
      if (err instanceof VaultTxFeeError) throw err;
      throw toVaultError(err) ?? err;
    }
  }

  private writerFor(signer: Keypair): Promise<VaultContract> {
    const key = signer.publicKey();
    let client = this.writers.get(key);
    if (!client) {
      const { signTransaction } = contract.basicNodeSigner(signer, this.env.networkPassphrase);
      client = contract.Client.from({
        contractId: this.env.payoutVaultId,
        rpcUrl: this.env.rpcUrl,
        networkPassphrase: this.env.networkPassphrase,
        errorTypes: ERROR_TYPES,
        publicKey: key,
        signTransaction,
      }) as Promise<VaultContract>;
      this.writers.set(key, client);
    }
    return client;
  }
}

export { VaultError, VaultTxFeeError };
