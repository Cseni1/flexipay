/** Browser-safe Solana adapter surface (no `process` / env loaders). */
export { isSolanaAddress, parseSolanaAddress } from "./address.ts";
export {
	AMOUNT_NOT_REPRESENTABLE_CODE,
	AmountNotRepresentableError,
	FLEXIPAY_USDC_DECIMALS,
	flexipayUsdcToSolanaMinor,
} from "./amount.ts";
export {
	buildUsdcTransferTransaction,
	getSolAndUsdcBalances,
	type BuildUsdcTransferInput,
	type BuiltUsdcTransfer,
} from "./build-transfer.ts";
