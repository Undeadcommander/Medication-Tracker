// Automatic medication recognition using free, keyless public APIs:
//   - NLM Clinical Tables RxTerms (autocomplete + strengths)
//   - NLM RxNav (spelling suggestions, normalisation, ingredients/brands)
//   - NLM RxClass (drug classes)
//   - openFDA drug labels (indications, dosing, warnings, ...)
// Everything here is best-effort: unknown medications must always remain usable.
import type { DrugInfo } from '../../shared/types';

export interface DrugStrength {
  label: string;
  rxcui: string;
}

export interface DrugSuggestion {
  name: string;
  strengths: DrugStrength[];
  /** Additive: route hint from RxTerms, e.g. "Oral Pill", "Oral Liquid". Display only. */
  route?: string;
}

const RXTERMS_URL = 'https://clinicaltables.nlm.nih.gov/api/rxterms/v3/search';
const RXNAV = 'https://rxnav.nlm.nih.gov/REST';
const OPENFDA_URL = 'https://api.fda.gov/drug/label.json';

const FETCH_TIMEOUT_MS = 8000;
const INFO_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INFO_KEY_PREFIX = 'medtracker.druginfo.';
const INFO_MAX_ENTRIES = 60;
const SEARCH_CACHE_MAX = 100;
const SECTION_MAX_CHARS = 1500;
const PURPOSE_MAX_CHARS = 200;

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError';
}

class HttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/** Fetches JSON with a timeout combined with the caller's signal. Caller abort => AbortError. */
async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new HttpError(res.status);
    return await res.json();
  } catch (e) {
    if (signal?.aborted) throw abortError();
    if (timedOut) throw new Error('Request timed out');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Like fetchJson but returns null on HTTP 404 (openFDA's "no matches"). */
async function fetchJsonOrNull(url: string, signal?: AbortSignal): Promise<unknown | null> {
  try {
    return await fetchJson(url, signal);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers / mappers (exported for tests)
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** "Lisinopril (Oral Pill)" -> { name: "Lisinopril", route: "Oral Pill" } */
export function splitRxTermsName(display: string): { name: string; route?: string } {
  const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(display.trim());
  if (m && m[1]) return { name: m[1].trim(), route: m[2].trim() || undefined };
  return { name: display.trim() };
}

/** Maps the RxTerms response `[total, names[], {STRENGTHS_AND_FORMS, RXCUIS}, display[]]`. */
export function mapRxTermsResponse(json: unknown): DrugSuggestion[] {
  if (!Array.isArray(json)) return [];
  // Arrays are parallel, so pair by raw index: filtering out odd entries first would misalign them.
  const names: unknown[] = Array.isArray(json[1]) ? json[1] : [];
  const extra = asRecord(json[2]);
  const forms = Array.isArray(extra?.STRENGTHS_AND_FORMS) ? (extra.STRENGTHS_AND_FORMS as unknown[]) : [];
  const rxcuis = Array.isArray(extra?.RXCUIS) ? (extra.RXCUIS as unknown[]) : [];
  const out: DrugSuggestion[] = [];
  names.forEach((display, i) => {
    if (typeof display !== 'string') return;
    const labels: unknown[] = Array.isArray(forms[i]) ? (forms[i] as unknown[]) : [];
    const ids: unknown[] = Array.isArray(rxcuis[i]) ? (rxcuis[i] as unknown[]) : [];
    const seen = new Set<string>();
    const strengths: DrugStrength[] = [];
    labels.forEach((raw, j) => {
      const rxcui = ids[j];
      if (typeof raw !== 'string' || typeof rxcui !== 'string') return;
      const label = raw.trim().replace(/\s+/g, ' ');
      if (!label || !rxcui || seen.has(rxcui)) return;
      seen.add(rxcui);
      strengths.push({ label, rxcui });
    });
    const { name, route } = splitRxTermsName(display);
    if (name) out.push({ name, strengths, ...(route ? { route } : {}) });
  });
  return out;
}

/** RxNav spellingsuggestions.json -> suggestion strings. */
export function mapSpellingResponse(json: unknown): string[] {
  const list = asRecord(asRecord(asRecord(json)?.suggestionGroup)?.suggestionList);
  return asStringArray(list?.suggestion);
}

/** RxNav rxcui.json -> first rxcui, if any. */
export function mapRxcuiResponse(json: unknown): string | undefined {
  const ids = asStringArray(asRecord(asRecord(json)?.idGroup)?.rxnormId);
  return ids[0];
}

export interface RelatedConcepts {
  ingredients: { rxcui: string; name: string }[];
  brands: string[];
}

/** RxNav related.json (tty=IN+BN) -> ingredients and brand names. */
export function mapRelatedResponse(json: unknown): RelatedConcepts {
  const groups = asRecord(asRecord(json)?.relatedGroup)?.conceptGroup;
  const out: RelatedConcepts = { ingredients: [], brands: [] };
  if (!Array.isArray(groups)) return out;
  for (const g of groups) {
    const rec = asRecord(g);
    const props = rec && Array.isArray(rec.conceptProperties) ? rec.conceptProperties : [];
    for (const p of props) {
      const c = asRecord(p);
      if (!c || typeof c.name !== 'string') continue;
      if (rec?.tty === 'IN' && typeof c.rxcui === 'string') out.ingredients.push({ rxcui: c.rxcui, name: c.name });
      else if (rec?.tty === 'BN') out.brands.push(c.name);
    }
  }
  out.brands = dedupeCI(out.brands);
  return out;
}

function dedupeCI(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const k = it.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it.trim());
  }
  return out;
}

/** RxClass byRxcui.json -> class names of the given type(s), de-duplicated. */
export function mapRxClassResponse(json: unknown, classTypes: string[]): string[] {
  const list = asRecord(json)?.rxclassDrugInfoList;
  const infos = asRecord(list)?.rxclassDrugInfo;
  if (!Array.isArray(infos)) return [];
  const names: string[] = [];
  for (const info of infos) {
    const item = asRecord(asRecord(info)?.rxclassMinConceptItem);
    if (!item || typeof item.className !== 'string') continue;
    if (typeof item.classType === 'string' && classTypes.includes(item.classType)) names.push(item.className);
  }
  return dedupeCI(names);
}

const HEADING_RE =
  /^\s*(?:\d+(?:\.\d+)*\s+)?(?:INDICATIONS?\s*(?:AND|&)\s*USAGE|INDICATIONS|DOSAGE\s*(?:AND|&)\s*ADMINISTRATION|WARNINGS?\s*(?:AND|&)\s*(?:PRECAUTIONS|CAUTIONS)|WARNINGS?|ADVERSE\s+REACTIONS|DRUG\s+INTERACTIONS|PURPOSES?|USES?)\b\s*:?\s*/i;

/** Joins label paragraphs, drops a leading section heading, cross-refs like "(1.1)" and extra whitespace. */
export function cleanLabelText(parts: unknown, stripHeading = true): string {
  const text = asStringArray(parts)
    .join(' ')
    .replace(/\s*\(\s*(?:\d+\.?)+(?:\s*[,;]\s*(?:\d+\.?)+)*\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripHeading ? text.replace(HEADING_RE, '').trim() : text;
}

/** Truncates at a sentence boundary (or word boundary) with an ellipsis. */
export function truncateAtSentence(text: string, max = SECTION_MAX_CHARS): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  let cut = -1;
  const re = /[.!?](?=\s)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice))) cut = m.index + 1;
  if (cut < max * 0.4) {
    const sp = slice.lastIndexOf(' ');
    cut = sp > max * 0.4 ? sp : max;
    return slice.slice(0, cut).replace(/[\s,;:]+$/, '') + '…';
  }
  return slice.slice(0, cut) + ' …';
}

