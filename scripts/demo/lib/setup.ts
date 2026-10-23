import {
	endpointWireFields,
	type FixtureEndpoint,
	type FixtureWorker,
} from "./fixtures.ts"
import type { Flow } from "./report.ts"
import type { DemoApi, EndpointView, RecipientView } from "./types.ts"

// Every flow starts the same way: a neutral recipient and the endpoint it is paid to. Details are
// synthetic and in-memory; nothing here is a real account, e-wallet id or wallet address.

export interface WorkerHandles {
	recipient: RecipientView
	endpoint: EndpointView
}

export async function setUpWorker(
	api: DemoApi,
	flow: Flow,
	worker: FixtureWorker,
	endpoint: FixtureEndpoint,
): Promise<WorkerHandles> {
	const recipient = await api.createRecipient({
		name: worker.name,
		kind: worker.kind,
		country: worker.country,
	})
	flow.check(`recipient ${worker.name} created`)

	// CCR-16/17: map synthetic fixture refs into contracted detail keys (never syntheticRef).
	const wire = endpointWireFields(endpoint)
	const created = await api.createEndpoint({
		recipientId: recipient.id,
		type: endpoint.type,
		country: wire.country,
		currency: endpoint.currency,
		network: wire.network,
		details: wire.details,
		simulated: true,
	})
	flow.check(`endpoint ${endpoint.type} for ${worker.name} created`)
	return { recipient, endpoint: created }
}
