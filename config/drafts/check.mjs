#!/usr/bin/env node
/**
 * SF0-prep draft checker (dependency-free, no writes, no network).
 *
 * Reads the three draft tables next to this script (corridors.md, providers.md,
 * fees.md) and checks that they are complete and internally consistent enough for
 * review. It relies on the simple, fixed table format described in those files; it is
 * not a general markdown parser.
 *
 * Scope: this validates the DRAFT CONTENT only. It is not a validator for the future
 * CC0 configuration schema (config/corridors.json, providers.json, fees.json) and does
 * not load, generate or typecheck any JSON config.
 *
 * Prints PASS and exits 0 only when every implemented check passes.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

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

const FEE_COLUMNS = ['profile', 'flexipayFeeBps (placeholder)', 'percentLabel', 'placeholder', 'simulated', 'source'];

const EXAMPLE_COLUMNS = ['key', 'value', 'placeholder', 'note'];

const LIMIT_COLUMNS = [
  'limits.individual.min (placeholder)',
  'limits.individual.max (placeholder)',
  'limits.company.min (placeholder)',
  'limits.company.max (placeholder)',
];

// ARCHITECTURE §6.3 and §6.6, plus the sentinel used for a provider or leg that has
// none. No other endpoint or leg kind may appear in these drafts.
const ENDPOINT_TYPES = ['bank_account', 'ewallet', 'crypto_wallet', 'crypto_custodial'];
const LEG_KINDS = ['collect', 'convert', 'settle', 'payout'];
const PROVIDER_KINDS = ['bank', 'ewallet', 'fx'];
const PROFILES = ['small', 'batch', 'invoice', 'tips', 'domestic', 'one_off'];

const REQUIRED_CORRIDORS = [
  { from: 'US USD', to: 'US USD' },
  { from: 'US USD', to: 'PH PHP' },
  { from: 'US USD', to: 'BR BRL' },
  { from: 'US USD', to: 'ZA ZAR' },
];

const REQUIRED_PROVIDERS = [
  'sim_bank_us_ach',
  'sim_bank_ph_instapay',
  'sim_ewallet_ph',
  'sim_bank_br_pix',
  'sim_bank_za_eft',
  'sim_fx',
];

const SETTLEMENT_RAIL_ID = 'stellar_usdc';

const SECRET_MARKERS = [/sk_(?:live|test)_[A-Za-z0-9]/, /gh[pousr]_[A-Za-z0-9]{10,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN/, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/];

/* ------------------------------------------------------------------- parsing */

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableRow(line) {
  return line.trim().startsWith('|');
}

function isSeparator(line) {
  const t = line.trim();
  return /^\|[\s:|-]+\|$/.test(t) && t.includes('-');
}