/** First sentence of a block of text, <= 200 chars. */
export function firstSentence(text: string, max = PURPOSE_MAX_CHARS): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const m = /^(.+?[.!?])(?=\s|$)/.exec(t);
  let s = m ? m[1] : t;
  if (s.length > max) {
    const slice = s.slice(0, max - 1);
    const sp = slice.lastIndexOf(' ');
    s = (sp > max * 0.5 ? slice.slice(0, sp) : slice).replace(/[\s,;:]+$/, '') + '…';
  }
  return s;
}

type LabelFields = Pick<
  DrugInfo,
  | 'purpose'
  | 'indications'
  | 'dosageAndAdministration'
  | 'warnings'
  | 'boxedWarning'
  | 'sideEffects'
  | 'interactions'
> & { genericName?: string; brandNames: string[] };

function section(rec: Record<string, unknown>, keys: string[], stripHeading = true): string | undefined {
  for (const k of keys) {
    const text = cleanLabelText(rec[k], stripHeading);
    if (text) return truncateAtSentence(text);
  }
  return undefined;
}

/** openFDA label.json -> DrugInfo label fields. Returns null when there are no results. */
export function mapOpenFdaLabel(json: unknown): LabelFields | null {
  const results = asRecord(json)?.results;
  const label = Array.isArray(results) ? asRecord(results[0]) : null;
  if (!label) return null;
  const openfda = asRecord(label.openfda);
  const purposeText = cleanLabelText(label.purpose);
  const indications = section(label, ['indications_and_usage']);
  const indicationsFull = cleanLabelText(label.indications_and_usage);
  const out: LabelFields = {
    purpose: firstSentence(purposeText || indicationsFull),
    indications: indications ?? (purposeText ? truncateAtSentence(purposeText) : undefined),
    dosageAndAdministration: section(label, ['dosage_and_administration']),
    warnings: section(label, ['warnings_and_cautions', 'warnings']),
    boxedWarning: section(label, ['boxed_warning'], false),
    sideEffects: section(label, ['adverse_reactions']),
    interactions: section(label, ['drug_interactions']),
    genericName: asStringArray(openfda?.generic_name)[0],
    brandNames: asStringArray(openfda?.brand_name),
  };
  return out;
}

// --- strength label parsing -------------------------------------------------

const UNITS = new Set([
  'mg', 'mcg', 'ug', 'g', 'kg', 'ml', 'l', 'unt', 'unit', 'units', 'meq', 'iu', 'mmol', 'mci', 'mcl',
  'var', 'cm', 'mm', 'hr', 'actuat', 'puff', 'spray', 'drop', 'drops', 'mol', 'ng', 'ci',
]);

const BASE_FORMS: [RegExp, string][] = [
  [/\b(?:tab|tabs|tablet)\b/i, 'tablet'],
  [/\b(?:cap|caps|capsule)\b/i, 'capsule'],
  [/\b(?:susp|suspension)\b/i, 'suspension'],
  [/\b(?:soln|sol|solution)\b/i, 'solution'],
  [/\b(?:pen injector|inj|injection|injectable|prefilled syringe|syringe|cartridge|vial)\b/i, 'injection'],
  [/\b(?:crm|cream)\b/i, 'cream'],
  [/\b(?:oint|ointment)\b/i, 'ointment'],
  [/\bpatch\b/i, 'patch'],
  [/\blozenge\b/i, 'lozenge'],
  [/\bsuppository\b/i, 'suppository'],
  [/\b(?:nasal )?spray\b/i, 'spray'],
  [/\b(?:mdi|dpi|inhaler|inhalant)\b/i, 'inhaler'],
  [/\bgel\b/i, 'gel'],
  [/\blotion\b/i, 'lotion'],
  [/\bfoam\b/i, 'foam'],
  [/\benema\b/i, 'enema'],
  [/\b(?:pwdr|powder)\b/i, 'powder'],
  [/\bgranules\b/i, 'granules'],
  [/\bpack\b/i, 'pack'],
  [/\bfilm\b/i, 'film'],
  [/\belixir\b/i, 'elixir'],
  [/\bsyrup\b/i, 'syrup'],
  [/\bdrops?\b/i, 'drops'],
];

