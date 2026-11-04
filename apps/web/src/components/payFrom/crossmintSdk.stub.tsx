import { type ReactNode } from "react"

/**
 * Playwright-only stand-in for @crossmint/client-sdk-react-ui.
 * Enabled via FP_CROSSMINT_SDK_STUB=1 on the Vite webServer — no real Crossmint calls.
 */
export function CrossmintProvider({ children }: { children?: ReactNode }) {
	return <>{children}</>
}

export function CrossmintEmbeddedCheckout(props: {
	orderId: string
	clientSecret: string
	payment?: unknown
}) {
	return (
		<div data-testid="crossmint-embedded-stub">
			Crossmint checkout stub (order {props.orderId})
		</div>
	)
}
