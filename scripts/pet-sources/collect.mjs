#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canFollow, extractPage } from './extract.mjs';
import { fetchRobots, fetchWithPolicy, USER_AGENT } from './net.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCES = {
  bagong: 'https://www.bagong.cn/jiyang/',
  achong: 'https://achong.net/hospital/chengdu',
  mengchong: 'https://www.mengchong.cn/dianpu/',
  apwol: 'https://www.apwol.com/provider/list/',
  chongwunet: 'https://www.chongwunet.com/pp',
  chongso: 'https://m.chongso.com/',
  boqii: 'https://www.boqii.com/baike/dog/',
  moguvet: 'https://www.moguvet.com/article/list/',
  petdr: 'https://www.petdr.cn/medical/',
  chongwu365: 'https://www.chongwu365.com/news/yangchong/',
  petdian: 'https://www.petdian.com/zs',
};

const argv = process.argv.slice(2);
const command = argv[0] ?? 'stats';
function option(name, fallback) {
  const key = '--' + name;
  const equals = argv.find((arg) => arg.startsWith(key + '='));
  if (equals) return equals.slice(key.length + 1);
  const index = argv.indexOf(key);
  if (index < 0) return fallback;
  if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error('Missing value for ' + key);
  return argv[index + 1];
}
function boundedInteger(name, fallback, min, max) {
  const raw = option(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error('--' + name + ' must be an integer from ' + min + ' to ' + max);
  }
  return value;
}
const OUT = resolve(option('out', join(ROOT, 'data', 'pet-sources')));
const STATE = join(OUT, 'state.json');
const QUEUE = join(OUT, 'queue.json');
const OBSERVATIONS = join(OUT, 'observations.jsonl');
const CSV = join(OUT, 'export.csv');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const now = () => new Date().toISOString();

