#!/usr/bin/env node
/**
 * SF0-prep draft table checker. Dependency-free: no imports beyond node: builtins,
 * no writes, no network.
 *
 * Reads the three drafts next to this file and checks the table format, the
 * provider references, the money representation, the simulation flags, the
 * South Africa crypto exclusion and the fee separation.
 *
 * `TBD` marks an unresolved cell. Unresolved cells are listed in the output and are
 * never treated as decided values; the script does not require them to stay TBD.
 *
 * PASS means these draft checks passed. It is not policy approval, not approval of any
 * unresolved cell, and not CC0 loader validation: the loader and schemas do not exist yet.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TBD = 'TBD';

const FILES = { corridors: 'corridors.md', providers: 'providers.md', fees: 'fees.md' };

const text = {};
for (const [key, name] of Object.entries(FILES)) {
  try {
    text[key] = readFileSync(join(HERE, name), 'utf8');
  } catch (err) {
    console.error(`FAIL: cannot read ${name} next to check.mjs (${err.code || err.message})`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ constants */

const CORRIDOR_COLUMNS = [
  'from',
  'to',
  'allowedDestinationTypes',
  'recipientKinds',
  'cryptoLegAllowed.individual',
  'cryptoLegAllowed.company',
  'limits.individual.min (placeholder)',
  'limits.individual.max (placeholder)',
  'limits.company.min (placeholder)',
  'limits.company.max (placeholder)',
  'legsAvailable',
  'domesticRail',
  'regulationNote',
  'simulated',
];

const PROVIDER_COLUMNS = [
  'id',
  'kind',
  'countries',
  'currenciesOrAsset',
  'endpointTypes',
  'legKinds',
  'feeFixed (placeholder)',
  'feeBps (placeholder)',
  'fxSpreadBps (placeholder)',
  'estimatedTimeSeconds (placeholder)',
  'min (placeholder)',
  'max (placeholder)',
  'simulated',
];

const SETTLEMENT_COLUMNS = ['id', 'kind', 'network', 'asset', 'legKinds', 'simulated', 'metadataStatus'];

const LIMIT_COLUMNS = [
  'limits.individual.min (placeholder)',
  'limits.individual.max (placeholder)',
  'limits.company.min (placeholder)',
  'limits.company.max (placeholder)',
];

const PROVIDER_NUMERIC_COLUMNS = [
  'feeFixed (placeholder)',
  'feeBps (placeholder)',
  'fxSpreadBps (placeholder)',
  'estimatedTimeSeconds (placeholder)',
  'min (placeholder)',
  'max (placeholder)',
];

const ENDPOINT_TYPES = ['bank_account', 'ewallet', 'crypto_wallet', 'crypto_custodial'];
const LEG_KINDS = ['collect', 'convert', 'settle', 'payout'];
const PROVIDER_KINDS = ['bank', 'ewallet', 'fx'];
const CORRIDORS = [
  ['US USD', 'US USD'],
  ['US USD', 'PH PHP'],
  ['US USD', 'BR BRL'],
  ['US USD', 'ZA ZAR'],
];
const PROVIDERS = [
  'sim_bank_us_ach',
  'sim_bank_ph_instapay',
  'sim_ewallet_ph',
  'sim_bank_br_pix',
  'sim_bank_za_eft',
  'sim_fx',
];
const RAIL_ID = 'stellar_usdc';
const MONEY = /^"(\d+)" ([A-Z]{3})$/;
const INTEGER = /^\d+$/;

/* ------------------------------------------------------------------- parsing */

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isSeparator(line) {
  const t = line.trim();
  return /^\|[\s:|-]+\|$/.test(t) && t.includes('-');
}

function parseTables(source) {
  const lines = source.split(/\r?\n/);
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim().startsWith('|') && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const header = splitRow(lines[i]);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().startsWith('|')) {
        rows.push(splitRow(lines[j]));
        j += 1;
      }
      tables.push({ header, rows, line: i + 1 });
      i = j;
    } else {
      i += 1;
    }
  }
  return tables;
}

const parsed = {
  corridors: parseTables(text.corridors),
  providers: parseTables(text.providers),
  fees: parseTables(text.fees),
};

