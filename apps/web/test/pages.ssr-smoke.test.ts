/**
 * Server-render smoke tests: every routed page renders its first (loading) frame without
 * throwing. Effects never run during a static prerender, so no network or wallet calls are
 * made; lazy panels are awaited so their markup is checked too.
 * Interaction and data states are covered by Playwright (tests/e2e-ui); this only guards
 * against render-time crashes and keeps the initial markup honest.
 */
import assert from "node:assert/strict"
import { createElement, type ComponentType, type ReactNode } from "react"
import { prerender } from "react-dom/static"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, test, vi } from "vitest"

// Source modules here are JSX or use DOM globals, which the Node tsconfig that `tsc -b`
// applies to test/ does not include, so they are imported by (untyped) path.
const paths = vi.hoisted(() => ({
	privyStub: "../src/flexipayWallet/privySdk.stub.tsx",
}))

// The Playwright SDK stub stands in for Privy (no network, no keys).
vi.mock(
	"@privy-io/react-auth",
	() => import(/* @vite-ignore */ paths.privyStub),
)
vi.mock(
	"@privy-io/react-auth/solana",
	() => import(/* @vite-ignore */ paths.privyStub),
)

const load = <T>(path: string): Promise<T> =>
	import(/* @vite-ignore */ path) as Promise<T>

type Provider = ComponentType<{ children?: ReactNode }>
const { SessionProvider } = await load<{ SessionProvider: Provider }>(
	"../src/providers/SessionProvider.tsx",
)

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("SSR smoke tests must not fetch")
		}),
	)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

const render = async (
	element: ReactNode,
	path = "/",
	pattern = "*",
): Promise<string> => {
	const { prelude } = await prerender(
		createElement(
			MemoryRouter,
			{ initialEntries: [path] },
			createElement(
				SessionProvider,
				null,
				createElement(
					Routes,
					null,
					createElement(Route, { path: pattern, element }),
				),
			),
		),
	)
	return new Response(prelude).text()
}

const page = async (
	modulePath: string,
	exportName = "default",
): Promise<ComponentType> => {
	const mod = await load<Record<string, ComponentType>>(modulePath)
	const component = mod[exportName]
	assert.ok(component, `${modulePath} has no ${exportName} export`)
	return component
}

const cases: Array<{
	name: string
	module: string
	exportName?: string
	path?: string
	pattern?: string
	expect: RegExp
}> = [
	{
		name: "Send payment",
		module: "../src/pages/SendPayment.tsx",
		expect: /Send a payment/,
	},
	{
		name: "Take payment",
		module: "../src/pages/TakePayment.tsx",
		expect: /Get paid/,
	},
	{
		name: "Dashboard",
		module: "../src/pages/Dashboard.tsx",
		expect: /Loading payments/,
	},
	{
		name: "Payments history",
		module: "../src/pages/PaymentsHistory.tsx",
		expect: /Search by payment id/,
	},
	{
		name: "Recipients",
		module: "../src/pages/Recipients.tsx",
		expect: /Recipients/,
	},
	{
		name: "Pay from",
		module: "../src/pages/PayFrom.tsx",
		expect: /Other funding methods/,
	},
	{
		name: "FlexiPay wallet",
		module: "../src/pages/FlexiPayWallet.tsx",
		expect: /Embedded FlexiPay wallet/,
	},
	{
		name: "Developers",
		module: "../src/pages/Developers.tsx",
		expect: /Quickstart/,
	},
	{
		name: "Where we pay",
		module: "../src/pages/WhereWePay.tsx",
		expect: /page-header__title/,
	},
	{ name: "Account", module: "../src/pages/Account.tsx", expect: /API keys/ },
	{
		name: "Payment detail",
		module: "../src/pages/PaymentDetail.tsx",
		path: "/payments/pay_1",
		pattern: "payments/:paymentId",
		expect: /Loading payment…/,
	},
	{
		name: "Claim",
		module: "../src/pages/ClaimPage.tsx",
		path: "/claim/tok_1",
		pattern: "claim/:claimToken",
		expect: /Loading claim…/,
	},
	{
		name: "Login",
		module: "../src/pages/AuthPages.tsx",
		exportName: "LoginPage",
		expect: /Sign in to FlexiPay/,
	},
	{
		name: "Register",
		module: "../src/pages/AuthPages.tsx",
		exportName: "RegisterPage",
		expect: /Create your FlexiPay account/,
	},
	{
		name: "Forgot password",
		module: "../src/pages/AuthPages.tsx",
		exportName: "ForgotPasswordPage",
		expect: /Reset your password/,
	},
	{
		name: "Reset password",
		module: "../src/pages/AuthPages.tsx",
		exportName: "ResetPasswordPage",
		path: "/reset-password?token=t",
		expect: /Choose a new password/,
	},
]

describe("pages render their first frame (SSR smoke)", () => {
	for (const c of cases) {
		test(c.name, async () => {
			const Component = await page(c.module, c.exportName)
			const html = await render(createElement(Component), c.path, c.pattern)
			assert.doesNotMatch(html, /Switched to client rendering/)
			assert.match(html, c.expect)
			assert.equal(vi.mocked(fetch).mock.calls.length, 0)
		})
	}
})
