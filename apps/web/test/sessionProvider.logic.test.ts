import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, test, vi } from "vitest"
import { flush, provideContext, renderHook } from "./helpers/fakeReact.ts"

vi.mock("react", () => import("./helpers/fakeReact.ts"))
vi.mock("react-router-dom", () => ({
	Navigate: "Navigate",
	useLocation: () => ({ pathname: "/payments" }),
}))

const fetchSession = vi.fn<() => Promise<unknown>>()
const signOut = vi.fn<() => Promise<unknown>>()
vi.mock("../src/api/auth.ts", () => ({
	fetchSession: () => fetchSession(),
	signOut: () => signOut(),
}))

const setCustomerSessionActive = vi.fn<(active: boolean) => void>()
vi.mock("../src/api/client.ts", () => ({
	UNAUTHORIZED_EVENT: "flexipay:unauthorized",
	setCustomerSessionActive: (active: boolean) =>
		setCustomerSessionActive(active),
}))

type Api = {
	state: { status: string }
	refresh: () => Promise<void>
	logout: () => Promise<void>
	viaSession: boolean
}
type Element = { type: unknown; props: Record<string, unknown> }

// SessionProvider is JSX and uses `window`; the Node tsconfig that `tsc -b` applies to
// test/ has neither, so it loads untyped with the shape stated here.
const load = <T>(path: string): Promise<T> =>
	import(/* @vite-ignore */ path) as Promise<T>
const { SessionProvider, useSession, RequireSession } = await load<{
	SessionProvider: (props: { children: unknown }) => unknown
	useSession: () => Api
	RequireSession: (props: { children: unknown }) => unknown
}>("../src/providers/SessionProvider.tsx")

let fakeWindow = new EventTarget()

const providerValue = (hook: { current: unknown }): Api =>
	(hook.current as Element).props.value as Api

const sessionInfo = (via: "session" | "api_key") => ({
	via,
	organization: { id: "org", name: "Org" },
	user: via === "session" ? { id: "u", email: "a@b.c", name: "A" } : null,
})

beforeEach(() => {
	fetchSession.mockReset()
	signOut.mockReset()
	setCustomerSessionActive.mockReset()
	fakeWindow = new EventTarget()
	vi.stubGlobal("window", fakeWindow)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

const mount = () =>
	renderHook(() => SessionProvider({ children: "child" }) as unknown)

describe("SessionProvider state machine", () => {
	test("loading → signed_in via customer session flags the client and listens for 401s", async () => {
		fetchSession.mockResolvedValue(sessionInfo("session"))
		const hook = mount()
		assert.equal(providerValue(hook).state.status, "loading")
		await flush()
		const api = providerValue(hook)
		assert.equal(api.state.status, "signed_in")
		assert.equal(api.viaSession, true)
		assert.deepEqual(setCustomerSessionActive.mock.calls.at(-1), [true])

		fetchSession.mockResolvedValue(null)
		fakeWindow.dispatchEvent(new Event("flexipay:unauthorized"))
		await flush()
		assert.equal(providerValue(hook).state.status, "signed_out")
		assert.deepEqual(setCustomerSessionActive.mock.calls.at(-1), [false])
		hook.unmount()
	})

	test("api-key mode is signed in but not via session and ignores 401 events", async () => {
		fetchSession.mockResolvedValue(sessionInfo("api_key"))
		const hook = mount()
		await flush()
		assert.equal(providerValue(hook).viaSession, false)
		fakeWindow.dispatchEvent(new Event("flexipay:unauthorized"))
		await flush()
		assert.equal(fetchSession.mock.calls.length, 1)
	})

	test("unconfigured proxy and failures map to their own states", async () => {
		fetchSession.mockResolvedValue("unconfigured")
		const a = mount()
		await flush()
		assert.equal(providerValue(a).state.status, "unconfigured")

		fetchSession.mockRejectedValue(new Error("down"))
		const b = mount()
		await flush()
		assert.equal(providerValue(b).state.status, "error")
	})

	test("logout signs out even when the API call fails", async () => {
		fetchSession.mockResolvedValue(sessionInfo("session"))
		const hook = mount()
		await flush()
		signOut.mockRejectedValue(new Error("offline"))
		await assert.rejects(() => providerValue(hook).logout(), /offline/)
		assert.equal(providerValue(hook).state.status, "signed_out")
	})
})

describe("useSession / RequireSession", () => {
	const ctx = (): unknown => {
		// The provider's element type is the context's Provider; reach the context from it.
		fetchSession.mockResolvedValue(null)
		const hook = mount()
		const type = (hook.current as Element).type as { context: unknown }
		return type.context
	}

	test("useSession throws outside the provider", () => {
		const context = ctx()
		provideContext(context, undefined)
		assert.throws(
			() => renderHook(() => useSession()),
			/inside SessionProvider/,
		)
	})

	const renderGate = (status: string) => {
		const context = ctx()
		provideContext(context, { state: { status } })
		const out = renderHook(
			() => RequireSession({ children: "secret" }) as unknown,
		).current as Element
		provideContext(context, undefined)
		return out
	}

	test("shows loading, redirects signed-out visitors, explains errors, renders children", () => {
		assert.equal(renderGate("loading").props["aria-busy"], "true")

		const redirect = renderGate("signed_out")
		assert.equal(redirect.type, "Navigate")
		assert.equal(redirect.props.to, "/login")
		assert.deepEqual(redirect.props.state, { from: "/payments" })

		assert.equal(renderGate("error").props.role, "alert")
		assert.equal(renderGate("signed_in").props.children, "secret")
		assert.equal(renderGate("unconfigured").props.children, "secret")
	})
})
