import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { money } from "@flexipay/domain";
import {
  PayoutVault,
  VaultConfigMismatch,
  VaultError,
  createStellarSettlementAdapter,
  externalIdFor,
  loadStellarEnv,
  loadTestnetEnvFiles,
  newClaimSecret,
  parseEnvFile,
  payoutAmounts,
} from "../src/index.js";

// Runs against the deployed vault on Stellar testnet. Opt in with FP_TESTNET=1.
// Needs scripts/testnet/.env.secrets from scripts/testnet/setup.sh (git-ignored).

const testnetDir = fileURLToPath(new URL("../../../scripts/testnet/", import.meta.url));
const enabled = process.env.FP_TESTNET === "1";

const UNIT = 10_000_000n;
const AMOUNT = UNIT; // 1 test USDC

async function expectVaultError(p: Promise<unknown>, code: number) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(VaultError);
  expect((err as VaultError).code).toBe(code);
}

describe.skipIf(!enabled)("payout_vault on testnet", { timeout: 300_000 }, () => {
  const ids = parseEnvFile(readFileSync(`${testnetDir}testnet-ids.env`, "utf8"));
  const env = loadStellarEnv(ids);
  let vault: PayoutVault;
  let payer: Keypair;
  let workerA: Keypair;
  const runId = `sc2_${Date.now()}`;
  const hashes: Record<string, string> = {};

  beforeAll(async () => {
    const secretsFile = `${testnetDir}.env.secrets`;
    if (!existsSync(secretsFile)) throw new Error("Run scripts/testnet/setup.sh first");
    const secrets = parseEnvFile(readFileSync(secretsFile, "utf8"));
    payer = Keypair.fromSecret(secrets.FP_PAYER_DEMO_SECRET);
    workerA = Keypair.fromSecret(secrets.FP_RECIPIENT_A_SECRET);
    vault = await PayoutVault.connect(env);
  });

  it("stops on a config mismatch", async () => {
    await expect(PayoutVault.connect({ ...env, vaultFeeBps: 0 })).rejects.toBeInstanceOf(
      VaultConfigMismatch,
    );
    expect(await vault.feeBps()).toBe(env.vaultFeeBps);
  });

  it("locks, rejects the same attempt, and releases to Worker A", async () => {
    const paymentId = `${runId}_a`;
    const externalId = externalIdFor(paymentId, 1);
    const { secret, claimHash } = newClaimSecret();
    const expected = payoutAmounts(AMOUNT, env.vaultFeeBps, "PayerPays");
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);

    hashes.deposit = (await vault.deposit(payer, expected.locked)).txHash;
    const lock = await vault.createPayout(payer, {
      externalId,
      claimHash,
      amount: AMOUNT,
      mode: "PayerPays",
      expiresAt,
    });
    hashes.lock = lock.txHash;
    expect(lock.txHash).toMatch(/^[0-9a-f]{64}$/);

    const stored = await vault.getPayout(lock.result);
    expect(stored).toMatchObject({
      payer: payer.publicKey(),
      status: "Pending",
      gross: AMOUNT,
      ...expected,
    });
    expect(stored.externalId.equals(externalId)).toBe(true);
    expect(await vault.payoutByExternal(payer.publicKey(), externalId)).toBe(lock.result);

    // the same attempt is rejected before anything is sent
    await expectVaultError(
      vault.createPayout(payer, { externalId, claimHash, amount: AMOUNT, mode: "PayerPays", expiresAt }),
      12,
    );
    // a wrong secret is rejected
    await expectVaultError(vault.claim(workerA, { id: lock.result, secret: Buffer.alloc(32) }), 10);

    const release = await vault.claim(workerA, { id: lock.result, secret });
    hashes.release = release.txHash;
    expect(release.result).toBe(expected.net);
    expect((await vault.getPayout(lock.result)).status).toBe("Claimed");
  });

  it("keeps an id used after cancel; the next attempt locks", async () => {
    const paymentId = `${runId}_b`;
    const { claimHash } = newClaimSecret();
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const { locked } = payoutAmounts(AMOUNT, env.vaultFeeBps, "PayerPays");
    await vault.deposit(payer, locked);

    const first = await vault.createPayout(payer, {
      externalId: externalIdFor(paymentId, 1),
      claimHash,
      amount: AMOUNT,
      mode: "PayerPays",
      expiresAt,
    });
    hashes.cancel = (await vault.cancel(payer, first.result)).txHash;
    expect((await vault.getPayout(first.result)).status).toBe("Refunded");

    await expectVaultError(
      vault.createPayout(payer, {
        externalId: externalIdFor(paymentId, 1),
        claimHash,
        amount: AMOUNT,
        mode: "PayerPays",
        expiresAt,
      }),
      12,
    );
    const second = await vault.createPayout(payer, {
      externalId: externalIdFor(paymentId, 2),
      claimHash,
      amount: AMOUNT,
      mode: "PayerPays",
      expiresAt,
    });
    expect(second.result).toBeGreaterThan(first.result);

    // return the test funds to the payer
    await vault.cancel(payer, second.result);
    await vault.withdraw(payer, locked);
    console.info(`testnet tx hashes (${runId}):`, hashes);
  });
});