/** Returns [{ header, rows, line }] for every pipe table found in the source. */
function parseTables(source) {
  const lines = source.split(/\r?\n/);
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    if (isTableRow(lines[i]) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const header = splitRow(lines[i]);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) {
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
  if (hits.length === 0) {
    throw new Error(`${label}: no table with the required columns (${signature.join(', ')})`);
  }
  throw new Error(`${label}: ${hits.length} tables match the required columns; the format allows exactly one`);
}

const tableErrors = [];
const T = {};

function loadTable(key, sourceKey, signature, label) {
  try {
    T[key] = findTable(sourceKey, signature, label);
  } catch (err) {
    T[key] = null;
    tableErrors.push(err.message);
  }
}

loadTable('corridors', 'corridors', CORRIDOR_COLUMNS, 'corridors.md');
loadTable('providers', 'providers', PROVIDER_COLUMNS, 'providers.md');
loadTable('settlement', 'providers', SETTLEMENT_COLUMNS, 'providers.md');
loadTable('fees', 'fees', FEE_COLUMNS, 'fees.md');
loadTable('example', 'fees', EXAMPLE_COLUMNS, 'fees.md');

function table(key, label) {
  if (!T[key]) {
    const recorded = tableErrors.find((message) => message.startsWith(label.split(' ')[0]));
    throw new Error(recorded || `${label}: table not found`);
  }
  return T[key];
}

function cell(tbl, row, column, label) {
  const index = tbl.header.indexOf(column);
  if (index < 0) throw new Error(`${label}: missing column ${column}`);
  const value = row[index];
  if (value === undefined || value === '') throw new Error(`${label}: empty value in column ${column}`);
  return value;
}

const MONEY = /^"(\d+)" ([A-Z]{3})$/;
const INTEGER = /^\d+$/;

function money(value, label) {
  const match = MONEY.exec(value);
  if (!match) {
    throw new Error(`${label}: ${JSON.stringify(value)} is not a quoted integer minor-unit amount with an explicit currency (expected like "100" USD)`);
  }
  return { minor: BigInt(match[1]), currency: match[2] };
}

function integer(value, label) {
  if (!INTEGER.test(value)) {
    throw new Error(`${label}: ${JSON.stringify(value)} is not an integer; no decimals and no percentages as floats`);
  }
  return BigInt(value);
}

function boolean(value, label) {
  if (value !== 'true' && value !== 'false') {
    throw new Error(`${label}: ${JSON.stringify(value)} must be "true" or "false"`);
  }
  return value === 'true';
}

function csv(value) {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** "collect: a, b; convert: none; ..." -> Map<legKind, string[]> with 'none' -> [] */
function parseLegs(value, label) {
  const legs = new Map();
  for (const part of value.split(';')) {
    const entry = part.trim();
    if (!entry) throw new Error(`${label}: empty leg entry`);
    const match = /^([a-z_]+): (.+)$/.exec(entry);
    if (!match) throw new Error(`${label}: leg entry ${JSON.stringify(entry)} must look like "collect: id, id"`);
    const kind = match[1];
    if (!LEG_KINDS.includes(kind)) throw new Error(`${label}: unknown leg kind ${kind}`);
    if (legs.has(kind)) throw new Error(`${label}: leg kind ${kind} listed twice`);
    const ids = csv(match[2]);
    if (ids.length === 0) throw new Error(`${label}: leg kind ${kind} has no value (use "none")`);
    if (ids.length === 1 && ids[0] === 'none') {
      legs.set(kind, []);
    } else {
      if (ids.includes('none')) throw new Error(`${label}: leg ${kind} mixes "none" with provider ids`);
      legs.set(kind, ids);
    }
  }
  for (const kind of LEG_KINDS) {
    if (!legs.has(kind)) throw new Error(`${label}: leg kind ${kind} is not listed (use "none" when absent)`);
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

function corridorRows() {
  const tbl = table('corridors', 'corridors.md corridor table');
  return tbl.rows.map((row, index) => ({ row, tbl, label: `corridors.md:${tbl.line + 2 + index} ${cell(tbl, row, 'from', 'corridors.md').toString()}` }));
}

function providerRows() {
  const tbl = table('providers', 'providers.md provider table');
  return tbl.rows.map((row, idx) => ({ row, tbl, label: `providers.md:${tbl.line + 2 + idx} ${cell(tbl, row, 'id', 'providers.md')}` }));
}

/** Provider/rail ids documented in providers.md, mapped to their legKinds. */
function documentedProviders() {
  const map = new Map();
  for (const { row, tbl, label } of providerRows()) {
    const id = cell(tbl, row, 'id', label);
    if (map.has(id)) throw new Error(`${label}: provider id ${id} documented twice`);
    map.set(id, {
      simulated: boolean(cell(tbl, row, 'simulated', label), `${label} simulated`),
      legKinds: csv(cell(tbl, row, 'legKinds', label)),
    });
  }
  const settlement = table('settlement', 'providers.md settlement rail table');
  for (const row of settlement.rows) {
    const id = cell(settlement, row, 'id', 'providers.md settlement rail');
    const label = `providers.md settlement rail ${id}`;
    if (map.has(id)) throw new Error(`${label}: id documented twice`);
    map.set(id, {
      simulated: boolean(cell(settlement, row, 'simulated', label), `${label} simulated`),
      legKinds: csv(cell(settlement, row, 'legKinds', label)),
    });
  }
  return map;
}

/* corridors.md ---------------------------------------------------------------- */

check('corridors.md: corridor table carries every §6.8 column', () => {
  table('corridors', 'corridors.md');
});

check('corridors.md: exactly the four required corridors, no duplicates', () => {
  const rows = corridorRows();
  if (rows.length !== REQUIRED_CORRIDORS.length) {
    throw new Error(`expected ${REQUIRED_CORRIDORS.length} corridor rows, found ${rows.length}`);
  }
  const seen = new Set();
  for (const { row, tbl, label } of rows) {
    const from = cell(tbl, row, 'from', label);
    const to = cell(tbl, row, 'to', label);
    const pair = `${from} -> ${to}`;
    if (seen.has(pair)) throw new Error(`${label}: corridor ${pair} listed twice`);
    seen.add(pair);
  }
  for (const required of REQUIRED_CORRIDORS) {
    if (!seen.has(`${required.from} -> ${required.to}`)) {
      throw new Error(`missing corridor ${required.from} -> ${required.to}`);
    }
  }
  if (rows.length !== seen.size) throw new Error('duplicate corridor rows');
});

check('corridors.md: every corridor is marked simulated: true', () => {
  for (const { row, tbl, label } of corridorRows()) {
    const value = boolean(cell(tbl, row, 'simulated', label), `${label} simulated`);
    if (!value) throw new Error(`${label}: simulated must be true`);
  }
});

check('corridors.md: destination endpoint types are source-defined (§6.3)', () => {
  let sawCryptoDestination = false;
  for (const { row, tbl, label } of corridorRows()) {
    const types = csv(cell(tbl, row, 'allowedDestinationTypes', label));
    if (types.length === 0) throw new Error(`${label}: no destination endpoint type`);
    for (const type of types) {
      if (!ENDPOINT_TYPES.includes(type)) throw new Error(`${label}: ${type} is not a §6.3 endpoint type`);
      if (type === 'crypto_wallet' || type === 'crypto_custodial') sawCryptoDestination = true;
    }
  }
  if (sawCryptoDestination) {
    throw new Error('a corridor allows a crypto destination endpoint; no corridor in this draft should');
  }
});

check('corridors.md: recipient kinds are individual and company', () => {
  for (const { row, tbl, label } of corridorRows()) {
    const kinds = csv(cell(tbl, row, 'recipientKinds', label));
    if (!kinds.includes('individual') || !kinds.includes('company')) {
      throw new Error(`${label}: recipientKinds must contain individual and company, found ${kinds.join(', ')}`);
    }
    for (const kind of kinds) {
      if (kind !== 'individual' && kind !== 'company') throw new Error(`${label}: unknown recipient kind ${kind}`);
    }
  }
});

check('corridors.md: cryptoLegAllowed is an explicit boolean per recipient kind', () => {
  for (const { row, tbl, label } of corridorRows()) {
    for (const kind of ['individual', 'company']) {
      boolean(cell(tbl, row, `cryptoLegAllowed.${kind}`, label), `${label} cryptoLegAllowed.${kind}`);
    }
  }
});

check('corridors.md: limits are quoted integer minor units with explicit currency', () => {
  for (const { row, tbl, label } of corridorRows()) {
    for (const column of LIMIT_COLUMNS) money(cell(tbl, row, column, label), `${label} ${column}`);
  }
});

check('corridors.md: each limit min is less than its matching max (BigInt)', () => {
  for (const { row, tbl, label } of corridorRows()) {
    for (const kind of ['individual', 'company']) {
      const min = money(cell(tbl, row, `limits.${kind}.min (placeholder)`, label), `${label} limits.${kind}.min`);
      const max = money(cell(tbl, row, `limits.${kind}.max (placeholder)`, label), `${label} limits.${kind}.max`);
      if (min.currency !== max.currency) {
        throw new Error(`${label}: limits.${kind} min currency ${min.currency} does not match max currency ${max.currency}`);
      }
      if (!(min.minor < max.minor)) {
        throw new Error(`${label}: limits.${kind} min ${min.minor} is not less than max ${max.minor}`);
      }
      if (min.minor === 0n) throw new Error(`${label}: limits.${kind} min is zero`);
    }
  }
});

check('corridors.md: limit currency matches the corridor receive currency', () => {
  for (const { row, tbl, label } of corridorRows()) {
    const to = cell(tbl, row, 'to', label);
    const [, receiveCurrency] = to.split(' ');
    if (!receiveCurrency) throw new Error(`${label}: "to" must be "<country> <currency>"`);
    for (const kind of ['individual', 'company']) {
      for (const bound of ['min', 'max']) {
        const amount = money(cell(tbl, row, `limits.${kind}.${bound} (placeholder)`, label), label);
        if (amount.currency !== receiveCurrency) {
          throw new Error(`${label}: limits.${kind}.${bound} is ${amount.currency} but the corridor receive currency is ${receiveCurrency}`);
        }
      }
    }
  }
});

check('corridors.md: legsAvailable maps lists under all four leg kinds', () => {
  for (const { row, tbl, label } of corridorRows()) {
    const legs = parseLegs(cell(tbl, row, 'legsAvailable', label), label);
    let total = 0;
    for (const [kind, ids] of legs) {
      for (const id of ids) {
        total += 1;
        if (!/^[a-z][a-z0-9_]+$/.test(id)) throw new Error(`${label}: leg ${kind} id ${id} is not a plain id`);
      }
    }
    if (total === 0) throw new Error(`${label}: legsAvailable lists no provider at all`);
  }
});

check('corridors.md: US domestic uses sim_bank_us_ach and excludes crypto', () => {
  const domestic = corridorRows().find(({ row, tbl }) => {
    const from = cell(tbl, row, 'from', 'corridors.md');
    const to = cell(tbl, row, 'to', 'corridors.md');
    return from === 'US USD' && to === 'US USD';
  });
  if (!domestic) throw new Error('US to US corridor row not found');
  const { row, tbl, label } = domestic;
  const types = csv(cell(tbl, row, 'allowedDestinationTypes', label));
  if (types.length !== 1 || types[0] !== 'bank_account') {
    throw new Error(`${label}: US domestic must allow bank_account only, found ${types.join(', ')}`);
  }
  for (const kind of ['individual', 'company']) {
    if (boolean(cell(tbl, row, `cryptoLegAllowed.${kind}`, label), label)) {
      throw new Error(`${label}: US domestic must not allow a crypto leg for ${kind}`);
    }
  }
  const legs = parseLegs(cell(tbl, row, 'legsAvailable', label), label);
  for (const kind of ['collect', 'convert', 'settle']) {
    if (legs.get(kind).length !== 0) throw new Error(`${label}: US domestic must not list a ${kind} provider`);
  }
  const payouts = legs.get('payout');
  if (!payouts.includes('sim_bank_us_ach')) throw new Error(`${label}: US domestic payout must include sim_bank_us_ach`);
  const rail = cell(tbl, row, 'domesticRail', label);
  if (rail !== 'sim_bank_us_ach') throw new Error(`${label}: domesticRail must be sim_bank_us_ach, found ${rail}`);
  if (cell(tbl, row, 'legsAvailable', label).includes(SETTLEMENT_RAIL_ID)) {
    throw new Error(`${label}: US domestic must not reference ${SETTLEMENT_RAIL_ID}`);
  }
});

check('corridors.md: PH allows bank and e-wallet, BR and ZA are bank only', () => {
  const byTo = new Map();
  for (const entry of corridorRows()) {
    byTo.set(cell(entry.tbl, entry.row, 'to', entry.label), entry);
  }
  const ph = byTo.get('PH PHP');
  if (!ph) throw new Error('US to PH corridor row not found');
  const phTypes = csv(cell(ph.tbl, ph.row, 'allowedDestinationTypes', ph.label));
  for (const required of ['bank_account', 'ewallet']) {
    if (!phTypes.includes(required)) throw new Error(`${ph.label}: allowedDestinationTypes must include ${required}`);
  }
  for (const to of ['BR BRL', 'ZA ZAR']) {
    const entry = byTo.get(to);
    if (!entry) throw new Error(`corridor ${to} not found`);
    const types = csv(cell(entry.tbl, entry.row, 'allowedDestinationTypes', entry.label));
    if (types.length !== 1 || types[0] !== 'bank_account') {
      throw new Error(`${entry.label}: must allow bank_account only, found ${types.join(', ')}`);
    }
  }
});

check('corridors.md: ZA excludes crypto for both kinds and has no crypto leg', () => {
  const za = corridorRows().find(({ row, tbl }) => cell(tbl, row, 'to', 'corridors.md') === 'ZA ZAR');
  if (!za) throw new Error('US to ZA corridor row not found');
  const { row, tbl, label } = za;
  for (const kind of ['individual', 'company']) {
    if (boolean(cell(tbl, row, `cryptoLegAllowed.${kind}`, label), label)) {
      throw new Error(`${label}: cryptoLegAllowed.${kind} must be false`);
    }
  }
  const legsCell = cell(tbl, row, 'legsAvailable', label);
  if (legsCell.includes(SETTLEMENT_RAIL_ID)) throw new Error(`${label}: legsAvailable must not reference ${SETTLEMENT_RAIL_ID}`);
  const legs = parseLegs(legsCell, label);
  if (legs.get('settle').length !== 0) {
    throw new Error(`${label}: ZA must have no settle leg, found ${legs.get('settle').join(', ')}`);
  }
  const note = cell(tbl, row, 'regulationNote', label);
  if (!/3 Aug 2026/.test(note)) throw new Error(`${label}: regulationNote must name the 3 Aug 2026 draft rules`);
  if (!/rewritten/.test(note)) throw new Error(`${label}: regulationNote must say the rules are being rewritten`);
  if (!/not legal advice/i.test(note)) throw new Error(`${label}: regulationNote must state that this is not legal advice`);
});

check('providers.md: every provider/rail id used by a corridor is documented', () => {
  const documented = documentedProviders();
  for (const { row, tbl, label } of corridorRows()) {
    const legs = parseLegs(cell(tbl, row, 'legsAvailable', label), label);
    for (const [kind, ids] of legs) {
      for (const id of ids) {
        if (id === 'none') continue;
        if (!documented.has(id)) throw new Error(`${label}: leg ${kind} uses undocumented id ${id}`);
      }
    }
  }
});

check('corridors.md: domesticRail is a documented id, or none for cross-border', () => {
  const documented = documentedProviders();
  for (const { row, tbl, label } of corridorRows()) {
    const rail = cell(tbl, row, 'domesticRail', label);
    const from = cell(tbl, row, 'from', label);
    const to = cell(tbl, row, 'to', label);
    const sameCountry = from.split(' ')[0] === to.split(' ')[0];
    if (rail === 'none') {
      if (sameCountry) throw new Error(`${label}: domesticRail is none but from and to are the same country`);
      continue;
    }
    if (!sameCountry) throw new Error(`${label}: domesticRail ${rail} set for a cross-border corridor`);
    if (!documented.has(rail)) throw new Error(`${label}: domesticRail ${rail} is not documented in providers.md`);
  }
});

check('corridors.md: each referenced id supports the leg kind it is used for', () => {
  const documented = documentedProviders();
  for (const { row, tbl, label } of corridorRows()) {
    const legs = parseLegs(cell(tbl, row, 'legsAvailable', label), label);
    for (const [kind, ids] of legs) {
      for (const id of ids) {
        if (id === 'none') continue;
        const doc = documented.get(id);
        if (!doc) throw new Error(`${label}: undocumented id ${id}`);
        if (!doc.legKinds.includes(kind)) {
          throw new Error(`${label}: ${id} is used on a ${kind} leg but documents legKinds ${doc.legKinds.join(', ')}`);
        }
      }
    }
  }
});

check('corridors.md: the Latin American demo country decision sits in one place', () => {
  const headings = text.corridors.match(/^#+.*latin american demo country decision.*$/gim) || [];
  if (headings.length !== 1) {
    throw new Error(`expected exactly one "Latin American demo country decision" heading, found ${headings.length}`);
  }
  const start = text.corridors.search(/^#+.*latin american demo country decision.*$/im);
  const section = text.corridors.slice(start, start + 1400);
  if (!/brazil/i.test(section)) throw new Error('the decision section must name Brazil as the default');
  if (!/mexico/i.test(section)) throw new Error('the decision section must name Mexico as the possible replacement');
  const br = corridorRows().find(({ row, tbl }) => cell(tbl, row, 'to', 'corridors.md') === 'BR BRL');
  if (!br) throw new Error('US to BR corridor row not found');
  if (!/latin american demo country decision/i.test(cell(br.tbl, br.row, 'regulationNote', br.label))) {
    throw new Error(`${br.label}: regulationNote must point at the single decision section`);
  }
});

/* providers.md ---------------------------------------------------------------- */

check('providers.md: exactly the six required simulated providers, no extras', () => {
  const ids = providerRows().map(({ row, tbl, label }) => cell(tbl, row, 'id', label));
  for (const required of REQUIRED_PROVIDERS) {
    if (!ids.includes(required)) throw new Error(`missing required provider ${required}`);
  }
  for (const id of ids) {
    if (!REQUIRED_PROVIDERS.includes(id)) throw new Error(`unexpected provider ${id}; no provider may be invented in this task`);
  }
  if (ids.length !== REQUIRED_PROVIDERS.length) throw new Error(`expected ${REQUIRED_PROVIDERS.length} provider rows, found ${ids.length}`);
});

check('providers.md: every simulated provider row is marked simulated: true', () => {
  const rows = providerRows();
  if (rows.length === 0) throw new Error('no provider rows');
  for (const { row, tbl, label } of rows) {
    if (!boolean(cell(tbl, row, 'simulated', label), `${label} simulated`)) {
      throw new Error(`${label}: simulated must be true`);
    }
  }
});

check('providers.md: provider kinds, endpoint types and leg kinds are source-defined', () => {
  for (const { row, tbl, label } of providerRows()) {
    const kind = cell(tbl, row, 'kind', label);
    if (!PROVIDER_KINDS.includes(kind)) throw new Error(`${label}: kind ${kind} is not a §11.1 provider kind (no anchor in this task)`);
    for (const type of csv(cell(tbl, row, 'endpointTypes', label))) {
      if (type !== 'none' && !ENDPOINT_TYPES.includes(type)) throw new Error(`${label}: ${type} is not a §6.3 endpoint type`);
    }
    for (const legKind of csv(cell(tbl, row, 'legKinds', label))) {
      if (!LEG_KINDS.includes(legKind)) throw new Error(`${label}: ${legKind} is not a §6.6 leg kind`);
    }
    if (cell(tbl, row, 'countries', label) === 'none') throw new Error(`${label}: countries must be listed`);
    if (cell(tbl, row, 'currenciesOrAsset', label) === 'none') throw new Error(`${label}: currencies must be listed`);
  }
});

check('providers.md: fee and spread columns are integer bps, feeFixed is money', () => {
  for (const { row, tbl, label } of providerRows()) {
    money(cell(tbl, row, 'feeFixed (placeholder)', label), `${label} feeFixed`);
    for (const column of ['feeBps (placeholder)', 'fxSpreadBps (placeholder)']) {
      const bps = integer(cell(tbl, row, column, label), `${label} ${column}`);
      if (bps > 10000n) throw new Error(`${label}: ${column} ${bps} exceeds 10000 bps (100 percent)`);
    }
  }
});

check('providers.md: estimated time is a positive integer number of seconds', () => {
  for (const { row, tbl, label } of providerRows()) {
    const seconds = integer(cell(tbl, row, 'estimatedTimeSeconds (placeholder)', label), `${label} estimatedTimeSeconds`);
    if (seconds <= 0n) throw new Error(`${label}: estimatedTimeSeconds must be greater than zero`);
  }
});

check('providers.md: min and max are quoted integers with one currency, min less than max', () => {
  for (const { row, tbl, label } of providerRows()) {
    const min = money(cell(tbl, row, 'min (placeholder)', label), `${label} min`);
    const max = money(cell(tbl, row, 'max (placeholder)', label), `${label} max`);
    if (min.currency !== max.currency) {
      throw new Error(`${label}: min currency ${min.currency} does not match max currency ${max.currency}`);
    }
    if (!(min.minor < max.minor)) throw new Error(`${label}: min ${min.minor} is not less than max ${max.minor}`);
    const fee = money(cell(tbl, row, 'feeFixed (placeholder)', label), `${label} feeFixed`);
    if (fee.minor < 0n) throw new Error(`${label}: feeFixed must not be negative`);
  }
});

check('providers.md: the settlement rail is not simulated and is listed separately', () => {
  const tbl = table('settlement', 'providers.md settlement rail table');
  if (tbl.rows.length !== 1) throw new Error(`expected exactly one settlement rail row, found ${tbl.rows.length}`);
  const row = tbl.rows[0];
  const label = 'providers.md settlement rail';
  const id = cell(tbl, row, 'id', label);
  if (id !== SETTLEMENT_RAIL_ID) throw new Error(`${label}: id must be ${SETTLEMENT_RAIL_ID}, found ${id}`);
  if (cell(tbl, row, 'kind', label) !== 'settlement_rail') throw new Error(`${label}: kind must be settlement_rail`);
  if (cell(tbl, row, 'network', label) !== 'stellar') throw new Error(`${label}: network must be stellar`);
  if (boolean(cell(tbl, row, 'simulated', label), `${label} simulated`)) {
    throw new Error(`${label}: the testnet settlement rail must not be marked simulated`);
  }
  const legs = csv(cell(tbl, row, 'legKinds', label));
  if (!legs.includes('settle')) throw new Error(`${label}: legKinds must include settle`);
  if (tbl.header.includes('endpointTypes')) {
    throw new Error(`${label}: the settlement rail is not an endpoint provider and must not carry endpoint types`);
  }
  const providerIds = providerRows().map(({ row: r, tbl: t, label: l }) => cell(t, r, 'id', l));
  if (providerIds.includes(SETTLEMENT_RAIL_ID)) {
    throw new Error(`${label}: ${SETTLEMENT_RAIL_ID} must not be listed among the six simulated providers`);
  }
  if (!/NOT specified/i.test(cell(tbl, row, 'metadataStatus', label))) {
    throw new Error(`${label}: metadataStatus must record the unspecified metadata gap instead of inventing values`);
  }
});

check('providers.md: simulated providers use the sim_ id namespace, the rail does not', () => {
  for (const { row, tbl, label } of providerRows()) {
    const id = cell(tbl, row, 'id', label);
    if (!id.startsWith('sim_')) throw new Error(`${label}: a simulated provider id must start with sim_, found ${id}`);
  }
  const settlement = table('settlement', 'providers.md settlement rail table');
  const railId = cell(settlement, settlement.rows[0], 'id', 'providers.md settlement rail');
  if (railId.startsWith('sim_')) throw new Error('the settlement rail must not sit in the simulated provider namespace');
});

/* fees.md --------------------------------------------------------------------- */

check('fees.md: fee table has exactly the six §6.5 profiles', () => {
  const tbl = table('fees', 'fees.md fee table');
  const profiles = tbl.rows.map((row, idx) => cell(tbl, row, 'profile', `fees.md:${tbl.line + 2 + idx}`));
  for (const required of PROFILES) {
    if (!profiles.includes(required)) throw new Error(`missing profile ${required}`);
  }
  for (const profile of profiles) {
    if (!PROFILES.includes(profile)) throw new Error(`unknown profile ${profile}`);
  }
  if (profiles.length !== PROFILES.length) throw new Error(`expected ${PROFILES.length} profile rows, found ${profiles.length}`);
});

check('fees.md: standard fee is 100 bps and tips is 0 bps', () => {
  const tbl = table('fees', 'fees.md fee table');
  if (!/1\.0 percent = 100 bps/.test(text.fees)) throw new Error('the standard fee statement "1.0 percent = 100 bps" is missing');
  for (const [idx, row] of tbl.rows.entries()) {
    const label = `fees.md:${tbl.line + 2 + idx}`;
    const profile = cell(tbl, row, 'profile', label);
    const bps = integer(cell(tbl, row, 'flexipayFeeBps (placeholder)', label), `${label} flexipayFeeBps`);
    const expected = profile === 'tips' ? 0n : 100n;
    if (bps !== expected) throw new Error(`${label}: profile ${profile} must be ${expected} bps, found ${bps}`);
    const expectedLabel = profile === 'tips' ? '0.0 percent' : '1.0 percent';
    const shown = cell(tbl, row, 'percentLabel', label);
    if (shown !== expectedLabel) throw new Error(`${label}: percentLabel must be "${expectedLabel}", found "${shown}"`);
    if (!cell(tbl, row, 'source', label).trim()) throw new Error(`${label}: source must cite where the value comes from`);
  }
});

check('fees.md: every fee row is a labelled placeholder and simulated', () => {
  const tbl = table('fees', 'fees.md fee table');
  for (const [idx, row] of tbl.rows.entries()) {
    const label = `fees.md:${tbl.line + 2 + idx}`;
    if (cell(tbl, row, 'placeholder', label) !== 'true') throw new Error(`${label}: placeholder must be true`);
    if (cell(tbl, row, 'simulated', label) !== 'true') throw new Error(`${label}: simulated must be true`);
  }
});

check('fees.md: quote validity is the 120 second placeholder', () => {
  if (!/quoteValiditySeconds/.test(text.fees)) throw new Error('quoteValiditySeconds is not documented');
  if (!/120\s*\(placeholder\)/.test(text.fees)) throw new Error('the 120 second default is not labelled as a placeholder');
});

check('fees.md: the money example is exact integer arithmetic (BigInt)', () => {
  const tbl = table('example', 'fees.md money example table');
  const byKey = new Map();
  for (const [idx, row] of tbl.rows.entries()) {
    const label = `fees.md:${tbl.line + 2 + idx}`;
    const key = cell(tbl, row, 'key', label);
    if (byKey.has(key)) throw new Error(`${label}: duplicate key ${key}`);
    byKey.set(key, { row, label });
  }
  for (const key of ['exampleSendAmount', 'exampleFlexiPayFeeBps', 'exampleFlexiPayFee']) {
    if (!byKey.has(key)) throw new Error(`money example is missing ${key}`);
  }
  const { row: amountRow } = byKey.get('exampleSendAmount');
  const { row: bpsRow } = byKey.get('exampleFlexiPayFeeBps');
  const { row: feeRow } = byKey.get('exampleFlexiPayFee');
  const amount = money(cell(tbl, amountRow, 'value', 'fees.md example amount'), 'fees.md example amount');
  const bps = integer(cell(tbl, bpsRow, 'value', 'fees.md example bps'), 'fees.md example bps');
  const fee = money(cell(tbl, feeRow, 'value', 'fees.md example fee'), 'fees.md example fee');
  if (amount.currency !== fee.currency) throw new Error('the example amount and fee currencies differ');
  if ((amount.minor * bps) % 10000n !== 0n) {
    throw new Error('the example fee is not exact in integer minor units; do not use a rounding rule that is not defined');
  }
  const expectedFee = (amount.minor * bps) / 10000n;
  if (fee.minor !== expectedFee) {
    throw new Error(`the example fee is ${fee.minor} but ${amount.minor} x ${bps} bps = ${expectedFee} minor units`);
  }
});

/* cross-cutting --------------------------------------------------------------- */

check('all drafts: every table row has one cell per header column', () => {
  for (const [sourceKey, tables] of Object.entries(parsed)) {
    for (const tbl of tables) {
      for (const [idx, row] of tbl.rows.entries()) {
        if (row.length !== tbl.header.length) {
          throw new Error(`${sourceKey}.md:${tbl.line + 2 + idx}: ${row.length} cells but the header has ${tbl.header.length}`);
        }
      }
    }
  }
});

check('all drafts: money is quoted integer minor units with explicit currency', () => {
  const moneyColumns = new Set([
    'feeFixed (placeholder)',
    'min (placeholder)',
    'max (placeholder)',
    ...LIMIT_COLUMNS,
    'value',
  ]);
  for (const [sourceKey, tables] of Object.entries(parsed)) {
    for (const tbl of tables) {
      for (const [idx, row] of tbl.rows.entries()) {
        for (const column of tbl.header) {
          if (!moneyColumns.has(column)) continue;
          const position = tbl.header.indexOf(column);
          const value = (row[position] || '').trim();
          if (!value) continue;
          // The example table mixes money and bps in one column; only money-shaped,
          // quoted values are checked here, and unquoted values must be integers.
          if (/^".*"$/.test(value) || /[A-Z]{3}$/.test(value)) {
            money(value, `${sourceKey}.md:${tbl.line + 2 + idx} ${column}`);
          }
        }
      }
    }
  }
});

check('all drafts: no numeric value is stored as a decimal (no floats)', () => {
  for (const [sourceKey, tables] of Object.entries(parsed)) {
    for (const tbl of tables) {
      for (const [idx, row] of tbl.rows.entries()) {
        for (const [position, value] of row.entries()) {
          const column = tbl.header[position];
          if (column === 'percentLabel') continue;
          if (!/^-?\d+\.\d+$/.test(value.trim())) continue;
          throw new Error(`${sourceKey}.md:${tbl.line + 2 + idx}: ${JSON.stringify(value)} in column ${column} is stored as a decimal; use integer minor units or integer bps`);
        }
      }
    }
  }
});

check('all drafts: no secrets or real account data', () => {
  for (const [key, name] of Object.entries(FILES)) {
    for (const pattern of SECRET_MARKERS) {
      const match = pattern.exec(text[key]);
      if (match) throw new Error(`${name}: looks like a secret or real account data (${JSON.stringify(match[0].slice(0, 24))})`);
    }
  }
});

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
console.log(`${results.length - failed}/${results.length} checks passed — SF0-prep draft content only, not the CC0 schema.`);

if (failed > 0) {
  console.error(`FAILED: ${failed} check(s) did not pass.`);
  process.exit(1);
}

console.log('PASS');