function findTable(sourceKey, signature, label) {
  const hits = parsed[sourceKey].filter((t) => signature.every((column) => t.header.includes(column)));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) throw new Error(`${label}: no table with the columns ${signature.join(', ')}`);
  throw new Error(`${label}: ${hits.length} tables match; the format allows one`);
}

const loaded = {};
for (const [key, sourceKey, signature, label] of [
  ['corridors', 'corridors', CORRIDOR_COLUMNS, 'corridors.md'],
  ['providers', 'providers', PROVIDER_COLUMNS, 'providers.md'],
  ['settlement', 'providers', SETTLEMENT_COLUMNS, 'providers.md settlement rail'],
]) {
  try {
    loaded[key] = findTable(sourceKey, signature, label);
  } catch (err) {
    loaded[key] = null;
  }
}

function table(key) {
  const tbl = loaded[key];
  if (!tbl) throw new Error(`${key} table not found or ambiguous`);
  return tbl;
}

function rows(sourceKey, tbl) {
  return tbl.rows.map((row, index) => ({ row, tbl, where: `${sourceKey}.md:${tbl.line + 2 + index}` }));
}

function cell(r, column) {
  const index = r.tbl.header.indexOf(column);
  if (index < 0) throw new Error(`${r.where}: missing column ${column}`);
  const value = r.row[index];
  if (value === undefined || value === '') throw new Error(`${r.where}: empty value in ${column}`);
  return value;
}

function isTbd(value) {
  return value.trim() === TBD;
}

function money(value, label) {
  const match = MONEY.exec(value);
  if (!match) {
    throw new Error(`${label}: ${JSON.stringify(value)} is not a quoted integer minor-unit amount with an explicit currency (like "100" USD)`);
  }
  return { minor: BigInt(match[1]), currency: match[2] };
}

function integer(value, label) {
  if (!INTEGER.test(value)) throw new Error(`${label}: ${JSON.stringify(value)} is not an integer`);
  return BigInt(value);
}

function boolean(value, label) {
  if (value !== 'true' && value !== 'false') throw new Error(`${label}: ${JSON.stringify(value)} must be true or false`);
  return value === 'true';
}

function csv(value) {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** "collect: a, b; convert: none; settle: TBD; payout: c" -> Map<kind, {tbd, ids}> */
function parseLegs(value, where) {
  const legs = new Map();
  for (const part of value.split(';')) {
    const entry = part.trim();
    if (!entry) throw new Error(`${where}: empty leg entry`);
    const match = /^([a-z_]+): (.+)$/.exec(entry);
    if (!match) throw new Error(`${where}: leg entry ${JSON.stringify(entry)} must look like "collect: id, id"`);
    const kind = match[1];
    if (!LEG_KINDS.includes(kind)) throw new Error(`${where}: unknown leg kind ${kind}`);
    if (legs.has(kind)) throw new Error(`${where}: leg kind ${kind} listed twice`);
    const raw = match[2].trim();
    if (raw === TBD) legs.set(kind, { tbd: true, ids: [] });
    else if (raw === 'none') legs.set(kind, { tbd: false, ids: [] });
    else if (raw.includes('none')) throw new Error(`${where}: leg ${kind} mixes "none" with provider ids`);
    else legs.set(kind, { tbd: false, ids: csv(raw) });
  }
  for (const kind of LEG_KINDS) {
    if (!legs.has(kind)) throw new Error(`${where}: leg kind ${kind} is not listed (use none or TBD)`);
  }
  return legs;
}

/* -------------------------------------------------------------------- checks */

const results = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
  }
}

const corridorRows = () => rows('corridors', table('corridors'));
const providerRows = () => rows('providers', table('providers'));

function documentedIds() {
  const map = new Map();
  for (const r of providerRows()) map.set(cell(r, 'id'), csv(cell(r, 'legKinds')));
  const rail = table('settlement');
  for (const r of rows('providers', rail)) map.set(cell(r, 'id'), csv(cell(r, 'legKinds')));
  return map;
}

check('corridors.md: table has the §6.8 columns', () => {
  table('corridors');
});

