#!/usr/bin/env node
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MERCHANT_SOURCES, classifyMerchantUrl, parseMerchantPage } from './merchant-adapters.mjs';
import { fetchRobots, fetchWithPolicy, USER_AGENT } from './net.mjs';
import { robotsCrawlDelayMs } from './robots.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_OUT = join(ROOT, 'data', 'pet-sources', 'merchant-full');
const BLOCK_CODES = new Set(['HTTP_BLOCKED', 'CHALLENGE', 'ROBOTS_UNAVAILABLE', 'ROBOTS_DENIED']);
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const keyOf = (task) => {
  if (task.site !== 'bagong') return task.site + '\t' + task.url;
  const url = new URL(task.url);
  if (/^\/s\d+\/?$/.test(url.pathname) && !url.search) url.pathname = url.pathname.replace(/\/?$/, '/');
  return task.site + '\t' + url.href;
};
const observationKey = (row) => {
  const content = { ...row };
  delete content.fetched_at;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
};
const fileAt = (out, name) => join(out, name);
const blocksSite = (event) => event.status === 'blocked' && event.code !== 'ROBOTS_DENIED';

function readJsonl(path, { repair = false } = {}) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  if (!raw) return [];
  let complete = raw;
  if (!raw.endsWith('\n')) {
    const cut = raw.lastIndexOf('\n') + 1;
    const tail = raw.slice(cut);
    try {
      JSON.parse(tail);
      complete += '\n';
      if (repair) appendFileSync(path, '\n', 'utf8');
    } catch {
      console.warn('Incomplete trailing JSONL entry in ' + path + '; ignoring it' + (repair ? ' and saving a recovery copy' : ' for this read'));
      complete = raw.slice(0, cut);
      if (repair) {
        writeFileSync(path + '.recovered-tail-' + Date.now(), tail, 'utf8');
        truncateSync(path, Buffer.byteLength(complete, 'utf8'));
      }
    }
  }
  if (!complete.trim()) return [];
  return complete.trimEnd().split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (cause) { throw new Error('Invalid JSONL line ' + (index + 1) + ' in ' + path + ': ' + cause.message); }
  });
}

function appendJsonl(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(value) + '\n', 'utf8');
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function acquireLock(out) {
  mkdirSync(out, { recursive: true });
  const path = fileAt(out, 'sync.lock');
  if (existsSync(path)) {
    let owner;
    try { owner = JSON.parse(readFileSync(path, 'utf8')); }
    catch { throw new Error('Invalid sync lock; inspect before retrying: ' + path); }
    if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error('Invalid sync lock PID: ' + path);
    if (processIsAlive(owner.pid)) throw new Error('Merchant sync already running with PID ' + owner.pid);
    renameSync(path, path + '.stale-' + Date.now());
  }
  const fd = openSync(path, 'wx');
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: now() }) + '\n', 'utf8'); }
  finally { closeSync(fd); }
  return () => {
    if (!existsSync(path)) return;
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    if (owner.pid === process.pid) unlinkSync(path);
  };
}

function canonicalTask(site, rawUrl, sources) {
  const source = sources[site];
  if (!source) throw new Error('Unknown merchant site: ' + site);
  let url;
  try { url = new URL(rawUrl, source); } catch { return null; }
  if (url.origin !== new URL(source).origin) return null;
  url.hash = '';
  let kind = classifyMerchantUrl(site, url.href);
  if (kind === 'detail' && (site === 'achong' || site === 'apwol')) url.pathname = url.pathname.replace(/\/+$/, '');
  if (kind === 'detail' && site === 'bagong' && /^\/s\d+\/?$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/?$/, '/');
  if (kind === 'detail' && site === 'bagong' && /\/service\/$/.test(url.pathname)) url.pathname = url.pathname.slice(0, -1);
  kind = classifyMerchantUrl(site, url.href);
  return kind ? { site, url: url.href, kind } : null;
}

function loadRun(out, { repair = false } = {}) {
  const queue = new Map();
  for (const task of readJsonl(fileAt(out, 'queue.jsonl'), { repair })) queue.set(keyOf(task), task);
  const pages = new Map();
  for (const event of readJsonl(fileAt(out, 'pages.jsonl'), { repair })) pages.set(keyOf(event), event);
  const blockedSites = new Set([...pages.values()].filter(blocksSite).map((event) => event.site));
  const fingerprints = new Map();
  for (const event of pages.values()) {
    if (event.status !== 'done' || !event.fingerprint) continue;
    if (!fingerprints.has(event.site)) fingerprints.set(event.site, new Set());
    fingerprints.get(event.site).add(event.fingerprint);
  }
  return { queue, pages, blockedSites, fingerprints };
}

