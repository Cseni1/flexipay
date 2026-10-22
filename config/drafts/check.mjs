#!/usr/bin/env node
/**
 * SF0-prep draft checker (dependency-free, no writes, no network).
 *
 * Reads the three draft tables next to this script (corridors.md, providers.md,
 * fees.md) and checks that they are internally consistent and that every value is
 * either confirmed by a source or explicitly marked unresolved.
 *
 * TWO KINDS OF RESULT
 * - A failing check is a contradiction or a missing required value: exit code 1.
 * - `TBD` is a first-class unresolved state. It is never treated as a passing value:
 *   the script lists every unresolved cell as a blocker and says in the final line that
 *   those cells are NOT approved configuration. Nothing about them is validated as
 *   policy, because no source states them.
 *
 * The three assumption classes this guards are the ones review asked to keep
 * unresolved rather than decided:
 * - per-kind crypto eligibility for PH and BR (Q4),
 * - the corridor limit values and their send/receive side (Q3),
 * - the bank-only cross-border leg sequence and the domestic rail leg kind (CC-1, CC-2),
 * plus the FX limit side (Q6) and the fee side (Q9).
 *
 * Scope: the DRAFT CONTENT only. This is not a validator for the future CC0
 * configuration schema (config/corridors.json, providers.json, fees.json) and does not
 * load, generate or typecheck any JSON config.
 *
 * It relies on the simple, fixed table format described in those files; it is not a
 * general markdown parser.
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

const TBD = 'TBD';

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

// Columns where an unresolved value is allowed. Everywhere else a TBD is a failure:
// confirmed rules must be written out.
const TBD_ALLOWED_COLUMNS = new Set([
  'cryptoLegAllowed.individual',
  'cryptoLegAllowed.company',
  ...LIMIT_COLUMNS,
  'legsAvailable',
  'feeFixed (placeholder)',
  'min (placeholder)',
  'max (placeholder)',
  'value',
]);

const SECRET_MARKERS = [
  /sk_(?:live|test)_[A-Za-z0-9]/,
  /gh[pousr]_[A-Za-z0-9]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
];

/* ------------------------------------------------------------------- parsing */

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((entry) => entry.trim());
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
    const prefix = label.split(' ')[0];
    const recorded = tableErrors.find((message) => message.startsWith(prefix));
    throw new Error(recorded || `${label}: table not found`);
  }
  return T[key];
}

/** Wraps a data row with the file:line its values come from. */
function rowRefs(tableKey, fileKey) {
  const tbl = table(tableKey, `${fileKey}.md`);
  return tbl.rows.map((row, index) => ({
    row,
    tbl,
    where: `${fileKey}.md:${tbl.line + 2 + index}`,
  }));
}

function cell(r, column) {
  const index = r.tbl.header.indexOf(column);
  if (index < 0) throw new Error(`${r.where}: missing column ${column}`);
  const value = r.row[index];
  if (value === undefined || value === '') throw new Error(`${r.where}: empty value in column ${column}`);
  return value;
}

function isTbd(value) {
  return value.trim() === TBD;
}

/* ----------------------------------------------------------------- blockers */

const blockers = new Map();

function blockerKey(where, column) {
  return `${where}|${column}`;
}

function block(r, column, reason) {
  blockers.set(blockerKey(r.where, column), { where: r.where, column, reason });
}

/** A confirmed value: TBD is a failure here. */
function confirmed(r, column) {
  const value = cell(r, column);
  if (isTbd(value)) {
    throw new Error(`${r.where} ${column}: TBD is not allowed here; this value is fixed by the sources`);
  }
  return value;
}

/** A value that may be unresolved: TBD registers a blocker instead of passing. */
function maybeMoney(r, column, reason) {
  const value = cell(r, column);
  if (isTbd(value)) {
    block(r, column, reason);
    return null;
  }
  return money(value, `${r.where} ${column}`);
}

/* -------------------------------------------------------------- value parsers */

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

