import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@flexipay/domain";
import { createApp } from "../src/app.ts";
import { createDb, type Db } from "../src/db.ts";
import {
	migrateDeploy,
	startEmbeddedDb,
	type EmbeddedDb,
} from "../src/dev/embedded-db.ts";
import { newApiKey, newId } from "../src/ids.ts";
import { createApiRuntime, type ApiRuntime } from "../src/runtime.ts";

export interface TestServer {
	base: string;
	db: Db;
	pg: EmbeddedDb;
	runtime: ApiRuntime;
	newOrg(name?: string): Promise<{ orgId: string; key: string }>;
	stop(): Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
	process.env.FP_SETTLEMENT = process.env.FP_SETTLEMENT ?? "mock";
	process.env.FP_CLAIM_SEAL_KEY =
		process.env.FP_CLAIM_SEAL_KEY ?? "a".repeat(64);
	process.env.FP_API_URL = process.env.FP_API_URL ?? "http://127.0.0.1";

	const pg = await startEmbeddedDb();
	await migrateDeploy(pg.url);
	const db = createDb(pg.url);
	const configDir = resolve(
		fileURLToPath(new URL("../../../config", import.meta.url)),
	);
	const loaded = await loadConfig(configDir);
	if (!loaded.ok) {
		throw new Error(`config invalid: ${JSON.stringify(loaded.issues)}`);
	}
	const runtime = await createApiRuntime(loaded.config, process.env);
	const server = createApp({
		db,
		config: loaded.config,
		runtime,
	}).listen(0, "127.0.0.1");
	await new Promise((r) => server.once("listening", r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		base,
		db,
		pg,
		runtime,
		async newOrg(name = "Demo Platform") {
			const org = await db.organization.create({
				data: { id: newId("org"), name, kind: "business" },
			});
			const k = newApiKey();
			await db.apiKey.create({
				data: {
					id: newId("key"),
					organizationId: org.id,
					prefix: k.prefix,
					keyHash: k.keyHash,
				},
			});
			return { orgId: org.id, key: k.key };
		},
		async stop() {
			await new Promise((r) => server.close(r));
			await db.$disconnect();
			await pg.stop();
		},
	};
}

export const auth = (key: string, extra: Record<string, string> = {}) => ({
	authorization: `Bearer ${key}`,
	"content-type": "application/json",
	...extra,
});