function enqueue(run, out, site, rawUrl, sources, expectedKind = null) {
  const task = canonicalTask(site, rawUrl, sources);
  if (!task || (expectedKind && task.kind !== expectedKind)) return false;
  const key = keyOf(task);
  if (run.queue.has(key)) return false;
  run.queue.set(key, task);
  appendJsonl(fileAt(out, 'queue.jsonl'), { ...task, queued_at: now() });
  return true;
}

function recordPage(run, out, task, status, fields = {}) {
  const event = { ...task, status, at: now(), ...fields };
  run.pages.set(keyOf(task), event);
  if (blocksSite(event)) run.blockedSites.add(task.site);
  appendJsonl(fileAt(out, 'pages.jsonl'), event);
}

function nextTask(run, sites, phase, retryErrors, attemptedInRun, attemptedBySite, perSiteLimit, refreshBeforeMs) {
  const kinds = phase === 'all' ? ['list', 'detail'] : [phase === 'lists' ? 'list' : 'detail'];
  for (const kind of kinds) for (const task of run.queue.values()) {
    if (task.kind !== kind || !sites.includes(task.site) || run.blockedSites.has(task.site)) continue;
    if ((attemptedBySite.get(task.site) ?? 0) >= perSiteLimit || attemptedInRun.has(keyOf(task))) continue;
    const event = run.pages.get(keyOf(task));
    const status = event?.status;
    const fetchedAtMs = Date.parse(event?.fetched_at ?? '');
    const shouldRefresh = status === 'done' && refreshBeforeMs != null
      && Number.isFinite(fetchedAtMs) && fetchedAtMs < refreshBeforeMs;
    if (!status || (status === 'error' && retryErrors) || shouldRefresh) return task;
  }
  return null;
}

async function pauseFor(origin, delayMs, lastRequestAt) {
  const previous = lastRequestAt.get(origin);
  if (previous != null) await sleep(Math.max(0, delayMs - (Date.now() - previous)));
}

function listingFingerprint(parsed) {
  const urls = [...(parsed.detailUrls ?? []), ...(parsed.records ?? []).map((row) => row.merchant_url).filter(Boolean)];
  if (!urls.length) return null;
  return createHash('sha256').update([...new Set(urls)].sort().join('\n')).digest('hex');
}

function parseRefreshBefore(value) {
  if (value == null) return null;
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new Error('refreshBefore must be an ISO timestamp with timezone');
  }
  return Date.parse(value);
}

