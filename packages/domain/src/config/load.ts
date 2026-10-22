import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { isCryptoEndpoint, RECIPIENT_KINDS, type LegKind } from "../enums.ts";
import { compareMoney } from "../money.ts";
import {
  CorridorsFileSchema,
  FeesFileSchema,
  ProvidersFileSchema,
  type Corridor,
  type FlexiPayConfig,
  type Provider,
} from "./schemas.ts";

export interface ConfigIssue {
  file: string;
  path: string;
  message: string;
}

export type ConfigResult =
  | { ok: true; config: FlexiPayConfig }
  | { ok: false; issues: ConfigIssue[] };

export interface RawConfig {
  corridors: unknown;
  providers: unknown;
  fees: unknown;
}

export const corridorId = (c: Pick<Corridor, "from" | "to">): string =>
  `${c.from.country}-${c.to.country}`;

function shapeIssues(file: string, error: z.ZodError): ConfigIssue[] {
  return error.issues.map((i) => ({ file, path: i.path.join("."), message: i.message }));
}

/** Validates the three config documents: shapes first, then the cross-file rules. */
export function validateConfig(raw: RawConfig): ConfigResult {
  const corridorsFile = CorridorsFileSchema.safeParse(raw.corridors);
  const providersFile = ProvidersFileSchema.safeParse(raw.providers);
  const feesFile = FeesFileSchema.safeParse(raw.fees);
  const issues: ConfigIssue[] = [
    ...(corridorsFile.success ? [] : shapeIssues("corridors.json", corridorsFile.error)),
    ...(providersFile.success ? [] : shapeIssues("providers.json", providersFile.error)),
    ...(feesFile.success ? [] : shapeIssues("fees.json", feesFile.error)),
  ];
  if (!corridorsFile.success || !providersFile.success || !feesFile.success) {
    return { ok: false, issues };
  }

  const config: FlexiPayConfig = {
    corridors: corridorsFile.data.corridors,
    providers: providersFile.data.providers,
    settlementRails: providersFile.data.settlementRails,
    fees: feesFile.data,
  };
  issues.push(...crossRules(config));
  return issues.length > 0 ? { ok: false, issues } : { ok: true, config };
}

