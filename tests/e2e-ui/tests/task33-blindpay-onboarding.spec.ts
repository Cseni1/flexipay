import { expect, test } from "@playwright/test"

// CCR-46: BlindPay sends the sender back with ?tos_id=; FlexiPay saves it and the sender
// uploads ID and selfie photos instead of pasting links.

const png = Buffer.from(
	"89504e470d0a1a0a0000000d4948445200000001000000010806000000",
	"hex",
)

test("terms return saves the id, then ID and selfie uploads enable submit", async ({
	page,
}) => {
	let savedTos: unknown = null
	const uploads: string[] = []
	await page.route(/\/v1\/blindpay\/onboarding\/tos$/, async (route) => {
		savedTos = route.request().postDataJSON()
		await route.fulfill({
			json: { receiverId: null, kycStatus: null, next: { step: "submit_kyc" } },
		})
	})
	await page.route(/\/v1\/blindpay\/onboarding\/upload$/, async (route) => {
		const type = route.request().headers()["content-type"] ?? ""
		uploads.push(type)
		await route.fulfill({
			json: {
				fileUrl: `https://files.blindpay.com/${uploads.length}-kyc.png`,
			},
		})
	})
	await page.goto("/blindpay/terms-done?tos_id=tos_abc123")
	await expect(page.getByTestId("blindpay-kyc-form")).toBeVisible()
	expect(savedTos).toEqual({ tosId: "tos_abc123" })

	const submit = page.getByTestId("blindpay-kyc-submit")
	await expect(submit).toBeDisabled()
	await page
		.getByTestId("blindpay-id_doc_front_file")
		.setInputFiles({ name: "id.png", mimeType: "image/png", buffer: png })
	await expect(page.getByText(/Photo of your ID \(front\) ✓ uploaded/)).toBeVisible()
	await page
		.getByTestId("blindpay-selfie_file")
		.setInputFiles({ name: "selfie.png", mimeType: "image/png", buffer: png })
	await expect(page.getByText(/Selfie ✓ uploaded/)).toBeVisible()
	await expect(submit).toBeEnabled()
	expect(uploads).toEqual(["image/png", "image/png"])
	await expect(page.getByLabel(/ID document URL|Selfie URL/)).toHaveCount(0)
})

test("terms return without an id says to start again", async ({ page }) => {
	await page.goto("/blindpay/terms-done")
	await expect(page.getByTestId("blindpay-terms-done")).toContainText(
		"did not return a terms acceptance",
	)
})

test("390px: the identity form fits a phone", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.route(/\/v1\/blindpay\/onboarding\/tos$/, async (route) => {
		await route.fulfill({
			json: { receiverId: null, kycStatus: null, next: { step: "submit_kyc" } },
		})
	})
	await page.goto("/blindpay/terms-done?tos_id=tos_phone")
	await expect(page.getByTestId("blindpay-kyc-form")).toBeVisible()
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth,
	)
	expect(overflow).toBeLessThanOrEqual(0)
})
