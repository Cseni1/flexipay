// @flexipay/web-lib — wallet and environment helpers shared by the web app.
// Framework-specific code (providers, stores, UI components) lives in apps/web.

export * from "./env" // rpcUrl, networkPassphrase, stellarNetwork, horizonUrl, network, labPrefix
export * from "./format" // shortAddress, formatNetworkName, networkStatus, NetworkState
export * from "./friendbot" // getFriendbotUrl
export * from "./subscription" // subscribeToEvents
export * from "./wallet" // connectWallet, disconnectWallet, profileModal, signTransaction, onWalletChange, fetchBalances, wallet, MappedBalances, WalletState