function selectedSources() {
  const requested = option('sites', Object.keys(SOURCES).join(','));
  const ids = [...new Set(requested.split(',').map((value) => value.trim()).filter(Boolean))];
  for (const id of ids) if (!SOURCES[id]) throw new Error('Unknown site: ' + id);
  if (!ids.length) throw new Error('No sites selected');
  return ids;
}
function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}
function saveJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
function observations() {
  if (!existsSync(OBSERVATIONS)) return [];
  return readFileSync(OBSERVATIONS, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
function appendRecords(records, fetchedAt) {
  if (!records.length) return;
  mkdirSync(OUT, { recursive: true });
  for (const item of records) appendFileSync(OBSERVATIONS, JSON.stringify({ ...item, fetched_at: fetchedAt }) + '\n');
}
function noteFailure(state, id, url, error) {
  const blocked = ['HTTP_BLOCKED', 'CHALLENGE', 'ROBOTS_UNAVAILABLE', 'ROBOTS_DENIED'].includes(error.code);
  state.pages[url] = { site: id, status: blocked ? 'blocked' : 'error', code: error.code ?? 'ERROR', message: error.message, at: now() };
  state.sites[id] = { ...(state.sites[id] ?? {}), blocked, lastError: error.message, checkedAt: now() };
  saveJson(STATE, state);
  console.error(id + ': ' + (error.code ?? 'ERROR') + ' - ' + error.message);
}
async function policy(id, state) {
  const origin = new URL(SOURCES[id]).origin;
  try {
    const robots = await fetchRobots(origin);
    state.sites[id] = { ...(state.sites[id] ?? {}), robotsStatus: robots.status, checkedAt: now(), blocked: false };
    saveJson(STATE, state);
    return robots.text;
  } catch (error) {
    noteFailure(state, id, new URL('/robots.txt', origin).href, error);
    return null;
  }
}
async function discover() {
  const sites = selectedSources();
  const maxPages = boundedInteger('max-pages', 2, 1, 5);
  const delayMs = boundedInteger('delay', 2000, 2000, 60000);
  const refresh = argv.includes('--refresh');
  const state = readJson(STATE, { version: 1, pages: {}, sites: {} });
  const queue = readJson(QUEUE, []);
  for (const id of sites) {
    const seed = SOURCES[id];
    if (state.sites[id]?.blocked) { console.log(id + ': blocked previously; skipped'); continue; }
    if (state.pages[seed]?.status === 'done' && !refresh) { console.log(id + ': already discovered'); continue; }
    const robotsText = await policy(id, state);
    if (robotsText == null) continue;
    await sleep(delayMs);
    try {
      const result = await fetchWithPolicy(seed, { origin: new URL(seed).origin, robotsText, userAgent: USER_AGENT });
      const extracted = extractPage(id, result.html, result.url);
      const fetchedAt = now();
      appendRecords(extracted.records, fetchedAt);
      state.pages[seed] = { site: id, status: 'done', fetchedAt, records: extracted.records.length, finalUrl: result.url };
      for (const url of extracted.links.slice(0, maxPages - 1)) {
        if (!canFollow(id, url, new URL(seed).origin)) continue;
        if (!queue.some((task) => task.site === id && task.url === url)) queue.push({ site: id, url });
      }
      saveJson(STATE, state);
      saveJson(QUEUE, queue);
      console.log(id + ': ' + extracted.records.length + ' records, ' + Math.min(extracted.links.length, maxPages - 1) + ' detail URLs');
    } catch (error) { noteFailure(state, id, seed, error); }
  }
}
async function crawl() {
  const sites = new Set(selectedSources());
  const delayMs = boundedInteger('delay', 2000, 2000, 60000);
  const limit = boundedInteger('limit', 0, 0, 55);
  if (!existsSync(QUEUE)) throw new Error('Queue missing; run discover first');
  const queue = readJson(QUEUE, []);
  const state = readJson(STATE, { version: 1, pages: {}, sites: {} });
  const robotsCache = new Map();
  let attempted = 0;
  for (const task of queue) {
    if (!sites.has(task.site) || state.pages[task.url]?.status === 'done' || state.sites[task.site]?.blocked) continue;
    if (limit && attempted >= limit) break;
    const origin = new URL(SOURCES[task.site]).origin;
    if (!canFollow(task.site, task.url, origin)) {
      noteFailure(state, task.site, task.url, Object.assign(new Error('Out-of-scope detail URL'), { code: 'OUT_OF_SCOPE' }));
      continue;
    }
    if (!robotsCache.has(task.site)) robotsCache.set(task.site, await policy(task.site, state));
    const robotsText = robotsCache.get(task.site);
    if (robotsText == null) continue;
    await sleep(delayMs);
    attempted++;
    try {
      const result = await fetchWithPolicy(task.url, { origin, robotsText, userAgent: USER_AGENT });
      const extracted = extractPage(task.site, result.html, result.url);
      const fetchedAt = now();
      appendRecords(extracted.records, fetchedAt);
      state.pages[task.url] = { site: task.site, status: 'done', fetchedAt, records: extracted.records.length, finalUrl: result.url };
      saveJson(STATE, state);
      console.log(task.site + ': ' + extracted.records.length + ' records from ' + result.url);
    } catch (error) { noteFailure(state, task.site, task.url, error); }
  }
  console.log('Attempted ' + attempted + ' detail pages');
}
function stats() {
  const state = readJson(STATE, { pages: {}, sites: {} });
  const rows = observations();
  const pages = Object.values(state.pages);
  const done = pages.filter((page) => page.status === 'done').length;
  const blocked = pages.filter((page) => page.status === 'blocked').length;
  console.log(rows.length + ' records; ' + done + ' pages done; ' + blocked + ' pages blocked');
  for (const id of Object.keys(SOURCES)) {
    const count = rows.filter((row) => row.source_site === id).length;
    const status = state.sites[id]?.blocked ? 'blocked' : state.sites[id]?.lastError ? 'error' : 'ready';
    if (count || state.sites[id]) console.log(id + ': ' + count + ' records, ' + status);
  }
}
function csvCell(value) {
  const text = value == null ? '' : String(value);
  const safe = /^\s*[=+\-@]/.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""').replace(/\r?\n/g, ' ') + '"';
}
function exportCsv() {
  const columns = ['type', 'source_site', 'source_url', 'target_url', 'merchant_url', 'name', 'address', 'address_hint', 'phone', 'hours', 'price_text', 'rating_text', 'claim_status', 'title', 'description', 'author', 'published_at', 'source_level', 'fetched_at', 'verified', 'license_verified'];
  const latest = new Map();
  for (const row of observations()) {
    const key = [row.type, row.source_site, row.source_url, row.target_url, row.merchant_url, row.name, row.title].join('|');
    latest.set(key, row);
  }
  mkdirSync(OUT, { recursive: true });
  const lines = [columns.join(','), ...[...latest.values()].map((row) => columns.map((key) => csvCell(row[key])).join(','))];
  writeFileSync(CSV, '\ufeff' + lines.join('\r\n') + '\r\n', 'utf8');
  console.log('Exported ' + latest.size + ' deduplicated records to ' + CSV);
}
function help() {
  console.log('Usage: node scripts/pet-sources/collect.mjs <discover|crawl|stats|export> [options]');
  console.log('--sites id,id  --max-pages 1..5  --delay >=2000  --limit 0..55  --out dir  --refresh');
  console.log('Sites: ' + Object.keys(SOURCES).join(', '));
}

try {
  if (command === 'discover') await discover();
  else if (command === 'crawl') await crawl();
  else if (command === 'stats' || command === 'check') stats();
  else if (command === 'export') exportCsv();
  else if (command === '--help' || command === 'help') help();
  else throw new Error('Unknown command: ' + command);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