export async function runSync({
  out = DEFAULT_OUT, sites = Object.keys(MERCHANT_SOURCES), sources = MERCHANT_SOURCES,
  maxRequests = 100, perSiteLimit = 100000, delayMs = 2000, phase = 'all', retryErrors = false,
  refreshBefore = null,
} = {}) {
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 100000) throw new Error('maxRequests must be 1..100000');
  if (!Number.isInteger(perSiteLimit) || perSiteLimit < 1 || perSiteLimit > 100000) throw new Error('perSiteLimit must be 1..100000');
  if (!Number.isInteger(delayMs) || delayMs < 2000 || delayMs > 60000) throw new Error('delayMs must be 2000..60000');
  if (!['all', 'lists', 'details'].includes(phase)) throw new Error('phase must be all, lists or details');
  const refreshBeforeMs = parseRefreshBefore(refreshBefore);
  for (const site of sites) if (!sources[site]) throw new Error('Unknown merchant site: ' + site);
  const target = resolve(out);
  const releaseLock = acquireLock(target);
  try {
  const run = loadRun(target, { repair: true });
  const observationKeys = new Set(readJsonl(fileAt(target, 'observations.jsonl'), { repair: true }).map(observationKey));
  for (const site of sites) enqueue(run, target, site, sources[site], sources, 'list');
  if (sites.includes('bagong')) {
    const seed = new URL(sources.bagong);
    if (seed.pathname === '/jiyang/beijing/' && !seed.search) {
      enqueue(run, target, 'bagong', new URL('/jiyang/shanghai/', seed).href, sources, 'list');
      enqueue(run, target, 'bagong', new URL('/sj/beijing/', seed).href, sources, 'list');
    }
  }
  if (sites.includes('uchongs')) {
    enqueue(run, target, 'uchongs', new URL('/shop/s0n3', sources.uchongs).href, sources, 'list');
  }
  const robotsBySite = new Map();
  const lastRequestAt = new Map();
  const attemptedInRun = new Set();
  const attemptedBySite = new Map();
  let requests = 0;
  let records = 0;
  async function runSite(site) {
    while (requests < maxRequests) {
    const task = nextTask(run, [site], phase, retryErrors, attemptedInRun, attemptedBySite, perSiteLimit, refreshBeforeMs);
    if (!task) break;
    attemptedInRun.add(keyOf(task));
    const origin = new URL(sources[task.site]).origin;
    if (!robotsBySite.has(task.site)) {
      try {
        await pauseFor(origin, delayMs, lastRequestAt);
        const robots = await fetchRobots(origin);
        lastRequestAt.set(origin, Date.now());
        robotsBySite.set(task.site, {
          text: robots.text,
          delayMs: Math.max(delayMs, robotsCrawlDelayMs(robots.text, USER_AGENT)),
        });
      } catch (error) {
        recordPage(run, target, task, 'blocked', { code: error.code ?? 'ROBOTS_UNAVAILABLE', message: error.message });
        console.error(task.site + ': robots unavailable: ' + error.message);
        continue;
      }
    }
    const robots = robotsBySite.get(task.site);
    if (requests >= maxRequests) break;
    requests++;
    attemptedBySite.set(task.site, (attemptedBySite.get(task.site) ?? 0) + 1);
    try {
      const sitemap = /sitemap[^/]*\.xml$/i.test(new URL(task.url).pathname);
      const result = await fetchWithPolicy(task.url, {
        origin, robotsText: robots.text, userAgent: USER_AGENT,
        acceptXml: sitemap, maxBytes: sitemap ? 5_000_000 : 2_000_000,
        timeoutMs: sitemap ? 60_000 : 15_000,
        beforeRequest: async () => {
          await pauseFor(origin, robots.delayMs, lastRequestAt);
          lastRequestAt.set(origin, Date.now());
        },
      });
      lastRequestAt.set(origin, Date.now());
      if (classifyMerchantUrl(task.site, result.url) !== task.kind) {
        throw Object.assign(new Error('Redirect changed merchant page type: ' + result.url), { code: 'OUT_OF_SCOPE' });
      }
      const parsed = parseMerchantPage(task.site, result.html, result.url);
      if (!Array.isArray(parsed.records) || !Array.isArray(parsed.listUrls) || !Array.isArray(parsed.detailUrls)) {
        throw Object.assign(new Error('Merchant adapter returned invalid arrays'), { code: 'PARSE_ERROR' });
      }
      for (const row of parsed.records) {
        if (!row.name || !row.merchant_url || row.source_site !== task.site) {
          throw Object.assign(new Error('Merchant adapter returned an incomplete record'), { code: 'PARSE_ERROR' });
        }
      }
      for (const url of parsed.listUrls) if (canonicalTask(task.site, url, sources)?.kind !== 'list') {
        throw Object.assign(new Error('Merchant adapter emitted an invalid list URL: ' + url), { code: 'PARSE_ERROR' });
      }
      for (const url of parsed.detailUrls) if (canonicalTask(task.site, url, sources)?.kind !== 'detail') {
        throw Object.assign(new Error('Merchant adapter emitted an invalid detail URL: ' + url), { code: 'PARSE_ERROR' });
      }
      const fingerprint = task.kind === 'list' ? listingFingerprint(parsed) : null;
      const duplicateList = fingerprint != null && run.fingerprints.get(task.site)?.has(fingerprint);
      const fetchedAt = now();
      if (!duplicateList) for (const row of parsed.records) {
        const observation = { ...row, fetched_at: fetchedAt };
        const observationId = observationKey(observation);
        if (!observationKeys.has(observationId)) {
          appendJsonl(fileAt(target, 'observations.jsonl'), observation);
          observationKeys.add(observationId);
          records++;
        }
      }
      if (fingerprint && !duplicateList) {
        if (!run.fingerprints.has(task.site)) run.fingerprints.set(task.site, new Set());
        run.fingerprints.get(task.site).add(fingerprint);
      }
      let addedLists = 0;
      let addedDetails = 0;
      if (!duplicateList) for (const url of parsed.listUrls) if (enqueue(run, target, task.site, url, sources, 'list')) addedLists++;
      for (const url of parsed.detailUrls) if (enqueue(run, target, task.site, url, sources, 'detail')) addedDetails++;
      recordPage(run, target, task, 'done', {
        fetched_at: fetchedAt, final_url: result.url, record_count: parsed.records.length,
        added_lists: addedLists, added_details: addedDetails,
        fingerprint, stop_reason: duplicateList ? 'duplicate_list' : null,
        warnings: parsed.warnings ?? [],
      });
      console.log(task.site + ' ' + task.kind + ': ' + parsed.records.length + ' records; +' + addedLists + ' lists, +' + addedDetails + ' details');
    } catch (error) {
      lastRequestAt.set(origin, Date.now());
      const code = error.code ?? 'ERROR';
      const status = BLOCK_CODES.has(code) ? 'blocked' : 'error';
      recordPage(run, target, task, status, { code, message: error.message });
      console.error(task.site + ' ' + task.kind + ': ' + code + ' - ' + error.message);
    }
    }
  }
  await Promise.all(sites.map(runSite));
  return { requests, records, ...inspectRun({ out: target, sources }) };
  } finally { releaseLock(); }
}

