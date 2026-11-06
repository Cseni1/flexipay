// Minimal JSON HTTP helper for partner adapters (CCR-29). Never logs headers or bodies, so keys
// cannot leak through it.

export type FetchLike = (
	url: string,
	init: {
		method: string
		headers: Record<string, string>
		body?: string
		signal?: AbortSignal
	},
) => Promise<{ status: number; text(): Promise<string> }>

export interface HttpResult {
	status: number
	json: unknown
}

export interface JsonRequest {
	method: "GET" | "POST"
	url: string
	headers: Record<string, string>
	body?: unknown
	timeoutMs?: number
}

export async function jsonRequest(
	fetchImpl: FetchLike,
	req: JsonRequest,
): Promise<HttpResult> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 20_000)
	try {
		const res = await fetchImpl(req.url, {
			method: req.method,
			headers: {
				Accept: "application/json",
				...(req.body !== undefined
					? { "Content-Type": "application/json" }
					: {}),
				...req.headers,
			},
			body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
			signal: controller.signal,
		})
		const text = await res.text()
		let json: unknown = null
		if (text) {
			try {
				json = JSON.parse(text)
			} catch {
				json = null
			}
		}
		return { status: res.status, json }
	} finally {
		clearTimeout(timer)
	}
}
