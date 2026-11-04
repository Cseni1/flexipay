import {
	CrossmintEmbeddedCheckout,
	CrossmintProvider,
} from "@crossmint/client-sdk-react-ui"

type Props = {
	apiKey: string
	orderId: string
	clientSecret: string
	receiptEmail: string
}

/**
 * Embedded Crossmint card checkout for a server-created onramp order.
 * Staging / test mode only — never pass a production client key here.
 */
export function CrossmintCardCheckout({
	apiKey,
	orderId,
	clientSecret,
	receiptEmail,
}: Props) {
	return (
		<div data-testid="crossmint-card-checkout">
			<CrossmintProvider apiKey={apiKey}>
				<CrossmintEmbeddedCheckout
					orderId={orderId}
					clientSecret={clientSecret}
					payment={{
						receiptEmail,
						crypto: { enabled: false },
						fiat: { enabled: true },
						defaultMethod: "fiat",
					}}
				/>
			</CrossmintProvider>
		</div>
	)
}
