import assert from "node:assert/strict"
import { describe, test } from "vitest"
import {
	clearSolanaTransfer,
	loadSolanaTransfer,
	saveSolanaTransfer,
	solanaTransferStorageKey,
	type SolanaTransferMemory,
} from "../src/payments/solanaTransferStorage.ts"

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

describe("solanaTransferStorage", () => {
	test("saves and loads signature + sentAt per payment", () => {
		const storage = memoryMap()
		const memory: SolanaTransferMemory = {
			signature:
				"5SigExampleaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			sentAt: "2026-11-05T13:50:52.000Z",
		}
		saveSolanaTransfer("pay_1", memory, storage)
		const raw = storage.data.get(solanaTransferStorageKey("pay_1"))
		assert.ok(raw)
		assert.deepEqual(JSON.parse(raw), memory)
		assert.deepEqual(loadSolanaTransfer("pay_1", storage), memory)
		assert.equal(loadSolanaTransfer("pay_other", storage), null)
	})

	test("returns null for missing, invalid, or null storage", () => {
		assert.equal(loadSolanaTransfer("pay_1", null), null)
		assert.equal(loadSolanaTransfer("pay_1", memoryMap()), null)
		assert.equal(
			loadSolanaTransfer(
				"pay_1",
				memoryMap({ [solanaTransferStorageKey("pay_1")]: "not-json" }),
			),
			null,
		)
		assert.equal(
			loadSolanaTransfer(
				"pay_1",
				memoryMap({
					[solanaTransferStorageKey("pay_1")]: JSON.stringify({
						signature: 1,
						sentAt: "x",
					}),
				}),
			),
			null,
		)
	})

	test("clear removes the stored transfer", () => {
		const storage = memoryMap()
		saveSolanaTransfer(
			"pay_1",
			{ signature: "sig", sentAt: "2026-11-05T12:00:00.000Z" },
			storage,
		)
		clearSolanaTransfer("pay_1", storage)
		assert.equal(loadSolanaTransfer("pay_1", storage), null)
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
		assert.equal(loadSolanaTransfer("pay_1", throwingGet), null)
		assert.doesNotThrow(() =>
			saveSolanaTransfer(
				"pay_1",
				{ signature: "s", sentAt: "2026-11-05T12:00:00.000Z" },
				throwingSet,
			),
		)
		assert.doesNotThrow(() => clearSolanaTransfer("pay_1", throwingRemove))
	})
})