function numberUnitPrefix(label: string): { dosage: string; rest: string } | null {
  const m = /^\s*(\d[\d.,]*(?:\s*-\s*\d[\d.,]*)*)\s*(%)?/.exec(label);
  if (!m) return null;
  let end = m[0].length;
  let dosage = m[1].replace(/\s+/g, '');
  if (m[2]) {
    dosage += '%';
  } else {
    // Optional unit: "mg", "mg/5mL", "mcg/puff", "unt/ml". Must be a known unit so "10 Tab" works.
    const u = /^\s*([A-Za-z]+)(\/\s*(?:\d[\d.,]*\s*)?[A-Za-z]+)?/.exec(label.slice(end));
    if (u && UNITS.has(u[1].toLowerCase())) {
      const denom = u[2] ? u[2].replace(/\s+/g, '') : '';
      dosage += ' ' + u[1] + denom;
      end += u[0].length;
    }
  }
  dosage = dosage.replace(/\/(\d*)ml\b/i, '/$1mL').replace(/ ml\b/i, ' mL');
  return { dosage, rest: label.slice(end).trim() };
}

/**
 * Parses an RxTerms strength+form label such as "10 mg Tab" or "500 mg/5mL Susp"
 * into a dosage and a human-friendly dosage form.
 */
export function parseStrengthLabel(label: string): { dosage: string; form?: string } {
  const text = label.trim().replace(/\s+/g, ' ');
  const parsed = numberUnitPrefix(text);
  const dosage = parsed?.dosage ?? text;
  const rest = parsed ? parsed.rest : '';
  if (!parsed) return { dosage };

  let base: string | undefined;
  for (const [re, name] of BASE_FORMS) {
    if (re.test(rest)) {
      base = name;
      break;
    }
  }
  if (!base) return { dosage };

  let prefix = '';
  if (/\b(?:ER|XR|XL|SR|CR|LA|CD|ZR|PR|Extended)\b/i.test(rest)) prefix = 'extended-release ';
  else if (/\b(?:DR|EC|Delayed)\b/i.test(rest)) prefix = 'delayed-release ';
  else if (/\b(?:ODT|Disintegrating)\b/i.test(rest)) prefix = 'orally disintegrating ';
  else if (/\b(?:Chew|Chewable)\b/i.test(rest)) prefix = 'chewable ';
  else if (/\bSL\b|\bSublingual\b/i.test(rest)) prefix = 'sublingual ';
  else if (/\bPen\b/i.test(rest) && base === 'injection') prefix = 'pen ';

  const form = (prefix + base).replace(/^./, (c) => c.toUpperCase());
  return { dosage, form };
}

// ---------------------------------------------------------------------------
// Search (autocomplete) + spelling
// ---------------------------------------------------------------------------

const searchCache = new Map<string, DrugSuggestion[]>();

function rememberSearch(key: string, value: DrugSuggestion[]) {
  searchCache.delete(key);
  searchCache.set(key, value);
  while (searchCache.size > SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest === undefined) break;
    searchCache.delete(oldest);
  }
}

export async function searchDrugs(query: string, signal?: AbortSignal): Promise<DrugSuggestion[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const key = q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit) return hit;
  const url = `${RXTERMS_URL}?terms=${encodeURIComponent(q)}&ef=STRENGTHS_AND_FORMS,RXCUIS&maxList=10`;
  const result = mapRxTermsResponse(await fetchJson(url, signal));
  rememberSearch(key, result);
  return result;
}