check('corridors.md: exactly the four baseline corridors', () => {
  const seen = corridorRows().map((r) => `${cell(r, 'from')} -> ${cell(r, 'to')}`);
  if (seen.length !== CORRIDORS.length) throw new Error(`expected ${CORRIDORS.length} rows, found ${seen.length}`);
  if (new Set(seen).size !== seen.length) throw new Error('duplicate corridor rows');
  for (const [from, to] of CORRIDORS) {
    if (!seen.includes(`${from} -> ${to}`)) throw new Error(`missing corridor ${from} -> ${to}`);
  }
});

check('corridors.md: every corridor is simulated: true', () => {
  for (const r of corridorRows()) {
    if (!boolean(cell(r, 'simulated'), `${r.where} simulated`)) throw new Error(`${r.where}: simulated must be true`);
  }
});

check('corridors.md: destination endpoint types are §6.3 values, never crypto', () => {
  for (const r of corridorRows()) {
    const types = csv(cell(r, 'allowedDestinationTypes'));
    if (types.length === 0) throw new Error(`${r.where}: no destination endpoint type`);
    for (const type of types) {
      if (!ENDPOINT_TYPES.includes(type)) throw new Error(`${r.where}: ${type} is not a §6.3 endpoint type`);
      if (type.startsWith('crypto_')) throw new Error(`${r.where}: no baseline corridor may allow a crypto destination`);
    }
  }
});

check('corridors.md: recipient kinds are individual and company', () => {
  for (const r of corridorRows()) {
    const kinds = csv(cell(r, 'recipientKinds'));
    for (const kind of kinds) {
      if (kind !== 'individual' && kind !== 'company') throw new Error(`${r.where}: unknown recipient kind ${kind}`);
    }
    if (!kinds.includes('individual') || !kinds.includes('company')) {
      throw new Error(`${r.where}: recipientKinds must list individual and company`);
    }
  }
});

check('corridors.md: cryptoLegAllowed is a boolean or TBD for each kind', () => {
  for (const r of corridorRows()) {
    for (const kind of ['individual', 'company']) {
      const value = cell(r, `cryptoLegAllowed.${kind}`);
      if (!isTbd(value)) boolean(value, `${r.where} cryptoLegAllowed.${kind}`);
    }
  }
});

check('corridors.md: ZA excludes crypto for both recipient kinds', () => {
  const za = corridorRows().find((r) => cell(r, 'to') === 'ZA ZAR');
  if (!za) throw new Error('US to ZA row not found');
  for (const kind of ['individual', 'company']) {
    if (boolean(cell(za, `cryptoLegAllowed.${kind}`), `${za.where} cryptoLegAllowed.${kind}`)) {
      throw new Error(`${za.where}: cryptoLegAllowed.${kind} must be false`);
    }
  }
});

check('corridors.md: ZA has no settle leg and no settlement rail', () => {
  const za = corridorRows().find((r) => cell(r, 'to') === 'ZA ZAR');
  if (!za) throw new Error('US to ZA row not found');
  if (cell(za, 'legsAvailable').includes(RAIL_ID)) throw new Error(`${za.where}: must not reference ${RAIL_ID}`);
  const settle = parseLegs(cell(za, 'legsAvailable'), za.where).get('settle');
  if (settle.tbd || settle.ids.length !== 0) throw new Error(`${za.where}: settle must be none (no crypto leg)`);
});

check('corridors.md: US domestic is bank-only on sim_bank_us_ach', () => {
  const us = corridorRows().find((r) => cell(r, 'from') === 'US USD' && cell(r, 'to') === 'US USD');
  if (!us) throw new Error('US to US row not found');
  const types = csv(cell(us, 'allowedDestinationTypes'));
  if (types.length !== 1 || types[0] !== 'bank_account') throw new Error(`${us.where}: must allow bank_account only`);
  for (const kind of ['individual', 'company']) {
    if (boolean(cell(us, `cryptoLegAllowed.${kind}`), us.where)) throw new Error(`${us.where}: crypto must be false for ${kind}`);
  }
  if (cell(us, 'legsAvailable').includes(RAIL_ID)) throw new Error(`${us.where}: must not reference ${RAIL_ID}`);
  const settle = parseLegs(cell(us, 'legsAvailable'), us.where).get('settle');
  if (settle.tbd || settle.ids.length !== 0) throw new Error(`${us.where}: settle must be none`);
  if (cell(us, 'domesticRail') !== 'sim_bank_us_ach') throw new Error(`${us.where}: domesticRail must be sim_bank_us_ach`);
});

