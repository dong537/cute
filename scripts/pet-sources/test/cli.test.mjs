import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../collect.mjs', import.meta.url));

test('empty output has visible zero counts', () => {
  const out = mkdtempSync(join(tmpdir(), 'pet-crawl-test-'));
  try {
    const run = spawnSync(process.execPath, [script, 'stats', '--out', out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /0 records/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('unknown source is rejected before network access', () => {
  const run = spawnSync(process.execPath, [script, 'discover', '--sites', 'not-a-site'], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Unknown site/);
});

test('CSV export prevents source text from becoming a spreadsheet formula', () => {
  const out = mkdtempSync(join(tmpdir(), 'pet-crawl-test-'));
  try {
    writeFileSync(join(out, 'observations.jsonl'), JSON.stringify({ type: 'merchant_lead', name: '=2+2', source_site: 'test' }) + '\n');
    const run = spawnSync(process.execPath, [script, 'export', '--out', out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(readFileSync(join(out, 'export.csv'), 'utf8'), /"'=2\+2"/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
