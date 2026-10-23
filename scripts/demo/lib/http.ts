// Minimal JSON client for the demo scripts. It never logs headers or bodies, applies an explicit
// timeout to every call, and returns non-2xx responses to the caller so a flow can assert the
// exact status instead of treating every reply as success.

export class NetworkFailure extends Error {
	constructor(message: string) {
		super(message)
		this.name = "NetworkFailure"
	}
}

export interface ApiResponse<T = unknown> {
	method: "GET" | "POST"
	path: string
	status: number
	body: T
	ms: number
}

export interface CallOptions {
	body?: unknown
	idempotencyKey?: string
	/** Public claim endpoints do not send the API key. */
	auth?: boolean
}

export class HttpClient {
	private readonly base: string
	private readonly apiKey: string
	private readonly timeoutMs: number

	constructor(base: string, apiKey: string, timeoutMs: number) {
		this.base = base
		this.apiKey = apiKey
		this.timeoutMs = timeoutMs
	}

	async call<T = unknown>(
		method: "GET" | "POST",
		path: string,
		options: CallOptions = {},
	): Promise<ApiResponse<T>> {
		const headers: Record<string, string> = { accept: "application/json" }
		if (options.auth !== false) headers.authorization = `Bearer ${this.apiKey}`
		if (options.body !== undefined) headers["content-type"] = "application/json"
		if (options.idempotencyKey)
			headers["idempotency-key"] = options.idempotencyKey

		const started = Date.now()
		let response: Response
		try {
			response = await fetch(`${this.base}${path}`, {
				method,
				headers,
				...(options.body === undefined
					? {}
					: { body: JSON.stringify(options.body) }),
				signal: AbortSignal.timeout(this.timeoutMs),
			})
		} catch (error) {
			const reason = error instanceof Error ? error.name : "unknown error"
			throw new NetworkFailure(
				`${method} ${path} did not complete (${reason}) within ${this.timeoutMs} ms`,
			)
		}

		const raw = await response.text()
		let body: unknown = undefined
		if (raw.length > 0) {
			try {
				body = JSON.parse(raw)
			} catch {
				throw new NetworkFailure(
					`${method} ${path} returned ${response.status} with a non-JSON body`,
				)
			}
		}
		return {
			method,
			path,
			status: response.status,
			body: body as T,
			ms: Date.now() - started,
		}
	}

	/**
	 * Reads until `until` accepts the response or the attempt budget runs out. Only used for GET,
	 * never to replay a mutation; idempotency is asserted separately in DF2.
	 */
	async poll<T>(
		path: string,
		until: (response: ApiResponse<T>) => boolean,
		options: { attempts?: number; delayMs?: number } = {},
	): Promise<ApiResponse<T>> {
		const attempts = options.attempts ?? 10
		const delayMs = options.delayMs ?? 250
		let last: ApiResponse<T> | undefined
		for (let i = 0; i < attempts; i++) {
			last = await this.call<T>("GET", path)
			if (until(last)) return last
			if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs))
		}
		return last!
	}
}

/** The API's JSON error body, if this response carries one. */
export function apiErrorCode(body: unknown): string | undefined {
	if (typeof body !== "object" || body === null) return undefined
	const code = (body as { code?: unknown }).code
	return typeof code === "string" ? code : undefined
}

export function apiErrorMessage(body: unknown): string | undefined {
	if (typeof body !== "object" || body === null) return undefined
	const message = (body as { message?: unknown }).message
	return typeof message === "string" ? message : undefined
}