check('corridors.md: legsAvailable lists all four leg kinds', () => {
  for (const r of corridorRows()) {
    parseLegs(cell(r, 'legsAvailable'), r.where);
  }
});

check('providers.md: every resolved corridor provider id is documented', () => {
  const documented = documentedIds();
  for (const r of corridorRows()) {
    for (const [kind, entry] of parseLegs(cell(r, 'legsAvailable'), r.where)) {
      for (const id of entry.ids) {
        if (!documented.has(id)) throw new Error(`${r.where}: leg ${kind} uses undocumented id ${id}`);
      }
    }
  }
});

check('corridors.md: each resolved id supports the leg kind it is used for', () => {
  const documented = documentedIds();
  for (const r of corridorRows()) {
    for (const [kind, entry] of parseLegs(cell(r, 'legsAvailable'), r.where)) {
      for (const id of entry.ids) {
        const legKinds = documented.get(id);
        if (!legKinds) throw new Error(`${r.where}: undocumented id ${id}`);
        if (!legKinds.includes(kind)) throw new Error(`${r.where}: ${id} does not list ${kind} in its legKinds`);
      }
    }
  }
});

check('corridors.md: domesticRail is a documented id, or none for cross-border', () => {
  const documented = documentedIds();
  for (const r of corridorRows()) {
    const rail = cell(r, 'domesticRail');
    const sameCountry = cell(r, 'from').split(' ')[0] === cell(r, 'to').split(' ')[0];
    if (rail === 'none') {
      if (sameCountry) throw new Error(`${r.where}: domesticRail is none but from and to are the same country`);
      continue;
    }
    if (!sameCountry) throw new Error(`${r.where}: domesticRail set on a cross-border corridor`);
    if (!documented.has(rail)) throw new Error(`${r.where}: domesticRail ${rail} is not documented in providers.md`);
  }
});

check('corridors.md: limits are money or TBD, and resolved min is less than max', () => {
  for (const r of corridorRows()) {
    for (const kind of ['individual', 'company']) {
      const minRaw = cell(r, `limits.${kind}.min (placeholder)`);
      const maxRaw = cell(r, `limits.${kind}.max (placeholder)`);
      if (isTbd(minRaw) !== isTbd(maxRaw)) throw new Error(`${r.where}: limits.${kind} has one bound unresolved and one written`);
      if (isTbd(minRaw)) continue;
      const min = money(minRaw, `${r.where} limits.${kind}.min`);
      const max = money(maxRaw, `${r.where} limits.${kind}.max`);
      if (min.currency !== max.currency) throw new Error(`${r.where}: limits.${kind} currencies differ`);
      if (!(min.minor < max.minor)) throw new Error(`${r.where}: limits.${kind} min ${min.minor} is not less than max ${max.minor}`);
    }
  }
});

check('providers.md: exactly the six simulated providers', () => {
  const ids = providerRows().map((r) => cell(r, 'id'));
  if (ids.length !== PROVIDERS.length) throw new Error(`expected ${PROVIDERS.length} rows, found ${ids.length}`);
  for (const id of PROVIDERS) if (!ids.includes(id)) throw new Error(`missing provider ${id}`);
  for (const id of ids) if (!PROVIDERS.includes(id)) throw new Error(`unexpected provider ${id}`);
});

check('providers.md: every provider row is simulated: true', () => {
  for (const r of providerRows()) {
    if (!boolean(cell(r, 'simulated'), `${r.where} simulated`)) throw new Error(`${r.where}: simulated must be true`);
  }
});

check('providers.md: kinds, endpoint types and leg kinds are source-defined', () => {
  for (const r of providerRows()) {
    const kind = cell(r, 'kind');
    if (!PROVIDER_KINDS.includes(kind)) throw new Error(`${r.where}: kind ${kind} is not a §11.1 provider kind`);
    for (const type of csv(cell(r, 'endpointTypes'))) {
      if (type !== 'none' && !ENDPOINT_TYPES.includes(type)) throw new Error(`${r.where}: ${type} is not a §6.3 endpoint type`);
    }
    for (const legKind of csv(cell(r, 'legKinds'))) {
      if (!LEG_KINDS.includes(legKind)) throw new Error(`${r.where}: ${legKind} is not a §6.6 leg kind`);
    }
  }
});

