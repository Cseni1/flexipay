import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@flexipay/domain";
import { createApp } from "./app.ts";
import { createAuthRuntime } from "./auth/auth.ts";
import { loadAuthConfig } from "./auth/config.ts";
import { createDb } from "./db.ts";
import { sandboxEnabledFromEnv } from "./sandbox-gate.ts";
import { createApiRuntime } from "./runtime.ts";
import { startProviderPoller } from "./ops/provider-poller.ts";
import { assertLiveMoneyStartup } from "./live/startup.ts";
import { initMonitoring } from "./monitoring.ts";

assertLiveMoneyStartup(process.env);

if (await initMonitoring()) console.log("error monitoring: Sentry on");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const configDir =
	process.env.FP_CONFIG_DIR ??
	resolve(fileURLToPath(new URL("../../../config", import.meta.url)));
const loaded = await loadConfig(configDir);
if (!loaded.ok) {
	for (const i of loaded.issues) {
		console.error(`config ${i.file} ${i.path}: ${i.message}`);
	}
	throw new Error("Config is invalid; refusing to start");
}

const runtime = await createApiRuntime(loaded.config);
const db = createDb(databaseUrl);

// TASK 06: customer auth fails closed. Missing/invalid auth configuration disables sign-in
// (503 on /api/auth, cookies never accepted); server API keys keep working.
const authConfig = loadAuthConfig(process.env, () => randomBytes(32).toString("hex"));
if (!authConfig.ok) console.error(`customer auth DISABLED: ${authConfig.reason}`);
const trustProxy = Number(process.env.TRUST_PROXY_HOPS ?? 0) || undefined;

const sandboxEnabled = sandboxEnabledFromEnv(process.env);
if (process.env.FP_SANDBOX === "1" && !sandboxEnabled) {
	console.error("FP_SANDBOX=1 ignored: sandbox controls are never enabled when NODE_ENV=production");
}
console.log(`sandbox controls: ${sandboxEnabled ? "ENABLED (local dev only)" : "disabled"}`);

const app = createApp({
	db,
	config: loaded.config,
	runtime,
	auth: authConfig.ok ? createAuthRuntime(db, authConfig.config) : undefined,
	trustProxy,
	sandboxEnabled,
});
const port = Number(process.env.PORT ?? 8788);
app.listen(port, () => console.log(`FlexiPay API listening on :${port}`));

// CCR-29: partner legs finish later; resume those payments in the background.
if (runtime.liveProviderIds && runtime.liveProviderIds.length > 0) {
	console.log(`partner providers: ${runtime.liveProviderIds.join(", ")} (sandbox unless approved)`);
	startProviderPoller(db, {
		getProvider: runtime.getProvider,
		settlement: runtime.settlement,
		vaultPayer: runtime.vaultPayer,
		now: runtime.now,
		claimSealKey: runtime.claimSealKey,
		defaultClaimDestination: process.env.FP_RECIPIENT_A_ADDRESS ?? runtime.vaultPayer,
		partnerProviderIds: new Set(runtime.liveProviderIds),
	});
}
