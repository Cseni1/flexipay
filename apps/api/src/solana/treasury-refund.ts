import { Connection, type Keypair } from "@solana/web3.js";
import {
	connectionAsRefundRpc,
	loadTreasuryRefundSigner as loadSigner,
	prepareTreasuryRefund,
	refundSignatureStatus,
	sendPreparedTreasuryRefund,
	type PreparedTreasuryRefund,
	type SolanaRefundRpc,
} from "@flexipay/adapter-solana";
import { getSolanaRuntimeConfig } from "./runtime-config.ts";

let rpcForTests: SolanaRefundRpc | null = null;

/** Test-only hook. Production code must not call this. */
export function setSolanaRefundRpcForTests(rpc: SolanaRefundRpc | null): void {
	rpcForTests = rpc ?? null;
}

export function getSolanaRefundRpc(): SolanaRefundRpc {
	if (rpcForTests) return rpcForTests;
	const cfg = getSolanaRuntimeConfig();
	return connectionAsRefundRpc(new Connection(cfg.rpcUrl, "confirmed"));
}

/** Signer for the stored treasury; refuses a secret whose public key does not match. */
export function treasuryRefundSigner(treasury: string): Keypair {
	return loadSigner(process.env, treasury);
}

export {
	prepareTreasuryRefund,
	refundSignatureStatus,
	sendPreparedTreasuryRefund,
	type PreparedTreasuryRefund,
	type SolanaRefundRpc,
};