check('providers.md: numeric columns are labelled placeholders and hold integers', () => {
  for (const column of PROVIDER_NUMERIC_COLUMNS) {
    if (!table('providers').header.includes(column)) throw new Error(`providers.md: column ${column} is missing or not labelled`);
  }
  for (const r of providerRows()) {
    for (const column of ['feeBps (placeholder)', 'fxSpreadBps (placeholder)']) {
      const bps = integer(cell(r, column), `${r.where} ${column}`);
      if (bps > 10000n) throw new Error(`${r.where}: ${column} exceeds 10000 bps`);
    }
    const seconds = integer(cell(r, 'estimatedTimeSeconds (placeholder)'), `${r.where} estimatedTimeSeconds`);
    if (seconds <= 0n) throw new Error(`${r.where}: estimatedTimeSeconds must be positive`);
  }
});

check('providers.md: min and max are money or TBD, one currency, min less than max', () => {
  for (const r of providerRows()) {
    const minRaw = cell(r, 'min (placeholder)');
    const maxRaw = cell(r, 'max (placeholder)');
    if (isTbd(minRaw) !== isTbd(maxRaw)) throw new Error(`${r.where}: one of min/max is unresolved and one written`);
    if (isTbd(minRaw)) continue;
    const min = money(minRaw, `${r.where} min`);
    const max = money(maxRaw, `${r.where} max`);
    if (min.currency !== max.currency) throw new Error(`${r.where}: min and max currencies differ`);
    if (!(min.minor < max.minor)) throw new Error(`${r.where}: min ${min.minor} is not less than max ${max.minor}`);
  }
});

check('providers.md: the settlement rail is separate and not simulated', () => {
  const rail = table('settlement');
  if (rail.rows.length !== 1) throw new Error(`expected one settlement rail row, found ${rail.rows.length}`);
  const r = rows('providers', rail)[0];
  if (cell(r, 'id') !== RAIL_ID) throw new Error(`${r.where}: id must be ${RAIL_ID}`);
  if (cell(r, 'kind') !== 'settlement_rail') throw new Error(`${r.where}: kind must be settlement_rail`);
  if (cell(r, 'network') !== 'stellar') throw new Error(`${r.where}: network must be stellar`);
  if (boolean(cell(r, 'simulated'), `${r.where} simulated`)) throw new Error(`${r.where}: the rail must not be simulated`);
  if (!csv(cell(r, 'legKinds')).includes('settle')) throw new Error(`${r.where}: legKinds must include settle`);
  if (providerRows().some((p) => cell(p, 'id') === RAIL_ID)) throw new Error(`${r.where}: the rail must not be one of the six providers`);
});

check('fees.md: no per-profile pricing table and no configured fee amount', () => {
  for (const tbl of parsed.fees) {
    if (tbl.header.includes('profile') || tbl.header.includes('flexipayFeeBps (placeholder)')) {
      throw new Error(`fees.md:${tbl.line}: a fee-per-profile table must not be configured`);
    }
  }
  const quoted = /"\d+" [A-Z]{3}/.exec(text.fees);
  if (quoted) throw new Error(`fees.md: writes a monetary fee value (${quoted[0]}); provider charges live in providers.md only`);
});

check('fees.md: the vault fee is the contract fee, not a config placeholder', () => {
  if (!/config\(\)/.test(text.fees)) throw new Error('fees.md must state that the vault fee is read from the contract config()');
  if (!/100 bps/.test(text.fees)) throw new Error('fees.md must state the owner-specified 100 bps vault fee');
  if (!/1(\.0)? percent/.test(text.fees)) throw new Error('fees.md must state the 1 percent fee');
  if (!/outside the vault|outside-vault/i.test(text.fees)) {
    throw new Error('fees.md must scope fees.json to legs outside the vault');
  }
});

