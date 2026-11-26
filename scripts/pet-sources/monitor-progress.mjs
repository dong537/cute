#!/usr/bin/env node
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_OUT = join(ROOT, 'data', 'pet-sources', 'merchant-full-20261125');
const SITE_NAMES = { bagong: '八公', uchongs: '优宠网', achong: '爱宠网', mengchong: '萌宠网', apwol: '动物星球' };
const STATES = ['pending', 'done', 'error', 'blocked'];
const DISPLAY_STATES = ['done', 'pending', 'error', 'blocked'];

function taskKey(task) {
  if (task.site !== 'bagong') return task.site + '\t' + task.url;
  const url = new URL(task.url);
  if (/^\/s\d+\/?$/.test(url.pathname) && !url.search) url.pathname = url.pathname.replace(/\/?$/, '/');
  return task.site + '\t' + url.href;
}

class JsonlTail {
  constructor(path) {
    this.path = path;
    this.offset = 0;
    this.tail = Buffer.alloc(0);
    this.line = 0;
    this.seen = false;
  }

  consume(onRow) {
    let size;
    try { size = statSync(this.path).size; this.seen = true; }
    catch (error) {
      if (error.code === 'ENOENT' && !this.seen) return;
      throw error;
    }
    if (size < this.offset) throw new Error('Journal was truncated while monitoring: ' + this.path);
    if (size === this.offset) return;
    const fd = openSync(this.path, 'r');
    try {
      while (this.offset < size) {
        const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, size - this.offset));
        const length = readSync(fd, chunk, 0, chunk.length, this.offset);
        if (length === 0) break;
        this.offset += length;
        const data = Buffer.concat([this.tail, chunk.subarray(0, length)]);
        let start = 0;
        for (let i = 0; i < data.length; i++) {
          if (data[i] !== 10) continue;
          this.line++;
          const raw = data.subarray(start, i).toString('utf8').replace(/\r$/, '');
          if (raw) {
            let row;
            try { row = JSON.parse(raw); }
            catch (cause) { throw new Error('Invalid JSONL at ' + this.path + ':' + this.line + ': ' + cause.message); }
            onRow(row);
          }
          start = i + 1;
        }
        this.tail = Buffer.from(data.subarray(start));
      }
    } finally { closeSync(fd); }
  }
}

function emptyCounts() { return { pending: 0, done: 0, error: 0, blocked: 0 }; }

function lockState(path, json = false) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { state: 'idle', pid: null };
    throw error;
  }
  let pid;
  try { pid = json ? JSON.parse(raw).pid : Number(raw.trim()); }
  catch (cause) { throw new Error('Invalid lock at ' + path + ': ' + cause.message); }
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid lock PID at ' + path);
  try { process.kill(pid, 0); return { state: 'running', pid }; }
  catch (error) {
    if (error.code === 'ESRCH') return { state: 'stale', pid };
    if (error.code === 'EPERM') return { state: 'running', pid };
    throw error;
  }
}