export function inspectRun({ out = DEFAULT_OUT, sources = MERCHANT_SOURCES } = {}) {
  const target = resolve(out);
  const run = loadRun(target);
  const bySite = {};
  for (const site of Object.keys(sources)) bySite[site] = {
    lists: { pending: 0, done: 0, error: 0, blocked: 0 },
    details: { pending: 0, done: 0, error: 0, blocked: 0 },
    blocked: run.blockedSites.has(site), observations: 0,
  };
  for (const task of run.queue.values()) {
    if (!bySite[task.site]) continue;
    const status = run.pages.get(keyOf(task))?.status ?? 'pending';
    bySite[task.site][task.kind === 'list' ? 'lists' : 'details'][status]++;
  }
  for (const row of readJsonl(fileAt(target, 'observations.jsonl'))) {
    if (bySite[row.source_site]) bySite[row.source_site].observations++;
  }
  return { bySite };
}

function safeCsv(value) {
  const text = value == null ? '' : String(value);
  const safe = /^\s*[=+\-@]/.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""').replace(/\r?\n/g, ' ') + '"';
}

function canonicalMerchantUrl(row) {
  let url;
  try { url = new URL(row.merchant_url); } catch { return row.merchant_url; }
  if (row.source_site === 'bagong') {
    const match = /^\/s(\d+)(?:\/service)?\/?$/.exec(url.pathname);
    return match ? url.origin + '/s' + match[1] + '/' : row.merchant_url;
  }
  if (['achong', 'apwol'].includes(row.source_site)) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}