describe.skipIf(!enabled)("StellarSettlementAdapter on testnet", { timeout: 300_000 }, () => {
  const runId = `sc2_adapter_${Date.now()}`;
  const hashes: Record<string, string> = {};
  let adapter: Awaited<ReturnType<typeof createStellarSettlementAdapter>>["adapter"];
  let wallets: Awaited<ReturnType<typeof createStellarSettlementAdapter>>["wallets"];
  let payerAddress: string;
  let workerA: string;

  beforeAll(async () => {
    const secretsFile = `${testnetDir}.env.secrets`;
    if (!existsSync(secretsFile)) throw new Error("Run scripts/testnet/setup.sh first");
    const env = loadTestnetEnvFiles({
      idsPath: `${testnetDir}testnet-ids.env`,
      secretsPath: secretsFile,
    });
    ({ adapter, wallets } = await createStellarSettlementAdapter({ env }));
    payerAddress = wallets.addressOf("payer_demo");
    workerA = wallets.addressOf("worker_a");
  });

  it("funds, locks, rejects duplicate attempt, releases to Worker A with a tx hash", async () => {
    const paymentId = `${runId}_claim`;
    const { secret, claimHash } = newClaimSecret();
    const amount = money(AMOUNT, "USDC");
    const expiresAt = new Date(Date.now() + 3_600_000);

    expect(await adapter.feeBps()).toBe(100);

    hashes.fund = (await adapter.fundVault(payerAddress, money("10100000", "USDC"))).txRef;
    const locked = await adapter.lock({
      paymentId,
      attempt: 1,
      payer: payerAddress,
      amount,
      feeMode: "PayerPays",
      expiresAt,
      claimHashHex: claimHash.toString("hex"),
    });
    hashes.lock = locked.txRef;
    expect(locked.txRef).toMatch(/^[0-9a-f]{64}$/);
    expect(locked.externalIdHex).toBe(externalIdFor(paymentId, 1).toString("hex"));
    expect(locked.net).toEqual(amount);
    expect(await adapter.findLock(payerAddress, paymentId, 1)).toBe(locked.payoutId);

    await expect(
      adapter.lock({
        paymentId,
        attempt: 1,
        payer: payerAddress,
        amount,
        feeMode: "PayerPays",
        expiresAt,
        claimHashHex: claimHash.toString("hex"),
      }),
    ).rejects.toMatchObject({ name: "SettlementError", code: 12 });

    const released = await adapter.release({
      payoutId: locked.payoutId,
      secretHex: secret.toString("hex"),
      destination: workerA,
    });
    hashes.release = released.txRef;
    expect(released.txRef).toMatch(/^[0-9a-f]{64}$/);
    expect(released.received).toEqual(amount);
    expect((await adapter.status(locked.payoutId)).state).toBe("claimed");
    console.info(`adapter testnet tx hashes (${runId}):`, hashes);
  });

  it("cancels a pending lock and refuses to reuse the same attempt", async () => {
    const paymentId = `${runId}_cancel`;
    const { claimHash } = newClaimSecret();
    const amount = money(AMOUNT, "USDC");
    const expiresAt = new Date(Date.now() + 3_600_000);

    await adapter.fundVault(payerAddress, money("10100000", "USDC"));
    const locked = await adapter.lock({
      paymentId,
      attempt: 1,
      payer: payerAddress,
      amount,
      feeMode: "PayerPays",
      expiresAt,
      claimHashHex: claimHash.toString("hex"),
    });
    const cancelled = await adapter.refund(locked.payoutId);
    expect(cancelled.txRef).toMatch(/^[0-9a-f]{64}$/);
    expect((await adapter.status(locked.payoutId)).state).toBe("refunded");

    await expect(
      adapter.lock({
        paymentId,
        attempt: 1,
        payer: payerAddress,
        amount,
        feeMode: "PayerPays",
        expiresAt,
        claimHashHex: claimHash.toString("hex"),
      }),
    ).rejects.toMatchObject({ name: "SettlementError", code: 12 });

    const second = await adapter.lock({
      paymentId,
      attempt: 2,
      payer: payerAddress,
      amount,
      feeMode: "PayerPays",
      expiresAt,
      claimHashHex: claimHash.toString("hex"),
    });
    await adapter.refund(second.payoutId);
  });
});