function crossRules(config: FlexiPayConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const add = (file: string, path: string, message: string) => issues.push({ file, path, message });

  const providers = new Map<string, Provider>();
  config.providers.forEach((p, i) => {
    if (providers.has(p.id)) add("providers.json", `providers.${i}.id`, `duplicate id ${p.id}`);
    providers.set(p.id, p);
    if (p.limits) {
      if (p.limits.min.currency !== p.limits.max.currency) {
        add("providers.json", `providers.${i}.limits`, "min and max use different currencies");
      } else if (compareMoney(p.limits.min, p.limits.max) > 0) {
        add("providers.json", `providers.${i}.limits`, "min is greater than max");
      }
      if (!p.currencies.includes(p.limits.min.currency)) {
        add("providers.json", `providers.${i}.limits`, `limit currency ${p.limits.min.currency} is not one of the provider's currencies`);
      }
    }
    if (!p.currencies.includes(p.fee.fixed.currency)) {
      add("providers.json", `providers.${i}.fee.fixed`, `fee currency ${p.fee.fixed.currency} is not one of the provider's currencies`);
    }
    if (p.legKinds.includes("settle")) {
      add("providers.json", `providers.${i}.legKinds`, "settle belongs to a settlement rail, not a provider");
    }
  });

  const rails = new Set<string>();
  config.settlementRails.forEach((r, i) => {
    if (rails.has(r.id) || providers.has(r.id)) {
      add("providers.json", `settlementRails.${i}.id`, `duplicate id ${r.id}`);
    }
    rails.add(r.id);
  });

  const seen = new Set<string>();
  config.corridors.forEach((c, i) => {
    const at = (field: string) => `corridors.${i}.${field}`;
    const name = corridorId(c);
    const flag = (field: string, message: string) => add("corridors.json", at(field), `${name}: ${message}`);

    if (seen.has(name)) flag("from", "duplicate corridor");
    seen.add(name);

    // every id exists and serves that leg kind
    for (const kind of ["collect", "convert", "payout"] as LegKind[]) {
      for (const id of c.legsAvailable[kind]) {
        const p = providers.get(id);
        if (!p) flag(`legsAvailable.${kind}`, `unknown provider ${id}`);
        else if (!p.legKinds.includes(kind)) flag(`legsAvailable.${kind}`, `${id} does not serve ${kind}`);
      }
    }
    for (const id of c.legsAvailable.settle) {
      if (!rails.has(id)) flag("legsAvailable.settle", `unknown settlement rail ${id}`);
    }
    if (c.legsAvailable.collect.length === 0) flag("legsAvailable.collect", "needs a collect provider");

    // domestic rail exactly when the countries match
    const domestic = c.from.country === c.to.country;
    if (domestic && !c.domesticRail) flag("domesticRail", "domestic corridor needs a domesticRail");
    if (!domestic && c.domesticRail) flag("domesticRail", "domesticRail is only for same-country corridors");
    if (c.domesticRail) {
      if (!c.legsAvailable.collect.includes(c.domesticRail) || !c.legsAvailable.payout.includes(c.domesticRail)) {
        flag("domesticRail", "domesticRail must be both a collect and a payout provider");
      }
    }
    if (c.from.currency === c.to.currency && c.legsAvailable.convert.length > 0) {
      flag("legsAvailable.convert", "same currency needs no conversion");
    }

    // crypto eligibility (ARCHITECTURE §6.8, CCR-3)
    const anyCrypto = RECIPIENT_KINDS.some((k) => c.cryptoLegAllowed[k]);
    const cryptoDestinations = c.allowedDestinationTypes.filter(isCryptoEndpoint);
    if (!anyCrypto && c.legsAvailable.settle.length > 0) {
      flag("legsAvailable.settle", "crypto leg not allowed for any recipient kind, so no settle rail");
    }
    if (!anyCrypto && cryptoDestinations.length > 0) {
      flag("allowedDestinationTypes", `crypto destinations (${cryptoDestinations.join(", ")}) need a crypto leg`);
    }
    if (cryptoDestinations.length > 0 && c.legsAvailable.settle.length === 0) {
      flag("legsAvailable.settle", "crypto destinations need a settle rail");
    }
    if (anyCrypto && c.legsAvailable.settle.length > 0 && c.from.currency !== c.to.currency && c.legsAvailable.convert.length === 0) {
      flag("legsAvailable.convert", "a stablecoin route needs a convert provider");
    }

    // fiat destinations need a payout provider for that endpoint type in the destination country
    for (const type of c.allowedDestinationTypes.filter((t) => !isCryptoEndpoint(t))) {
      const served = c.legsAvailable.payout.some((id) => {
        const p = providers.get(id);
        return p?.endpointTypes.includes(type) && p.countries.includes(c.to.country);
      });
      if (!served) flag("legsAvailable.payout", `no payout provider for ${type} in ${c.to.country}`);
    }

    // send-side limits in the from currency, min <= max, only for allowed recipient kinds
    for (const kind of c.recipientKinds) {
      const { min, max } = c.limits[kind];
      if (min.currency !== c.from.currency || max.currency !== c.from.currency) {
        flag(`limits.${kind}`, `limits are send-side, in ${c.from.currency}`);
      } else if (compareMoney(min, max) > 0) {
        flag(`limits.${kind}`, "min is greater than max");
      }
    }
  });

  return issues;
}

/** Reads and validates corridors.json, providers.json and fees.json from a directory. */
export async function loadConfig(dir: string): Promise<ConfigResult> {
  const read = async (file: string) => JSON.parse(await readFile(join(dir, file), "utf8")) as unknown;
  return validateConfig({
    corridors: await read("corridors.json"),
    providers: await read("providers.json"),
    fees: await read("fees.json"),
  });
}