export async function suggestSpellings(query: string, signal?: AbortSignal): Promise<string[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const json = await fetchJson(`${RXNAV}/spellingsuggestions.json?name=${encodeURIComponent(q)}`, signal);
  return mapSpellingResponse(json)
    .filter((s) => s.toLowerCase() !== q.toLowerCase())
    .slice(0, 4);
}

// ---------------------------------------------------------------------------
// Drug info (RxNav + RxClass + openFDA), cached in localStorage
// ---------------------------------------------------------------------------

/** A picked strength (rxcui) gets its own cache entry: its label can differ from the name-only lookup. */
function infoKey(name: string, rxcui?: string): string {
  return INFO_KEY_PREFIX + name.trim().toLowerCase().replace(/\s+/g, ' ') + (rxcui ? `#${rxcui}` : '');
}

function readCachedInfo(key: string): DrugInfo | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { t?: number; v?: DrugInfo };
    if (!parsed || typeof parsed.t !== 'number' || !parsed.v) return null;
    if (Date.now() - parsed.t > INFO_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed.v;
  } catch {
    return null;
  }
}

function writeCachedInfo(key: string, info: DrugInfo) {
  try {
    // Cap cache size: evict expired, then oldest entries.
    const entries: { k: string; t: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(INFO_KEY_PREFIX) || k === key) continue;
      let t = 0;
      try {
        t = (JSON.parse(localStorage.getItem(k) ?? '{}') as { t?: number }).t ?? 0;
      } catch {
        /* corrupt entry: treat as oldest */
      }
      entries.push({ k, t });
    }
    entries.sort((a, b) => a.t - b.t);
    const now = Date.now();
    const keep = entries.filter((e) => now - e.t <= INFO_TTL_MS);
    for (const e of entries) if (!keep.includes(e)) localStorage.removeItem(e.k);
    while (keep.length >= INFO_MAX_ENTRIES) {
      const old = keep.shift();
      if (old) localStorage.removeItem(old.k);
    }
    localStorage.setItem(key, JSON.stringify({ t: now, v: info }));
  } catch {
    /* storage unavailable or full: skip caching */
  }
}

/** Removes a trailing RxTerms route suffix, e.g. "Lisinopril (Oral Pill)". */
function cleanName(name: string): string {
  return splitRxTermsName(name).name;
}

function sourceLinks(generic: string, rxcui?: string): DrugInfo['sources'] {
  const q = encodeURIComponent(generic);
  const sources: DrugInfo['sources'] = [
    { label: 'MedlinePlus', url: `https://medlineplus.gov/search/?query=${q}` },
    { label: 'DailyMed', url: `https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=${q}` },
  ];
  if (rxcui) {
    sources.push({
      label: 'RxNav',
      url: `https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=${encodeURIComponent(rxcui)}`,
    });
  }
  return sources;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Runs a source lookup; swallows failures (recording them) but always rethrows caller aborts. */
async function guarded<T>(
  signal: AbortSignal | undefined,
  failures: { count: number },
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (isAbortError(e) || signal?.aborted) throw abortError();
    failures.count++;
    return undefined;
  }
}

async function lookupClasses(ingredientRxcui: string, signal?: AbortSignal): Promise<string[]> {
  // Established Pharmacologic Class (FDA SPL) – small response.
  const epc = mapRxClassResponse(
    await fetchJson(
      `${RXNAV}/rxclass/class/byRxcui.json?rxcui=${encodeURIComponent(ingredientRxcui)}&relaSources=DAILYMED&relas=has_epc`,
      signal,
    ),
    ['EPC'],
  );
  if (epc.length) return epc;
  // Fall back to ATC classes (response is larger and unfiltered by the server).
  const all = await fetchJson(
    `${RXNAV}/rxclass/class/byRxcui.json?rxcui=${encodeURIComponent(ingredientRxcui)}&relaSources=ATC`,
    signal,
  );
  const atc = mapRxClassResponse(all, ['ATC1-4']);
  if (atc.length) return atc;
  return mapRxClassResponse(all, ['VA']);
}

