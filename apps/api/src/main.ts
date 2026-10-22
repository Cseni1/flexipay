import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@flexipay/domain";
import { createApp } from "./app.ts";
import { createDb } from "./db.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const configDir = process.env.FP_CONFIG_DIR ?? resolve(fileURLToPath(new URL("../../../config", import.meta.url)));
const loaded = await loadConfig(configDir);
if (!loaded.ok) {
  for (const i of loaded.issues) console.error(`config ${i.file} ${i.path}: ${i.message}`);
  throw new Error("Config is invalid; refusing to start");
}

const app = createApp({ db: createDb(databaseUrl), config: loaded.config });
const port = Number(process.env.PORT ?? 8788);
app.listen(port, () => console.log(`FlexiPay API listening on :${port}`));
