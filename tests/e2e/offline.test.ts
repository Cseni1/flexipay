import { describe, expect, it } from "vitest"
import {
	buildOfflinePlan,
	readOfflineConfig,
} from "../../scripts/demo/offline.ts"

// Plan-only tests. They never spawn a server and never read FP_API_KEY from the real environment:
// each case passes its own source object.

describe("offline launcher plan", () => {
	it("uses the existing API and web dev commands on loopback with mock settlement", () => {
		const config = readOfflineConfig({}, [])
		expect(config).toMatchObject({ apiPort: 8788, webPort: 5173, seed: true })
		const plan = buildOfflinePlan(config, {})
		expect(plan.settlement).toBe("mock")
		expect(plan.providers).toBe("simulated")
		expect(plan.api).toMatchObject({
			url: "http://127.0.0.1:8788",
			command: "npm",
			args: ["run", "dev", "--workspace", "@flexipay/api"],
			env: { PORT: "8788", FP_SETTLEMENT: "mock" },
		})
		expect(plan.web.url).toBe("http://127.0.0.1:5173")
		expect(plan.web.args).toEqual(
			expect.arrayContaining([
				"@flexipay/web",
				"--",
				"--host",
				"127.0.0.1",
				"--port",
				"5173",
			]),
		)
	})

	it("keeps the API key out of the plan while enabling the seed step", () => {
		const plan = buildOfflinePlan(readOfflineConfig({}, []), {
			FP_API_KEY: "secret-value",
		})
		expect(plan.seed.enabled).toBe(true)
		if (!plan.seed.enabled) throw new Error("seed should be enabled")
		expect(plan.seed.apiUrl).toBe("http://127.0.0.1:8788")
		expect(JSON.stringify(plan)).not.toContain("secret-value")
		expect(JSON.stringify(plan)).not.toContain("FP_API_KEY")
	})

	it("reports why seeding is skipped when there is no key or --no-seed is given", () => {
		const noKey = buildOfflinePlan(readOfflineConfig({}, []), {})
		expect(noKey.seed).toMatchObject({ enabled: false })
		if (noKey.seed.enabled) throw new Error("seed should be disabled")
		expect(noKey.seed.reason).toMatch(/FP_API_KEY/)

		const noSeed = buildOfflinePlan(readOfflineConfig({}, ["--no-seed"]), {
			FP_API_KEY: "secret-value",
		})
		expect(noSeed.seed).toMatchObject({ enabled: false })
		if (noSeed.seed.enabled) throw new Error("seed should be disabled")
		expect(noSeed.seed.reason).toMatch(/--no-seed/)
	})

	it("accepts explicit ports and rejects invalid or colliding ones", () => {
		const config = readOfflineConfig(
			{ FP_API_PORT: "9100", FP_WEB_PORT: "9101" },
			[],
		)
		expect(buildOfflinePlan(config, {}).api.url).toBe("http://127.0.0.1:9100")
		expect(() => readOfflineConfig({ FP_API_PORT: "0" }, [])).toThrow(
			/FP_API_PORT/,
		)
		expect(() => readOfflineConfig({ FP_WEB_PORT: "70000" }, [])).toThrow(
			/FP_WEB_PORT/,
		)
		expect(() =>
			readOfflineConfig({ FP_API_PORT: "9200", FP_WEB_PORT: "9200" }, []),
		).toThrow(/must differ/)
	})
})
