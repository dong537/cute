#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const COLUMNS = [
  'source_site', 'merchant_url', 'name', 'provider_type', 'address', 'address_hint',
  'hours', 'price_text', 'rating_text', 'claim_status', 'public_fields',
  'source_urls', 'fetched_at', 'verified', 'license_verified',
];
const PUBLIC_FACT_KEYS = [
  'pet_types', 'service_tags', 'categories', 'review_count', 'rating_source',
  'platform_verification', 'business_scope', 'area_served', 'region',
  'site_score_text', 'category_text', 'detail_facts',
];
const PRIVATE_FACT_LABEL = /电话|手机|联系|微信|QQ|邮箱|e-?mail|phone|法人|代表人|负责人|经营者|姓名|证件|执照|身份证|统一社会信用代码/iu;
const PHONE = /(?<!\d)(?:\+?86[\s-]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}(?!\d)|(?<!\d)0\d{2,3}[\s-]?\d{7,8}(?!\d)/gu;
const POSSIBLE_PERSONAL = /家庭寄养|家庭式寄养|个人寄养|私家寄养/u;

function redactText(value) {
  if (typeof value === 'string') return value.replace(PHONE, '[已脱敏电话]');
  if (Array.isArray(value)) return value.map(redactText);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactText(item)]));
  }
  return value;
}

function options(argv) {
  let input;
  let out;
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name !== '--input' && name !== '--out') throw new Error('Unknown option: ' + name);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing value for ' + name);
    if (name === '--input') input = resolve(value);
    else out = resolve(value);
  }
  if (!input || !out) throw new Error('Usage: node build-public-snapshot.mjs --input frozen-merchants.jsonl --out release-directory');
  if (!existsSync(input)) throw new Error('Input does not exist: ' + input);
  return { input, out };
}

function publicRecord(raw) {
  const fields = raw.public_fields ?? {};
  const facts = {};
  for (const key of PUBLIC_FACT_KEYS) {
    if (key === 'detail_facts') {
      if (Array.isArray(fields.detail_facts)) facts.detail_facts = fields.detail_facts.filter((fact) =>
        fact && !PRIVATE_FACT_LABEL.test(String(fact.label ?? '').replace(/\s+/g, ''))).map(redactText);
    } else if (fields[key] != null) facts[key] = redactText(fields[key]);
  }
  const record = {};
  for (const key of COLUMNS) {
    record[key] = key === 'public_fields' ? facts
      : ['merchant_url', 'source_urls', 'fetched_at'].includes(key) ? raw[key] ?? null
        : redactText(raw[key] ?? null);
  }
  return record;
}

function csvCell(value) {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const safe = /^\s*[=+\-@]/.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""').replace(/\r?\n/g, ' ') + '"';
}

async function writeChunk(stream, value) {
  if (!stream.write(value)) await once(stream, 'drain');
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function build({ input, out }) {
  mkdirSync(out, { recursive: true });
  const jsonPath = join(out, 'merchants.jsonl.gz');
  const csvPath = join(out, 'merchants.csv.gz');
  const manifestPath = join(out, 'manifest.json');
  for (const path of [jsonPath, csvPath, manifestPath]) {
    if (existsSync(path)) throw new Error('Refusing to overwrite release file: ' + path);
  }
  const jsonTemp = jsonPath + '.tmp';
  const csvTemp = csvPath + '.tmp';
  const jsonGzip = createGzip({ level: 9 });
  const csvGzip = createGzip({ level: 9 });
  const jsonDone = pipeline(jsonGzip, createWriteStream(jsonTemp));
  const csvDone = pipeline(csvGzip, createWriteStream(csvTemp));
  const counts = { records_in: 0, records_published: 0,
    excluded_personal: 0, excluded_possible_personal: 0, by_site: {} };
  try {
    await writeChunk(csvGzip, COLUMNS.join(',') + '\r\n');
    const reader = createInterface({ input: createReadStream(input, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of reader) {
      if (!line) continue;
      counts.records_in++;
      let raw;
      try { raw = JSON.parse(line); }
      catch (cause) { throw new Error('Invalid input JSONL line ' + counts.records_in + ': ' + cause.message); }
      if (!raw.name || !raw.merchant_url || !raw.source_site) {
        throw new Error('Missing merchant identity at input line ' + counts.records_in);
      }
      if (raw.provider_type === 'personal_or_unverified') {
        counts.excluded_personal++;
        continue;
      }
      if (raw.provider_type !== 'business' && POSSIBLE_PERSONAL.test(raw.name)) {
        counts.excluded_possible_personal++;
        continue;
      }
      const row = publicRecord(raw);
      await writeChunk(jsonGzip, JSON.stringify(row) + '\n');
      await writeChunk(csvGzip, COLUMNS.map((key) => csvCell(row[key])).join(',') + '\r\n');
      counts.records_published++;
      counts.by_site[row.source_site] = (counts.by_site[row.source_site] ?? 0) + 1;
    }
    jsonGzip.end();
    csvGzip.end();
    await Promise.all([jsonDone, csvDone]);
    renameSync(jsonTemp, jsonPath);
    renameSync(csvTemp, csvPath);
    const files = {};
    for (const path of [jsonPath, csvPath]) files[basename(path)] = {
      bytes: statSync(path).size, sha256: await sha256(path),
    };
    const manifest = {
      schema_version: 1,
      created_at: new Date().toISOString(),
      source_snapshot: basename(input),
      source_bytes: statSync(input).size,
      source_sha256: await sha256(input),
      source_file_modified_at: statSync(input).mtime.toISOString(),
      ...counts,
      columns: COLUMNS,
      removed: ['personal_or_unverified records', 'possible personal boarding records',
        'phone', 'description', 'image_urls',
        'phone_label_raw', 'map_coordinates_raw', 'public_fields.url',
        'contact and personal identity detail_facts', 'phone numbers embedded in retained text'],
      note: 'Third-party source facts; verified and license_verified retain their original values. User confirmed redistribution permission; per-source evidence was not independently audited.',
      files,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify(manifest, null, 2));
  } catch (error) {
    jsonGzip.destroy();
    csvGzip.destroy();
    await Promise.allSettled([jsonDone, csvDone]);
    rmSync(jsonTemp, { force: true });
    rmSync(csvTemp, { force: true });
    throw error;
  }
}

try { await build(options(process.argv.slice(2))); }
catch (error) { console.error(error.message); process.exitCode = 1; }
