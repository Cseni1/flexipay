import { useEffect, useState } from "react"
import {
	listEndpoints,
	listRecipients,
	type EndpointSummary,
	type RecipientSummary,
} from "../api/client"

export type RecipientDirectory = {
	names: ReadonlyMap<string, string>
	endpointsByRecipient: ReadonlyMap<string, EndpointSummary[]>
	loading: boolean
}

/**
 * Loads recipient names (and endpoints) so list/detail screens can show
 * "To" as a person, not only a recipient id.
 */
export function useRecipientDirectory(): RecipientDirectory {
	const [names, setNames] = useState<ReadonlyMap<string, string>>(
		() => new Map(),
	)
	const [endpointsByRecipient, setEndpointsByRecipient] = useState<
		ReadonlyMap<string, EndpointSummary[]>
	>(() => new Map())
	const [loading, setLoading] = useState(true)

	useEffect(() => {
		const controller = new AbortController()
		let stopped = false
		const load = async () => {
			try {
				const [recipientsRes, endpointsRes] = await Promise.all([
					listRecipients(controller.signal),
					listEndpoints({ signal: controller.signal }),
				])
				if (stopped) return
				const nextNames = new Map<string, string>()
				for (const recipient of recipientsRes.recipients) {
					nextNames.set(recipient.id, recipient.name)
				}
				const nextEndpoints = new Map<string, EndpointSummary[]>()
				for (const endpoint of endpointsRes.endpoints) {
					const list = nextEndpoints.get(endpoint.recipientId) ?? []
					list.push(endpoint)
					nextEndpoints.set(endpoint.recipientId, list)
				}
				setNames(nextNames)
				setEndpointsByRecipient(nextEndpoints)
			} catch {
				if (stopped || controller.signal.aborted) return
				// Names stay empty; screens fall back to recipient id.
			} finally {
				if (!stopped) setLoading(false)
			}
		}
		void load()
		return () => {
			stopped = true
			controller.abort()
		}
	}, [])

	return { names, endpointsByRecipient, loading }
}

export function recipientDisplayName(
	names: ReadonlyMap<string, string>,
	recipientId: string,
): string {
	return names.get(recipientId)?.trim() || recipientId
}

export function primaryEndpoint(
	endpointsByRecipient: ReadonlyMap<string, EndpointSummary[]>,
	recipientId: string,
): EndpointSummary | null {
	return endpointsByRecipient.get(recipientId)?.[0] ?? null
}

export type { RecipientSummary }
