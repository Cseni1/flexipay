import {
	createContext,
	useContext,
	useEffect,
	useState,
	type ReactNode,
} from "react"
import { getSolanaConfig } from "../api/solanaClient"

const LiveMoneyContext = createContext(false)

export function useLiveMoney(): boolean {
	return useContext(LiveMoneyContext)
}

/** Live only when the public Solana config says mainnet-beta. Failures stay in test mode. */
export function LiveMoneyProvider({ children }: { children: ReactNode }) {
	const [live, setLive] = useState(false)
	useEffect(() => {
		const controller = new AbortController()
		getSolanaConfig(controller.signal)
			.then((config) => {
				if (!controller.signal.aborted) {
					setLive(config.cluster === "mainnet-beta")
				}
			})
			.catch(() => {
				if (!controller.signal.aborted) setLive(false)
			})
		return () => controller.abort()
	}, [])
	return (
		<LiveMoneyContext.Provider value={live}>
			{children}
		</LiveMoneyContext.Provider>
	)
}