function optionalStat(path) {
  try { return statSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

class ProgressReader {
  constructor(out) {
    this.out = out;
    this.queue = new JsonlTail(join(out, 'queue.jsonl'));
    this.pages = new JsonlTail(join(out, 'pages.jsonl'));
    this.tasks = new Map();
    this.events = new Map();
    this.lastPage = null;
    this.exportCache = null;
  }

  snapshot() {
    this.queue.consume((task) => {
      if (!task.site || !task.url || !['list', 'detail'].includes(task.kind)) {
        throw new Error('Invalid queue task in ' + this.queue.path);
      }
      this.tasks.set(taskKey(task), task);
    });
    this.pages.consume((event) => {
      if (!event.site || !event.url || !STATES.includes(event.status)) {
        throw new Error('Invalid page event in ' + this.pages.path);
      }
      this.events.set(taskKey(event), event);
      this.lastPage = { site: event.site, kind: event.kind, status: event.status, code: event.code ?? null, at: event.at ?? null };
    });
    const bySite = Object.fromEntries(Object.keys(SITE_NAMES).map((site) => [site, {
      lists: emptyCounts(), details: emptyCounts(), blocked: false,
    }]));
    for (const task of this.tasks.values()) {
      const site = bySite[task.site] ??= { lists: emptyCounts(), details: emptyCounts(), blocked: false };
      const status = this.events.get(taskKey(task))?.status ?? 'pending';
      site[task.kind === 'list' ? 'lists' : 'details'][status]++;
    }
    for (const event of this.events.values()) {
      if (event.status === 'blocked' && event.code !== 'ROBOTS_DENIED' && bySite[event.site]) {
        bySite[event.site].blocked = true;
      }
    }
    const totals = { lists: emptyCounts(), details: emptyCounts() };
    for (const site of Object.values(bySite)) for (const kind of ['lists', 'details']) {
      for (const state of STATES) totals[kind][state] += site[kind][state];
    }
    const csv = optionalStat(join(this.out, 'merchants.csv'));
    const jsonlPath = join(this.out, 'merchants.jsonl');
    const jsonl = optionalStat(jsonlPath);
    const cacheKey = jsonl && jsonl.mtimeMs + ':' + jsonl.size;
    if (cacheKey && this.exportCache?.key !== cacheKey) {
      const data = readFileSync(jsonlPath, 'utf8');
      this.exportCache = { key: cacheKey, rows: data ? data.split('\n').length - (data.endsWith('\n') ? 1 : 0) : 0 };
    }
    return {
      at: new Date().toISOString(), bySite, totals, lastPage: this.lastPage,
      sync: lockState(join(this.out, 'sync.lock'), true),
      continuation: lockState(join(this.out, 'continuation.lock')),
      export: {
        exists: Boolean(csv), rows: this.exportCache?.rows ?? null,
        updatedAt: csv?.mtime.toISOString() ?? null,
        stale: Boolean(csv && this.lastPage?.at && Date.parse(this.lastPage.at) > csv.mtimeMs),
        writing: existsSync(join(this.out, 'merchants.csv.tmp')) || existsSync(join(this.out, 'merchants.jsonl.tmp')),
      },
    };
  }
}

function render(snapshot, previous) {
  const stamp = new Date(snapshot.at).toLocaleString('zh-CN', { hour12: false });
  const status = (lock) => lock.state === 'running' ? '运行中 PID ' + lock.pid
    : lock.state === 'stale' ? '锁残留 PID ' + lock.pid : '空闲';
  const rows = [
    '宠物商家采集进度  ' + stamp,
    '采集：' + status(snapshot.sync) + '    接力：' + status(snapshot.continuation),
  ];
  if (snapshot.export.exists) {
    rows.push('导出：' + (snapshot.export.rows ?? '未知') + ' 条来源记录  ' + snapshot.export.updatedAt
      + (snapshot.export.writing ? '（正在写入）' : snapshot.export.stale ? '（落后于页面日志）' : ''));
  } else rows.push('导出：尚未生成');
  rows.push('站点           列表 完成/待抓/错误/阻断        详情 完成/待抓/错误/阻断');
  for (const [id, site] of Object.entries(snapshot.bySite)) {
    const counts = (value) => DISPLAY_STATES.map((key) => value[key]).join('/');
    rows.push((SITE_NAMES[id] ?? id).padEnd(8) + ' (' + id + ')   ' + counts(site.lists).padEnd(22)
      + '   ' + counts(site.details) + (site.blocked ? '  [站点阻断]' : ''));
  }
  const total = snapshot.totals;
  rows.push('合计           ' + DISPLAY_STATES.map((key) => total.lists[key]).join('/') + '                 '
    + DISPLAY_STATES.map((key) => total.details[key]).join('/'));
  if (previous) {
    const seconds = Math.max(0.001, (Date.parse(snapshot.at) - Date.parse(previous.at)) / 1000);
    const listDelta = total.lists.done - previous.totals.lists.done;
    const detailDelta = total.details.done - previous.totals.details.done;
    rows.push('本次刷新：列表完成 +' + listDelta + '，详情完成 +' + detailDelta
      + '；详情速度约 ' + Math.round(detailDelta * 60 / seconds) + ' 页/分钟');
  }
  if (snapshot.lastPage) rows.push('最近页面：' + snapshot.lastPage.site + ' ' + snapshot.lastPage.kind
    + ' ' + snapshot.lastPage.status + ' ' + (snapshot.lastPage.at ?? '时间未知'));
  rows.push('仅统计已发现任务；队列可能继续增长。导出记录不等于已核实的独立商家。Ctrl+C 仅停止监控。');
  return rows.join('\n');
}

function argumentsFor(argv) {
  let out = DEFAULT_OUT;
  let interval = 5;
  let once = false;
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--once') once = true;
    else if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--out' || arg === '--interval') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing value for ' + arg);
      if (arg === '--out') out = resolve(value);
      else {
        interval = Number(value);
        if (!Number.isInteger(interval) || interval < 1 || interval > 3600) {
          throw new Error('--interval must be 1..3600 seconds');
        }
      }
    } else throw new Error('Unknown option: ' + arg);
  }
  return { out, interval, once, json, help };
}

async function main() {
  const args = argumentsFor(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node monitor-progress.mjs [--out directory] [--interval seconds] [--once] [--json]');
    return;
  }
  if (!existsSync(args.out)) throw new Error('Output directory does not exist: ' + args.out);
  const reader = new ProgressReader(args.out);
  let previous = null;
  do {
    const snapshot = reader.snapshot();
    if (args.json) console.log(JSON.stringify(snapshot));
    else {
      if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
      console.log(render(snapshot, previous));
      if (!process.stdout.isTTY && !args.once) console.log('');
    }
    previous = snapshot;
    if (args.once) break;
    await new Promise((resolve) => setTimeout(resolve, args.interval * 1000));
  } while (true);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
