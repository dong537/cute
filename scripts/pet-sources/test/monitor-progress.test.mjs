import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../monitor-progress.mjs', import.meta.url));
const task = (url, kind) => ({ site: 'uchongs', url, kind });
const list = task('https://www.uchongs.com/shop/s0n1', 'list');
const detail1 = task('https://www.uchongs.com/shop/d1', 'detail');
const detail2 = task('https://www.uchongs.com/shop/d2', 'detail');
const lines = (...rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

test('once reports separate list and detail progress and a live sync lock', () => {
  const out = mkdtempSync(join(tmpdir(), 'pet-progress-'));
  try {
    writeFileSync(join(out, 'queue.jsonl'), lines(list, detail1, detail2));
    writeFileSync(join(out, 'pages.jsonl'), lines(
      { ...list, status: 'done' }, { ...detail1, status: 'done' },
    ));
    writeFileSync(join(out, 'sync.lock'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    writeFileSync(join(out, 'merchants.csv'), 'source_site,name\r\nuchongs,example\r\n');
    const run = spawnSync(process.execPath, [script, '--once', '--json', '--out', out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const snapshot = JSON.parse(run.stdout.trim());
    assert.deepEqual(snapshot.bySite.uchongs.lists, { pending: 0, done: 1, error: 0, blocked: 0 });
    assert.deepEqual(snapshot.bySite.uchongs.details, { pending: 1, done: 1, error: 0, blocked: 0 });
    assert.equal(snapshot.sync.state, 'running');
    assert.equal(snapshot.sync.pid, process.pid);
    assert.equal(snapshot.export.exists, true);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('human output prints completed pages before pending pages', () => {
  const out = mkdtempSync(join(tmpdir(), 'pet-progress-'));
  try {
    writeFileSync(join(out, 'queue.jsonl'), lines(list, detail1, detail2));
    writeFileSync(join(out, 'pages.jsonl'), lines(
      { ...list, status: 'done' }, { ...detail1, status: 'done' },
    ));
    const run = spawnSync(process.execPath, [script, '--once', '--out', out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const row = run.stdout.split('\n').find((line) => line.includes('(uchongs)'));
    assert.match(row, /1\/0\/0\/0\s+1\/1\/0\/0/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('watch mode sees appended journal events without treating incomplete lines as finished', async () => {
  const out = mkdtempSync(join(tmpdir(), 'pet-progress-'));
  writeFileSync(join(out, 'queue.jsonl'), lines(detail1, detail2));
  writeFileSync(join(out, 'pages.jsonl'), lines({ ...detail1, status: 'done' }));
  const child = spawn(process.execPath, [script, '--json', '--interval', '1', '--out', out], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';
  const snapshots = [];
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) snapshots.push(JSON.parse(line));
    }
  });
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = snapshots.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Monitor did not emit expected snapshot; exit=' + child.exitCode);
  };
  try {
    const initial = await waitFor((s) => s.bySite?.uchongs?.details?.pending === 1);
    assert.equal(initial.bySite.uchongs.details.done, 1);
    const event = JSON.stringify({ ...detail2, status: 'done' });
    appendFileSync(join(out, 'pages.jsonl'), event.slice(0, -2));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(snapshots.at(-1).bySite.uchongs.details.pending, 1);
    appendFileSync(join(out, 'pages.jsonl'), event.slice(-2) + '\n');
    const updated = await waitFor((s) => s.bySite?.uchongs?.details?.done === 2);
    assert.equal(updated.bySite.uchongs.details.pending, 0);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
    rmSync(out, { recursive: true, force: true });
  }
});
