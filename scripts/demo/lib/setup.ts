import type { FixtureEndpoint, FixtureWorker } from "./fixtures.ts"
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

	const created = await api.createEndpoint({
		recipientId: recipient.id,
		type: endpoint.type,
		country: endpoint.country,
		currency: endpoint.currency,
		...(endpoint.network ? { network: endpoint.network } : {}),
		details: { syntheticRef: endpoint.detailsRef },
		simulated: true,
	})
	flow.check(`endpoint ${endpoint.type} for ${worker.name} created`)
	return { recipient, endpoint: created }
}
