import {
	connectionAsRpc,
	verifyUsdcTransfer,
	type SolanaRpc,
	type TransferVerifyInput,
	type TransferVerifyResult,
} from "@flexipay/adapter-solana";
import { Connection } from "@solana/web3.js";
import { getSolanaRuntimeConfig } from "./runtime-config.ts";

export type SolanaVerifyFn = (
	rpc: SolanaRpc,
	input: TransferVerifyInput,
) => Promise<TransferVerifyResult>;

let verifyImpl: SolanaVerifyFn = verifyUsdcTransfer;

/** Test-only hook. Production code must not call this. */
export function setSolanaVerifyForTests(fn: SolanaVerifyFn | null): void {
	verifyImpl = fn ?? verifyUsdcTransfer;
}

export async function verifyPaymentTransfer(
	input: TransferVerifyInput,
): Promise<TransferVerifyResult> {
	const cfg = getSolanaRuntimeConfig();
	const connection = new Connection(cfg.rpcUrl, "confirmed");
	return verifyImpl(connectionAsRpc(connection), input);
}