check('fees.md: outside-vault leg charges are referenced, not restated', () => {
  if (!/providers\.md/.test(text.fees)) throw new Error('fees.md must point at providers.md for the outside-vault leg charges');
  for (const id of ['sim_bank_us_ach', 'sim_fx']) {
    if (!text.fees.includes(id)) throw new Error(`fees.md must name ${id} as an outside-vault leg charge in providers.md`);
  }
});

check('fees.md: tips carry no per-tip fee', () => {
  if (!/tips/i.test(text.fees) || !/0 bps/.test(text.fees)) throw new Error('fees.md must record the tips exception at 0 bps');
});

check('fees.md: quote validity is the 120 second placeholder', () => {
  if (!/quoteValiditySeconds/.test(text.fees)) throw new Error('fees.md must document quoteValiditySeconds');
  if (!/120\s*\(placeholder\)/.test(text.fees)) throw new Error('the 120 second value must be labelled a placeholder');
});

check('all drafts: every table row has one cell per header column', () => {
  for (const [sourceKey, tables] of Object.entries(parsed)) {
    for (const tbl of tables) {
      for (const [index, row] of tbl.rows.entries()) {
        if (row.length !== tbl.header.length) {
          throw new Error(`${sourceKey}.md:${tbl.line + 2 + index}: ${row.length} cells, header has ${tbl.header.length}`);
        }
      }
    }
  }
});

check('all drafts: money is a quoted integer with an explicit currency', () => {
  const moneyColumns = new Set(['feeFixed (placeholder)', 'min (placeholder)', 'max (placeholder)', ...LIMIT_COLUMNS]);
  for (const [sourceKey, tables] of Object.entries(parsed)) {
    for (const tbl of tables) {
      for (const [index, row] of tbl.rows.entries()) {
        for (const column of tbl.header) {
          if (!moneyColumns.has(column)) continue;
          const value = (row[tbl.header.indexOf(column)] || '').trim();
          if (!value || isTbd(value)) continue;
          money(value, `${sourceKey}.md:${tbl.line + 2 + index} ${column}`);
        }
      }
    }
  }
});

check('all drafts: no numeric value is stored as a decimal', () => {
  for (const [sourceKey, tables] of Object.entries(parsed)) {
    for (const tbl of tables) {
      for (const [index, row] of tbl.rows.entries()) {
        for (const column of tbl.header) {
          const value = (row[tbl.header.indexOf(column)] || '').trim();
          if (/^-?\d+\.\d+$/.test(value)) {
            throw new Error(`${sourceKey}.md:${tbl.line + 2 + index}: ${value} in ${column} is a decimal; use integer minor units or integer bps`);
          }
        }
      }
    }
  }
});

/* ------------------------------------------------------- unresolved reporting */

const unresolved = [];
for (const [sourceKey, tables] of Object.entries(parsed)) {
  for (const tbl of tables) {
    for (const [index, row] of tbl.rows.entries()) {
      const where = `${sourceKey}.md:${tbl.line + 2 + index}`;
      for (const column of tbl.header) {
        if (isTbd((row[tbl.header.indexOf(column)] || '').trim())) unresolved.push(`${where} ${column}`);
      }
    }
  }
}
for (const r of corridorRows()) {
  for (const [kind, entry] of parseLegs(cell(r, 'legsAvailable'), r.where)) {
    if (entry.tbd) unresolved.push(`${r.where} legsAvailable.${kind}`);
  }
}
unresolved.sort((a, b) => a.localeCompare(b));

/* ------------------------------------------------------------------- reporting */

let failed = 0;
for (const result of results) {
  if (result.ok) {
    console.log(`ok   ${result.name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${result.name}`);
    console.log(`     ${result.detail}`);
  }
}

console.log('');
console.log(`Unresolved (TBD) cells: ${unresolved.length}. Listed for review; not decided here:`);
for (const entry of unresolved) console.log(`  ${entry}`);

console.log('');
console.log(`${results.length - failed}/${results.length} draft checks passed; ${unresolved.length} cells unresolved.`);

if (failed > 0) {
  console.error(`FAILED: ${failed} check(s) did not pass.`);
  process.exit(1);
}

console.log('PASS — draft checks passed. This is not policy approval and not CC0 loader validation.');