async function lookupLabel(
  names: { generic?: string; brand?: string; rxcui?: string },
  signal?: AbortSignal,
): Promise<LabelFields | null> {
  const attempts: string[] = [];
  const quote = (s: string) => encodeURIComponent(`"${s.replace(/"/g, '')}"`);
  if (names.rxcui) attempts.push(`openfda.rxcui:${quote(names.rxcui)}`);
  if (names.generic) {
    attempts.push(`openfda.generic_name.exact:${quote(names.generic.toUpperCase())}`);
    attempts.push(`openfda.generic_name:${quote(names.generic)}`);
  }
  if (names.brand) attempts.push(`openfda.brand_name:${quote(names.brand)}`);
  for (const search of attempts) {
    const json = await fetchJsonOrNull(`${OPENFDA_URL}?search=${search}&limit=1`, signal);
    const mapped = json ? mapOpenFdaLabel(json) : null;
    if (mapped) return mapped;
  }
  return null;
}

export async function fetchDrugInfo(name: string, rxcui?: string, signal?: AbortSignal): Promise<DrugInfo> {
  if (signal?.aborted) throw abortError();
  const searchName = cleanName(name);
  const key = infoKey(searchName, rxcui);
  const cached = readCachedInfo(key);
  if (cached) return cached;

  const failures = { count: 0 };

  // 1. Normalise to an RxCUI, then find ingredients and brand names.
  let resolvedRxcui = rxcui;
  if (!resolvedRxcui) {
    resolvedRxcui = await guarded(signal, failures, async () =>
      mapRxcuiResponse(
        await fetchJson(`${RXNAV}/rxcui.json?name=${encodeURIComponent(searchName)}&search=2`, signal),
      ),
    );
  }
  let related: RelatedConcepts = { ingredients: [], brands: [] };
  if (resolvedRxcui) {
    const id = resolvedRxcui;
    related =
      (await guarded(signal, failures, async () =>
        mapRelatedResponse(await fetchJson(`${RXNAV}/rxcui/${encodeURIComponent(id)}/related.json?tty=IN+BN`, signal)),
      )) ?? related;
  }

  // 2. Classes (per ingredient, max 3) and label text, in parallel.
  const ingredients = related.ingredients.slice(0, 3);
  const genericFromRxnorm = ingredients.map((i) => i.name).join(' / ') || undefined;
  const [classLists, label] = await Promise.all([
    Promise.all(
      ingredients.map((ing) => guarded(signal, failures, () => lookupClasses(ing.rxcui, signal))),
    ),
    guarded(signal, failures, () =>
      lookupLabel(
        { generic: ingredients.length === 1 ? ingredients[0].name : undefined, brand: searchName, rxcui }, // openFDA indexes product-level RxCUIs (a picked strength), not ingredient ones
        signal,
      ),
    ),
  ]);

  const drugClasses = dedupeCI(classLists.flatMap((l) => l ?? [])).slice(0, 4);
  const genericName = genericFromRxnorm ?? (label?.genericName ? titleCase(label.genericName) : undefined);
  const brandNames = related.brands.length
    ? related.brands.slice(0, 8)
    : dedupeCI(label?.brandNames ?? []).slice(0, 4);

  const info: DrugInfo = {
    rxcui: resolvedRxcui,
    genericName,
    brandNames,
    drugClasses,
    purpose: label?.purpose,
    indications: label?.indications,
    dosageAndAdministration: label?.dosageAndAdministration,
    warnings: label?.warnings,
    boxedWarning: label?.boxedWarning,
    sideEffects: label?.sideEffects,
    interactions: label?.interactions,
    sources: sourceLinks(genericName ?? searchName, resolvedRxcui),
    fetchedAt: new Date().toISOString(),
  };
  // Only cache complete lookups so a transient network failure isn't remembered for 30 days.
  if (failures.count === 0) writeCachedInfo(key, info);
  return info;
}