/** "collect: a, b; convert: none; ..." -> Map<legKind, { tbd, ids }> */
function parseLegs(value, r) {
  const legs = new Map();
  for (const part of value.split(';')) {
    const entry = part.trim();
    if (!entry) throw new Error(`${r.where} legsAvailable: empty leg entry`);
    const match = /^([a-z_]+): (.+)$/.exec(entry);
    if (!match) throw new Error(`${r.where} legsAvailable: leg entry ${JSON.stringify(entry)} must look like "collect: id, id"`);
    const kind = match[1];
    if (!LEG_KINDS.includes(kind)) throw new Error(`${r.where} legsAvailable: unknown leg kind ${kind}`);
    if (legs.has(kind)) throw new Error(`${r.where} legsAvailable: leg kind ${kind} listed twice`);
    const raw = match[2].trim();
    if (raw === TBD) {
      legs.set(kind, { tbd: true, ids: [] });
      continue;
    }
    const ids = csv(raw);
    if (ids.length === 1 && ids[0] === 'none') {
      legs.set(kind, { tbd: false, ids: [] });
      continue;
    }
    if (ids.includes('none')) throw new Error(`${r.where} legsAvailable: leg ${kind} mixes "none" with provider ids`);
    legs.set(kind, { tbd: false, ids });
  }
  for (const kind of LEG_KINDS) {
    if (!legs.has(kind)) throw new Error(`${r.where} legsAvailable: leg kind ${kind} is not listed (use "none" or TBD)`);
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
  return rowRefs('corridors', 'corridors');
}

function providerRows() {
  return rowRefs('providers', 'providers');
}

/** Provider/rail ids documented in providers.md, mapped to their legKinds. */
function documentedProviders() {
  const map = new Map();
  for (const r of providerRows()) {
    const id = cell(r, 'id');
    if (map.has(id)) throw new Error(`${r.where}: provider id ${id} documented twice`);
    map.set(id, {
      simulated: boolean(cell(r, 'simulated'), `${r.where} simulated`),
      legKinds: csv(cell(r, 'legKinds')),
    });
  }
  const settlement = table('settlement', 'providers.md settlement rail table');
  for (const [index, row] of settlement.rows.entries()) {
    const r = { row, tbl: settlement, where: `providers.md:${settlement.line + 2 + index}` };
    const id = cell(r, 'id');
    if (map.has(id)) throw new Error(`${r.where}: id ${id} documented twice`);
    map.set(id, {
      simulated: boolean(cell(r, 'simulated'), `${r.where} simulated`),
      legKinds: csv(cell(r, 'legKinds')),
    });
  }
  return map;
}

/* corridors.md ---------------------------------------------------------------- */

check('corridors.md: corridor table carries every §6.8 column', () => {
  table('corridors', 'corridors.md');
});

check('corridors.md: exactly the four baseline corridors, no duplicates', () => {
  const rows = corridorRows();
  if (rows.length !== REQUIRED_CORRIDORS.length) {
    throw new Error(`expected ${REQUIRED_CORRIDORS.length} corridor rows, found ${rows.length}`);
  }
  const seen = new Set();
  for (const r of rows) {
    const pair = `${cell(r, 'from')} -> ${cell(r, 'to')}`;
    if (seen.has(pair)) throw new Error(`${r.where}: corridor ${pair} listed twice`);
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
  for (const r of corridorRows()) {
    if (!boolean(confirmed(r, 'simulated'), `${r.where} simulated`)) {
      throw new Error(`${r.where}: simulated must be true`);
    }
  }
});

check('corridors.md: destination endpoint types are source-defined (§6.3)', () => {
  let sawCryptoDestination = false;
  for (const r of corridorRows()) {
    const types = csv(confirmed(r, 'allowedDestinationTypes'));
    if (types.length === 0) throw new Error(`${r.where}: no destination endpoint type`);
    for (const type of types) {
      if (!ENDPOINT_TYPES.includes(type)) throw new Error(`${r.where}: ${type} is not a §6.3 endpoint type`);
      if (type === 'crypto_wallet' || type === 'crypto_custodial') sawCryptoDestination = true;
    }
  }
  if (sawCryptoDestination) {
    throw new Error('a corridor allows a crypto destination endpoint; no baseline corridor in this draft should');
  }
});

check('corridors.md: recipient kinds are individual and company', () => {
  for (const r of corridorRows()) {
    const kinds = csv(confirmed(r, 'recipientKinds'));
    for (const kind of kinds) {
      if (kind !== 'individual' && kind !== 'company') throw new Error(`${r.where}: unknown recipient kind ${kind}`);
    }
    if (!kinds.includes('individual') || !kinds.includes('company')) {
      throw new Error(`${r.where}: recipientKinds must contain individual and company, found ${kinds.join(', ')}`);
    }
  }
});

check('corridors.md: US and ZA are confirmed crypto:false for both recipient kinds', () => {
  let checked = 0;
  for (const r of corridorRows()) {
    const to = cell(r, 'to');
    if (to !== 'US USD' && to !== 'ZA ZAR') continue;
    for (const kind of ['individual', 'company']) {
      const value = confirmed(r, `cryptoLegAllowed.${kind}`);
      checked += 1;
      if (boolean(value, `${r.where} cryptoLegAllowed.${kind}`)) {
        throw new Error(`${r.where}: cryptoLegAllowed.${kind} must be false for ${to}`);
      }
    }
  }
  if (checked !== 4) throw new Error(`expected US and ZA crypto rules to be checked 4 times, checked ${checked}`);
});

check('corridors.md: PH and BR crypto policy is unresolved (TBD), never asserted', () => {
  let checked = 0;
  for (const r of corridorRows()) {
    const to = cell(r, 'to');
    if (to !== 'PH PHP' && to !== 'BR BRL') continue;
    for (const kind of ['individual', 'company']) {
      const value = cell(r, `cryptoLegAllowed.${kind}`);
      checked += 1;
      if (!isTbd(value)) {
        throw new Error(`${r.where} cryptoLegAllowed.${kind}: no source states per-kind crypto permission for ${to}, so this must stay TBD (Q4) rather than assert a policy`);
      }
      block(r, `cryptoLegAllowed.${kind}`, 'Q4: per-kind crypto policy for this corridor is not stated by any source; when the integrator records the answer, update this table and this check together');
    }
  }
  if (checked !== 4) throw new Error(`expected PH and BR crypto flags to be checked 4 times, checked ${checked}`);
});

check('corridors.md: each limit pair is both unresolved or both resolved', () => {
  for (const r of corridorRows()) {
    for (const kind of ['individual', 'company']) {
      const min = cell(r, `limits.${kind}.min (placeholder)`);
      const max = cell(r, `limits.${kind}.max (placeholder)`);
      if (isTbd(min) !== isTbd(max)) {
        throw new Error(`${r.where}: limits.${kind} has one bound unresolved and one written; record both or neither`);
      }
    }
  }
});

check('corridors.md: limits are quoted integer minor units, or TBD (Q3)', () => {
  for (const r of corridorRows()) {
    for (const column of LIMIT_COLUMNS) {
      maybeMoney(r, column, 'Q3: §6.8 does not state whether a per-payment limit is the send side or the receive side, and an amount needs a currency');
    }
  }
});

check('corridors.md: each resolved limit min is less than its max (BigInt)', () => {
  for (const r of corridorRows()) {
    for (const kind of ['individual', 'company']) {
      const min = maybeMoney(r, `limits.${kind}.min (placeholder)`, 'Q3: limit side unresolved');
      const max = maybeMoney(r, `limits.${kind}.max (placeholder)`, 'Q3: limit side unresolved');
      if (min === null || max === null) continue;
      if (min.currency !== max.currency) {
        throw new Error(`${r.where}: limits.${kind} min currency ${min.currency} does not match max currency ${max.currency}`);
      }
      if (!(min.minor < max.minor)) {
        throw new Error(`${r.where}: limits.${kind} min ${min.minor} is not less than max ${max.minor}`);
      }
      if (min.minor === 0n) throw new Error(`${r.where}: limits.${kind} min is zero`);
    }
  }
});

check('corridors.md: each resolved limit uses the corridor receive currency', () => {
  for (const r of corridorRows()) {
    const [, receiveCurrency] = cell(r, 'to').split(' ');
    if (!receiveCurrency) throw new Error(`${r.where}: "to" must be "<country> <currency>"`);
    for (const kind of ['individual', 'company']) {
      for (const bound of ['min', 'max']) {
        const amount = money2(r, `limits.${kind}.${bound} (placeholder)`);
        if (amount === null) continue;
        if (amount.currency !== receiveCurrency) {
          throw new Error(`${r.where}: limits.${kind}.${bound} is ${amount.currency} but the corridor receive currency is ${receiveCurrency}`);
        }
      }
    }
  }
});

function money2(r, column) {
  const value = cell(r, column);
  return isTbd(value) ? null : money(value, `${r.where} ${column}`);
}

check('corridors.md: legsAvailable maps all four leg kinds as lists, none or TBD', () => {
  for (const r of corridorRows()) {
    const legs = parseLegs(cell(r, 'legsAvailable'), r);
    for (const [kind, entry] of legs) {
      for (const id of entry.ids) {
        if (!/^[a-z][a-z0-9_]+$/.test(id)) throw new Error(`${r.where}: leg ${kind} id ${id} is not a plain id`);
      }
    }
    const resolved = [...legs.values()].filter((entry) => !entry.tbd && entry.ids.length > 0).length;
    if (resolved === 0) throw new Error(`${r.where}: legsAvailable names no provider at all`);
  }
});

check('corridors.md: US domestic uses sim_bank_us_ach, settle none, no crypto', () => {
  const domestic = corridorRows().find((r) => cell(r, 'to') === 'US USD' && cell(r, 'from') === 'US USD');
  if (!domestic) throw new Error('US to US corridor row not found');
  const r = domestic;
  const types = csv(confirmed(r, 'allowedDestinationTypes'));
  if (types.length !== 1 || types[0] !== 'bank_account') {
    throw new Error(`${r.where}: US domestic must allow bank_account only, found ${types.join(', ')}`);
  }
  for (const kind of ['individual', 'company']) {
    if (boolean(confirmed(r, `cryptoLegAllowed.${kind}`), r.where)) {
      throw new Error(`${r.where}: US domestic must not allow a crypto leg for ${kind}`);
    }
  }
  if (cell(r, 'legsAvailable').includes(SETTLEMENT_RAIL_ID)) {
    throw new Error(`${r.where}: US domestic must not reference ${SETTLEMENT_RAIL_ID}`);
  }
  const legs = parseLegs(cell(r, 'legsAvailable'), r);
  const settle = legs.get('settle');
  if (settle.tbd || settle.ids.length !== 0) throw new Error(`${r.where}: US domestic settle leg must be "none"`);
  const payout = legs.get('payout');
  if (payout.tbd || !payout.ids.includes('sim_bank_us_ach')) {
    throw new Error(`${r.where}: US domestic payout must include sim_bank_us_ach`);
  }
  if (confirmed(r, 'domesticRail') !== 'sim_bank_us_ach') {
    throw new Error(`${r.where}: domesticRail must be sim_bank_us_ach`);
  }
  for (const kind of ['collect', 'convert']) {
    const entry = legs.get(kind);
    if (!entry.tbd) {
      throw new Error(`${r.where}: the ${kind} leg of the domestic route is not specified by §8 (CC-2) and must stay TBD rather than assert a route shape`);
    }
    block(r, `legsAvailable.${kind}`, 'CC-2: §8 names the domestic rail without naming its leg kind; when the integrator answers, update this table and this check together');
  }
});

check('corridors.md: PH allows bank and e-wallet; BR and ZA are bank only', () => {
  const byTo = new Map();
  for (const r of corridorRows()) byTo.set(cell(r, 'to'), r);
  const ph = byTo.get('PH PHP');
  if (!ph) throw new Error('US to PH corridor row not found');
  const phTypes = csv(confirmed(ph, 'allowedDestinationTypes'));
  for (const required of ['bank_account', 'ewallet']) {
    if (!phTypes.includes(required)) throw new Error(`${ph.where}: allowedDestinationTypes must include ${required}`);
  }
  for (const to of ['BR BRL', 'ZA ZAR']) {
    const r = byTo.get(to);
    if (!r) throw new Error(`corridor ${to} not found`);
    const types = csv(confirmed(r, 'allowedDestinationTypes'));
    if (types.length !== 1 || types[0] !== 'bank_account') {
      throw new Error(`${r.where}: must allow bank_account only, found ${types.join(', ')}`);
    }
  }
});

check('corridors.md: ZA excludes crypto for both kinds and has no crypto leg', () => {
  const za = corridorRows().find((r) => cell(r, 'to') === 'ZA ZAR');
  if (!za) throw new Error('US to ZA corridor row not found');
  const r = za;
  for (const kind of ['individual', 'company']) {
    if (boolean(confirmed(r, `cryptoLegAllowed.${kind}`), r.where)) {
      throw new Error(`${r.where}: cryptoLegAllowed.${kind} must be false`);
    }
  }
  const legsCell = cell(r, 'legsAvailable');
  if (legsCell.includes(SETTLEMENT_RAIL_ID)) throw new Error(`${r.where}: legsAvailable must not reference ${SETTLEMENT_RAIL_ID}`);
  const legs = parseLegs(legsCell, r);
  const settle = legs.get('settle');
  if (settle.tbd || settle.ids.length !== 0) {
    throw new Error(`${r.where}: ZA must have no settle leg; found ${settle.tbd ? TBD : settle.ids.join(', ')}`);
  }
  const payout = legs.get('payout');
  if (payout.tbd || !payout.ids.includes('sim_bank_za_eft')) {
    throw new Error(`${r.where}: ZA payout must include sim_bank_za_eft`);
  }
  const note = confirmed(r, 'regulationNote');
  if (!/3 Aug 2026/.test(note)) throw new Error(`${r.where}: regulationNote must name the 3 Aug 2026 draft rules`);
  if (!/rewritten/.test(note)) throw new Error(`${r.where}: regulationNote must say the rules are being rewritten`);
  if (!/not legal advice/i.test(note)) throw new Error(`${r.where}: regulationNote must state that this is not legal advice`);
  for (const kind of ['collect', 'convert']) {
    const entry = legs.get(kind);
    if (!entry.tbd) {
      throw new Error(`${r.where}: the ${kind} leg of the bank-only route is not specified by §8 (CC-1) and must stay TBD rather than assert a route shape`);
    }
    block(r, `legsAvailable.${kind}`, 'CC-1: §8 has no cross-border route without a settle leg; when the integrator answers, update this table and this check together');
  }
});

check('providers.md: every resolved provider/rail id used by a corridor is documented', () => {
  const documented = documentedProviders();
  for (const r of corridorRows()) {
    const legs = parseLegs(cell(r, 'legsAvailable'), r);
    for (const [kind, entry] of legs) {
      for (const id of entry.ids) {
        if (!documented.has(id)) throw new Error(`${r.where}: leg ${kind} uses undocumented id ${id}`);
      }
    }
  }
});

check('corridors.md: domesticRail is a documented id, or none for cross-border', () => {
  const documented = documentedProviders();
  for (const r of corridorRows()) {
    const rail = confirmed(r, 'domesticRail');
    const sameCountry = cell(r, 'from').split(' ')[0] === cell(r, 'to').split(' ')[0];
    if (rail === 'none') {
      if (sameCountry) throw new Error(`${r.where}: domesticRail is none but from and to are the same country`);
      continue;
    }
    if (!sameCountry) throw new Error(`${r.where}: domesticRail ${rail} set for a cross-border corridor`);
    if (!documented.has(rail)) throw new Error(`${r.where}: domesticRail ${rail} is not documented in providers.md`);
  }
});

check('corridors.md: each resolved id supports the leg kind it is used for', () => {
  const documented = documentedProviders();
  for (const r of corridorRows()) {
    const legs = parseLegs(cell(r, 'legsAvailable'), r);
    for (const [kind, entry] of legs) {
      if (entry.tbd) continue;
      for (const id of entry.ids) {
        const doc = documented.get(id);
        if (!doc) throw new Error(`${r.where}: undocumented id ${id}`);
        if (!doc.legKinds.includes(kind)) {
          throw new Error(`${r.where}: ${id} is used on a ${kind} leg but documents legKinds ${doc.legKinds.join(', ')}`);
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
  const section = text.corridors.slice(start, start + 1600);
  if (!/brazil/i.test(section)) throw new Error('the decision section must name Brazil as the baseline');
  if (!/mexico/i.test(section)) throw new Error('the decision section must name Mexico as the possible replacement');
  const br = corridorRows().find((r) => cell(r, 'to') === 'BR BRL');
  if (!br) throw new Error('US to BR corridor row not found');
  if (!/latin american demo country decision/i.test(confirmed(br, 'regulationNote'))) {
    throw new Error(`${br.where}: regulationNote must point at the single decision section`);
  }
});

/* providers.md ---------------------------------------------------------------- */

check('providers.md: exactly the six required simulated providers, no extras', () => {
  const ids = providerRows().map((r) => cell(r, 'id'));
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
  for (const r of rows) {
    if (!boolean(confirmed(r, 'simulated'), `${r.where} simulated`)) {
      throw new Error(`${r.where}: simulated must be true`);
    }
  }
});

check('providers.md: provider kinds, endpoint types and leg kinds are source-defined', () => {
  for (const r of providerRows()) {
    const kind = confirmed(r, 'kind');
    if (!PROVIDER_KINDS.includes(kind)) throw new Error(`${r.where}: kind ${kind} is not a §11.1 provider kind (no anchor in this task)`);
    for (const type of csv(confirmed(r, 'endpointTypes'))) {
      if (type !== 'none' && !ENDPOINT_TYPES.includes(type)) throw new Error(`${r.where}: ${type} is not a §6.3 endpoint type`);
    }
    for (const legKind of csv(confirmed(r, 'legKinds'))) {
      if (!LEG_KINDS.includes(legKind)) throw new Error(`${r.where}: ${legKind} is not a §6.6 leg kind`);
    }
    if (confirmed(r, 'countries') === 'none') throw new Error(`${r.where}: countries must be listed`);
    if (confirmed(r, 'currenciesOrAsset') === 'none') throw new Error(`${r.where}: currencies must be listed`);
  }
});

check('providers.md: fee columns are integer bps and feeFixed is money or TBD', () => {
  for (const r of providerRows()) {
    const fee = maybeMoney(r, 'feeFixed (placeholder)', 'Q6: the currency a conversion provider charges its fixed fee in is not stated by §11.1');
    if (fee !== null && fee.minor < 0n) throw new Error(`${r.where}: feeFixed must not be negative`);
    for (const column of ['feeBps (placeholder)', 'fxSpreadBps (placeholder)']) {
      const bps = integer(confirmed(r, column), `${r.where} ${column}`);
      if (bps > 10000n) throw new Error(`${r.where}: ${column} ${bps} exceeds 10000 bps (100 percent)`);
    }
  }
});

check('providers.md: the FX provider fee and limits stay unresolved (Q6)', () => {
  const fx = providerRows().filter((r) => cell(r, 'id') === 'sim_fx');
  if (fx.length !== 1) throw new Error(`expected exactly one sim_fx row, found ${fx.length}`);
  const r = fx[0];
  for (const column of ['feeFixed (placeholder)', 'min (placeholder)', 'max (placeholder)']) {
    if (!isTbd(cell(r, column))) {
      throw new Error(`${r.where} ${column}: §11.1 does not say which side a conversion provider's limit or fee applies to, so this must stay TBD (Q6)`);
    }
    block(r, column, 'Q6: the side and currency a conversion provider limit or fee applies to is not stated by §11.1; when the integrator answers, update this table and this check together');
  }
});

check('providers.md: estimated time is a positive integer number of seconds', () => {
  for (const r of providerRows()) {
    const seconds = integer(confirmed(r, 'estimatedTimeSeconds (placeholder)'), `${r.where} estimatedTimeSeconds`);
    if (seconds <= 0n) throw new Error(`${r.where}: estimatedTimeSeconds must be greater than zero`);
  }
});

check('providers.md: min and max are money or TBD, one currency, min less than max', () => {
  for (const r of providerRows()) {
    const min = maybeMoney(r, 'min (placeholder)', 'Q6: conversion provider limit side unresolved');
    const max = maybeMoney(r, 'max (placeholder)', 'Q6: conversion provider limit side unresolved');
    if (min === null || max === null) continue;
    if (min.currency !== max.currency) {
      throw new Error(`${r.where}: min currency ${min.currency} does not match max currency ${max.currency}`);
    }
    if (!(min.minor < max.minor)) throw new Error(`${r.where}: min ${min.minor} is not less than max ${max.minor}`);
  }
});

check('providers.md: the settlement rail is not simulated and is listed separately', () => {
  const tbl = table('settlement', 'providers.md settlement rail table');
  if (tbl.rows.length !== 1) throw new Error(`expected exactly one settlement rail row, found ${tbl.rows.length}`);
  const r = { row: tbl.rows[0], tbl, where: `providers.md:${tbl.line + 2}` };
  const id = confirmed(r, 'id');
  if (id !== SETTLEMENT_RAIL_ID) throw new Error(`${r.where}: id must be ${SETTLEMENT_RAIL_ID}, found ${id}`);
  if (confirmed(r, 'kind') !== 'settlement_rail') throw new Error(`${r.where}: kind must be settlement_rail`);
  if (confirmed(r, 'network') !== 'stellar') throw new Error(`${r.where}: network must be stellar`);
  if (boolean(confirmed(r, 'simulated'), `${r.where} simulated`)) {
    throw new Error(`${r.where}: the testnet settlement rail must not be marked simulated`);
  }
  const legs = csv(confirmed(r, 'legKinds'));
  if (!legs.includes('settle')) throw new Error(`${r.where}: legKinds must include settle`);
  if (tbl.header.includes('endpointTypes')) {
    throw new Error(`${r.where}: the settlement rail is not an endpoint provider and must not carry endpoint types`);
  }
  const providerIds = providerRows().map((p) => cell(p, 'id'));
  if (providerIds.includes(SETTLEMENT_RAIL_ID)) {
    throw new Error(`${r.where}: ${SETTLEMENT_RAIL_ID} must not be listed among the six simulated providers`);
  }
  if (!/NOT specified/i.test(confirmed(r, 'metadataStatus'))) {
    throw new Error(`${r.where}: metadataStatus must record the unspecified metadata gap instead of inventing values`);
  }
});

check('providers.md: simulated providers use the sim_ id namespace, the rail does not', () => {
  for (const r of providerRows()) {
    const id = cell(r, 'id');
    if (!id.startsWith('sim_')) throw new Error(`${r.where}: a simulated provider id must start with sim_, found ${id}`);
  }
  const settlement = table('settlement', 'providers.md settlement rail table');
  const railId = cell({ row: settlement.rows[0], tbl: settlement, where: 'providers.md settlement rail' }, 'id');
  if (railId.startsWith('sim_')) throw new Error('the settlement rail must not sit in the simulated provider namespace');
});

/* fees.md --------------------------------------------------------------------- */

check('fees.md: fee table has exactly the six §6.5 profiles', () => {
  const tbl = table('fees', 'fees.md fee table');
  const profiles = tbl.rows.map((row, index) => cell({ row, tbl, where: `fees.md:${tbl.line + 2 + index}` }, 'profile'));
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
  for (const [index, row] of tbl.rows.entries()) {
    const r = { row, tbl, where: `fees.md:${tbl.line + 2 + index}` };
    const profile = cell(r, 'profile');
    const bps = integer(confirmed(r, 'flexipayFeeBps (placeholder)'), `${r.where} flexipayFeeBps`);
    const expected = profile === 'tips' ? 0n : 100n;
    if (bps !== expected) throw new Error(`${r.where}: profile ${profile} must be ${expected} bps, found ${bps}`);
    const shown = confirmed(r, 'percentLabel');
    const expectedLabel = profile === 'tips' ? '0.0 percent' : '1.0 percent';
    if (shown !== expectedLabel) throw new Error(`${r.where}: percentLabel must be "${expectedLabel}", found "${shown}"`);
    if (!confirmed(r, 'source').trim()) throw new Error(`${r.where}: source must cite where the value comes from`);
  }
});

check('fees.md: every fee row is a labelled placeholder and simulated', () => {
  const tbl = table('fees', 'fees.md fee table');
  for (const [index, row] of tbl.rows.entries()) {
    const r = { row, tbl, where: `fees.md:${tbl.line + 2 + index}` };
    if (confirmed(r, 'placeholder') !== 'true') throw new Error(`${r.where}: placeholder must be true`);
    if (confirmed(r, 'simulated') !== 'true') throw new Error(`${r.where}: simulated must be true`);
  }
});

check('fees.md: quote validity is the 120 second placeholder', () => {
  if (!/quoteValiditySeconds/.test(text.fees)) throw new Error('quoteValiditySeconds is not documented');
  if (!/120\s*\(placeholder\)/.test(text.fees)) throw new Error('the 120 second default is not labelled as a placeholder');
});

check('fees.md: the money example is exact integer arithmetic (BigInt)', () => {
  const tbl = table('example', 'fees.md money example table');
  const byKey = new Map();
  for (const [index, row] of tbl.rows.entries()) {
    const r = { row, tbl, where: `fees.md:${tbl.line + 2 + index}` };
    const key = cell(r, 'key');
    if (byKey.has(key)) throw new Error(`${r.where}: duplicate key ${key}`);
    byKey.set(key, r);
  }
  for (const key of ['exampleSendAmount', 'exampleFlexiPayFeeBps', 'exampleFlexiPayFee']) {
    if (!byKey.has(key)) throw new Error(`money example is missing ${key}`);
  }
  const amount = money(confirmed(byKey.get('exampleSendAmount'), 'value'), 'fees.md example amount');
  const bps = integer(confirmed(byKey.get('exampleFlexiPayFeeBps'), 'value'), 'fees.md example bps');
  const fee = money(confirmed(byKey.get('exampleFlexiPayFee'), 'value'), 'fees.md example fee');
  if (amount.currency !== fee.currency) throw new Error('the example amount and fee currencies differ');
  if ((amount.minor * bps) % 10000n !== 0n) {
    throw new Error('the example fee is not exact in integer minor units; do not rely on a rounding rule that is not defined');
  }
  const expectedFee = (amount.minor * bps) / 10000n;
  if (fee.minor !== expectedFee) {
    throw new Error(`the example fee is ${fee.minor} but ${amount.minor} x ${bps} bps = ${expectedFee} minor units`);
  }
});

check('fees.md: no receive-side figure is published while the fee side is unresolved', () => {
  const tbl = table('example', 'fees.md money example table');
  const index = tbl.rows.findIndex((candidate) => candidate[tbl.header.indexOf('key')] === 'exampleExpectedReceiveIndicator');
  if (index < 0) throw new Error('the example table must state what it does not publish (exampleExpectedReceiveIndicator)');
  const r = { row: tbl.rows[index], tbl, where: `fees.md:${tbl.line + 2 + index}` };
  if (!isTbd(cell(r, 'value'))) {
    throw new Error(`${r.where}: the side the fee is charged on is not stated (Q9), so no receive amount may be published`);
  }
  block(r, 'value', 'Q9: the side the FlexiPay fee is charged on is not stated; when the integrator answers, update this table and this check together');
});

/* cross-cutting --------------------------------------------------------------- */

check('all drafts: every table row has one cell per header column', () => {
  for (const [sourceKey, tables] of Object.entries(parsed)) {
    for (const tbl of tables) {
      for (const [index, row] of tbl.rows.entries()) {
        if (row.length !== tbl.header.length) {
          throw new Error(`${sourceKey}.md:${tbl.line + 2 + index}: ${row.length} cells but the header has ${tbl.header.length}`);
        }
      }
    }
  }
});

check('all drafts: money columns are quoted integer minor units or TBD', () => {
  const moneyColumns = new Set(['feeFixed (placeholder)', 'min (placeholder)', 'max (placeholder)', ...LIMIT_COLUMNS, 'value']);
  for (const [sourceKey, tables] of Object.entries(parsed)) {
    for (const tbl of tables) {
      for (const [index, row] of tbl.rows.entries()) {
        for (const column of tbl.header) {
          if (!moneyColumns.has(column)) continue;
          const value = (row[tbl.header.indexOf(column)] || '').trim();
          if (!value || isTbd(value)) continue;
          if (/^".*"$/.test(value) || /[A-Z]{3}$/.test(value)) {
            money(value, `${sourceKey}.md:${tbl.line + 2 + index} ${column}`);
          }
        }
      }
    }
  }
});

check('all drafts: TBD appears only in columns documented as unresolved', () => {
  for (const [sourceKey, tables] of Object.entries(parsed)) {
    for (const tbl of tables) {
      for (const [index, row] of tbl.rows.entries()) {
        for (const column of tbl.header) {
          const value = (row[tbl.header.indexOf(column)] || '').trim();
          if (!isTbd(value)) continue;
          if (!TBD_ALLOWED_COLUMNS.has(column)) {
            throw new Error(`${sourceKey}.md:${tbl.line + 2 + index} ${column}: TBD is not allowed in this column; the value is fixed by the sources`);
          }
        }
      }
    }
  }
});

check('all drafts: no numeric value is stored as a decimal (no floats)', () => {
  for (const [sourceKey, tables] of Object.entries(parsed)) {
    for (const tbl of tables) {
      for (const [index, row] of tbl.rows.entries()) {
        for (const column of tbl.header) {
          const value = (row[tbl.header.indexOf(column)] || '').trim();
          if (column === 'percentLabel') continue;
          if (!/^-?\d+\.\d+$/.test(value)) continue;
          throw new Error(`${sourceKey}.md:${tbl.line + 2 + index}: ${JSON.stringify(value)} in column ${column} is stored as a decimal; use integer minor units or integer bps`);
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

/* Every unresolved cell must be reported, and every reported blocker must exist.
   Without this, a TBD could slip past a check silently and look like a pass. */
check('all drafts: every TBD cell is reported as a blocker, and no blocker is stale', () => {
  const found = new Map();

  for (const [sourceKey, tables] of Object.entries(parsed)) {
    for (const tbl of tables) {
      for (const [index, row] of tbl.rows.entries()) {
        const where = `${sourceKey}.md:${tbl.line + 2 + index}`;
        for (const column of tbl.header) {
          const value = (row[tbl.header.indexOf(column)] || '').trim();
          if (isTbd(value)) found.set(blockerKey(where, column), { where, column });
        }
      }
    }
  }

  for (const r of corridorRows()) {
    const legs = parseLegs(cell(r, 'legsAvailable'), r);
    for (const [kind, entry] of legs) {
      if (entry.tbd) found.set(blockerKey(r.where, `legsAvailable.${kind}`), { where: r.where, column: `legsAvailable.${kind}` });
    }
  }

  for (const [key, entry] of found) {
    if (!blockers.has(key)) {
      throw new Error(`${entry.where} ${entry.column} is TBD but no check reports it; unresolved values must never pass silently`);
    }
  }
  for (const [key, entry] of blockers) {
    if (!found.has(key)) {
      throw new Error(`${entry.where} ${entry.column} is reported as a blocker but is no longer TBD`);
    }
  }
  if (found.size === 0) throw new Error('no unresolved cells were found; if the answers are all recorded, remove the TBD handling instead of leaving it unused');
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

const ordered = [...blockers.values()].sort((a, b) => (a.where + a.column).localeCompare(b.where + b.column));

console.log('');
console.log(`BLOCKERS — ${ordered.length} unresolved cells (${TBD}). These are NOT approved configuration:`);
for (const entry of ordered) {
  console.log(`  ${entry.where} ${entry.column}`);
  console.log(`     ${entry.reason}`);
}

console.log('');
console.log(`${results.length - failed}/${results.length} checks passed; ${ordered.length} cells unresolved (reported above, not validated as policy).`);
console.log('Scope: draft content only — this script does not validate the future CC0 configuration schema.');

if (failed > 0) {
  console.error(`FAILED: ${failed} check(s) did not pass.`);
  process.exit(1);
}

console.log(`PASS — drafted content is internally consistent. The ${ordered.length} TBD cells above are unresolved and are NOT approved configuration.`);
