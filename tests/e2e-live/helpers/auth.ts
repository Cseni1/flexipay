import { expect, type Page } from "@playwright/test"
import { liveCredentials } from "./credentials"

/** Sign in against the live app. Does not print or assert credential values. */
export async function signInLive(page: Page): Promise<void> {
	const { email, password, ready } = liveCredentials()
	if (!ready) {
		throw new Error("signInLive called without FP_QA_EMAIL / FP_QA_PASSWORD")
	}
	await page.goto("/login")
	await page.getByLabel("Email").fill(email)
	await page.getByLabel("Password").fill(password)
	await page.getByRole("button", { name: "Sign in" }).click()
	// Session box proves auth without echoing the address into the assertion text.
	await expect(page.getByTestId("session-box")).toBeVisible({ timeout: 90_000 })
}
