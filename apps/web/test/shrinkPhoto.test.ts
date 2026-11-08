import assert from "node:assert/strict"
import { describe, test } from "vitest"
// Loaded by path: the Node tsconfig for test/ has no DOM types (canvas, createImageBitmap).
const path = "../src/payments/shrinkPhoto.ts"
const { needsShrinking, scaledSize, SHRINK_ABOVE_BYTES, shrinkPhoto } =
	(await import(/* @vite-ignore */ path)) as {
		needsShrinking: (file: { type: string; size: number }) => boolean
		scaledSize: (w: number, h: number) => { width: number; height: number }
		SHRINK_ABOVE_BYTES: number
		shrinkPhoto: (file: Blob) => Promise<Blob>
	}

describe("CCR-46 shrinkPhoto", () => {
	test("only large JPEG, PNG or WEBP photos are shrunk", () => {
		const big = SHRINK_ABOVE_BYTES + 1
		assert.equal(needsShrinking({ type: "image/jpeg", size: big }), true)
		assert.equal(needsShrinking({ type: "image/png", size: big }), true)
		assert.equal(needsShrinking({ type: "image/webp", size: big }), true)
		assert.equal(needsShrinking({ type: "image/jpeg", size: 1000 }), false)
		assert.equal(needsShrinking({ type: "application/pdf", size: big }), false)
		assert.equal(needsShrinking({ type: "image/heic", size: big }), false)
	})

	test("keeps the aspect ratio and caps the longest side", () => {
		assert.deepEqual(scaledSize(4800, 3600), { width: 2400, height: 1800 })
		assert.deepEqual(scaledSize(3000, 6000), { width: 1200, height: 2400 })
		assert.deepEqual(scaledSize(800, 600), { width: 800, height: 600 })
	})

	test("returns the file unchanged when it is small or cannot be drawn here", async () => {
		const small = new Blob([new Uint8Array(10)], { type: "image/jpeg" })
		assert.equal(await shrinkPhoto(small), small)
		const big = new Blob([new Uint8Array(SHRINK_ABOVE_BYTES + 10)], {
			type: "image/jpeg",
		})
		// Node has no canvas/createImageBitmap: the original is kept, never lost.
		assert.equal(await shrinkPhoto(big), big)
	})
})
