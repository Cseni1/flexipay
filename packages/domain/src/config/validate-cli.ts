// Validates config/*.json. Usage: npm run validate:config  (or: node <this file> <config dir>)
import { resolve } from "node:path";
import { corridorId, loadConfig } from "./load.ts";

const dir = resolve(process.argv[2] ?? "config");

try {
  const result = await loadConfig(dir);
  if (!result.ok) {
    console.error(`Config INVALID (${dir}):`);
    for (const i of result.issues) console.error(`  ${i.file} ${i.path}: ${i.message}`);
    process.exit(1);
  }
  const { corridors, providers, settlementRails, fees } = result.config;
  console.log(`Config valid (${dir}): ${corridors.length} corridors, ${providers.length} providers, ${settlementRails.length} settlement rails`);
  for (const c of corridors) {
    const crypto = `crypto individual=${c.cryptoLegAllowed.individual} company=${c.cryptoLegAllowed.company}`;
    console.log(`  ${corridorId(c)}  ${c.allowedDestinationTypes.join(",")}  ${crypto}  settle=[${c.legsAvailable.settle.join(",")}]`);
  }
  console.log(`  quote validity ${fees.quoteValiditySeconds}s, price risk on ${fees.priceRiskBearer}; vault fee comes from the contract`);
} catch (err) {
  console.error(`Config could not be read (${dir}): ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
