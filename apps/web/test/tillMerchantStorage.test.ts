import assert from "node:assert/strict"
import { describe, test } from "vitest"
import {
	clearTillMerchant,
	loadTillMerchant,
	saveTillMerchant,
	TILL_MERCHANT_STORAGE_KEY,
	type TillMerchantMemory,
} from "../src/payments/tillMerchantStorage.ts"

function memoryMap(initial: Record<string, string> = {}) {
	const data = new Map(Object.entries(initial))
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value)
		},
		removeItem: (key: string) => {
			data.delete(key)
		},
		data,
	}
}

describe("tillMerchantStorage", () => {
	test("saves and loads wallet + label, never amount", () => {
		const storage = memoryMap()
		const memory: TillMerchantMemory = {
			wallet: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
			label: "Table 4",
		}
		saveTillMerchant(memory, storage)
		const raw = storage.data.get(TILL_MERCHANT_STORAGE_KEY)
		assert.ok(raw)
		assert.equal(raw.includes("amount"), false)
		assert.deepEqual(JSON.parse(raw), memory)
		assert.deepEqual(loadTillMerchant(storage), memory)
	})

	test("returns null for missing, invalid, or null storage", () => {
		assert.equal(loadTillMerchant(null), null)
		assert.equal(loadTillMerchant(memoryMap()), null)
		assert.equal(
			loadTillMerchant(memoryMap({ [TILL_MERCHANT_STORAGE_KEY]: "not-json" })),
			null,
		)
		assert.equal(
			loadTillMerchant(
				memoryMap({
					[TILL_MERCHANT_STORAGE_KEY]: JSON.stringify({
						wallet: 1,
						label: "x",
					}),
				}),
			),
			null,
		)
	})

	test("clear removes the saved merchant", () => {
		const storage = memoryMap()
		saveTillMerchant({ wallet: "abc", label: "" }, storage)
		clearTillMerchant(storage)
		assert.equal(loadTillMerchant(storage), null)
	})

	test("load/save/clear tolerate storage throwing", () => {
		const throwingGet = {
			getItem: () => {
				throw new Error("blocked")
			},
		}
		const throwingSet = {
			setItem: () => {
				throw new Error("quota")
			},
		}
		const throwingRemove = {
			removeItem: () => {
				throw new Error("blocked")
			},
		}
		assert.equal(loadTillMerchant(throwingGet), null)
		assert.doesNotThrow(() =>
			saveTillMerchant({ wallet: "w", label: "l" }, throwingSet),
		)
		assert.doesNotThrow(() => clearTillMerchant(throwingRemove))
	})
})