function hasMeaningfulValue(value) {
  if (value == null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function redactPersonalProvider(row) {
  if (row.provider_type !== 'personal_or_unverified') return row;
  const publicFields = { ...row.public_fields };
  for (const field of ['description', 'image_urls', 'geo', 'detail_facts', 'phone_label_raw']) {
    delete publicFields[field];
  }
  return { ...row, address: null, address_hint: null, phone: null,
    description: null, public_fields: publicFields };
}

export function exportMerchants({ out = DEFAULT_OUT } = {}) {
  const target = resolve(out);
  const entities = new Map();
  for (const rawRow of readJsonl(fileAt(target, 'observations.jsonl'))) {
    const mislabeledHours = rawRow.source_site === 'mengchong'
      && /(?:周[一二三四五六日天]|星期|\d{1,2}:\d{2})/.test(rawRow.phone ?? '');
    const row = mislabeledHours
      ? { ...rawRow, phone: null, public_fields: { ...rawRow.public_fields, phone_label_raw: rawRow.phone } }
      : rawRow;
    if (!row.merchant_url || !row.name) continue;
    const merchantUrl = canonicalMerchantUrl(row);
    const key = row.source_site + '\t' + merchantUrl;
    const prior = entities.get(key);
    if (!prior) {
      entities.set(key, {
        ...row, merchant_url: merchantUrl,
        source_urls: [...new Set([row.source_url, row.merchant_url])],
        public_fields: row.public_fields ?? {},
      });
      continue;
    }
    const detail = classifyMerchantUrl(row.source_site, row.source_url) === 'detail';
    const merged = { ...prior, source_urls: [...new Set([...prior.source_urls, row.source_url, row.merchant_url])] };
    for (const [field, value] of Object.entries(row)) {
      if (['public_fields', 'source_urls', 'merchant_url', 'provider_type'].includes(field)) continue;
      if (value != null && value !== '' && (detail || merged[field] == null || merged[field] === '')) merged[field] = value;
    }
    merged.public_fields = { ...prior.public_fields };
    for (const [field, value] of Object.entries(row.public_fields ?? {})) {
      if (hasMeaningfulValue(value)) merged.public_fields[field] = value;
    }
    if (row.provider_type === 'personal_or_unverified' || (detail && row.provider_type === 'business')) merged.provider_type = row.provider_type;
    entities.set(key, merged);
  }
  mkdirSync(target, { recursive: true });
  const rows = [...entities.values()].map(redactPersonalProvider);
  const jsonlPath = fileAt(target, 'merchants.jsonl');
  const csvPath = fileAt(target, 'merchants.csv');
  const columns = ['source_site', 'merchant_url', 'name', 'provider_type', 'address', 'address_hint', 'phone', 'hours', 'price_text', 'rating_text', 'claim_status', 'description', 'public_fields', 'source_urls', 'fetched_at', 'verified', 'license_verified'];
  const jsonl = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  const csv = '\ufeff' + [columns.join(','), ...rows.map((row) => columns.map((column) => {
    const value = ['public_fields', 'source_urls'].includes(column) ? JSON.stringify(row[column] ?? null) : row[column];
    return safeCsv(value);
  }).join(','))].join('\r\n') + '\r\n';
  writeFileSync(jsonlPath + '.tmp', jsonl, 'utf8');
  writeFileSync(csvPath + '.tmp', csv, 'utf8');
  renameSync(jsonlPath + '.tmp', jsonlPath);
  renameSync(csvPath + '.tmp', csvPath);
  return { merchants: rows.length, jsonlPath, csvPath };
}

function option(argv, name, fallback) {
  const key = '--' + name;
  const assignment = argv.find((item) => item.startsWith(key + '='));
  if (assignment) return assignment.slice(key.length + 1);
  const index = argv.indexOf(key);
  if (index < 0) return fallback;
  if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error('Missing value for ' + key);
  return argv[index + 1];
}

function integerOption(argv, name, fallback, min, max) {
  const value = Number(option(argv, name, String(fallback)));
  if (!Number.isInteger(value) || value < min || value > max) throw new Error('--' + name + ' must be ' + min + '..' + max);
  return value;
}

async function main(argv) {
  const command = argv[0] ?? 'status';
  const out = resolve(option(argv, 'out', DEFAULT_OUT));
  const sites = [...new Set(option(argv, 'sites', Object.keys(MERCHANT_SOURCES).join(',')).split(',').map((value) => value.trim()).filter(Boolean))];
  for (const site of sites) if (!MERCHANT_SOURCES[site]) throw new Error('Unknown merchant site: ' + site);
  if (command === 'sync') {
    const result = await runSync({
      out, sites,
      maxRequests: integerOption(argv, 'max-requests', 100, 1, 100000),
      perSiteLimit: integerOption(argv, 'per-site-limit', 100000, 1, 100000),
      delayMs: integerOption(argv, 'delay', 2000, 2000, 60000),
      phase: option(argv, 'phase', 'all'),
      retryErrors: argv.includes('--retry-errors'),
      refreshBefore: option(argv, 'refresh-before', null),
    });
    console.log(JSON.stringify(result, null, 2));
    if (argv.includes('--export-on-exit')) console.log(JSON.stringify(exportMerchants({ out }), null, 2));
  } else if (command === 'status') console.log(JSON.stringify(inspectRun({ out }), null, 2));
  else if (command === 'export') console.log(JSON.stringify(exportMerchants({ out }), null, 2));
  else if (command === 'help' || command === '--help') {
    console.log('Usage: node merchant-full.mjs <sync|status|export> [--sites ids] [--out dir]');
    console.log('sync: --phase lists|details|all --max-requests 1..100000 --per-site-limit 1..100000 --delay 2000..60000 --retry-errors --refresh-before ISO_TIME --export-on-exit');
  } else throw new Error('Unknown command: ' + command);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
