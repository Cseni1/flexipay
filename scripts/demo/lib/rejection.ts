/** An expected API refusal (for example an ineligible quote), mapped by the A0 adapter. */
export class ApiRejection extends Error {
	readonly status: number
	readonly code?: string
	readonly reasons: string[]

	constructor(
		status: number,
		options: { code?: string; message?: string; reasons?: string[] } = {},
	) {
		super(options.message ?? `API rejected the request with ${status}`)
		this.name = "ApiRejection"
		this.status = status
		this.code = options.code
		this.reasons = options.reasons ?? []
	}
}
