import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const script = fileURLToPath(new URL('../build-public-snapshot.mjs', import.meta.url));

test('public snapshot excludes personal records and contact or copied-content fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'pet-release-'));
  try {
    const input = join(root, 'source.jsonl');
    const out = join(root, 'release');
    const base = {
      source_site: 'uchongs', merchant_url: 'https://www.uchongs.com/shop/d1',
      name: '=测试宠物店 13800000000', provider_type: null, address: '测试路1号 010-12345678', address_hint: null,
      phone: '13800000000', hours: '09:00-20:00', price_text: null, rating_text: null,
      claim_status: null, description: '原站营销描述',
      public_fields: {
        region: '北京市', category_text: '店铺', image_urls: ['https://example.test/image.jpg'],
        description: '原站营销描述', phone_label_raw: '13800000000',
        detail_facts: [
          { label: '电 话：', value: '13800000000' },
          { label: '法人', value: '张三' },
          { label: '法定代表人', value: '李四' },
          { label: '营业时间', value: '09:00-20:00' },
          { label: '服务', value: '预约 13900000000' },
        ],
      },
      source_urls: ['https://www.uchongs.com/shop/d1'], fetched_at: '2026-11-26T01:00:00.000Z',
      verified: false, license_verified: false,
    };
    const personal = { ...base, merchant_url: 'https://www.bagong.cn/s2/', name: '个人寄养者',
      source_site: 'bagong', provider_type: 'personal_or_unverified' };
    const possiblePersonal = { ...base, merchant_url: 'https://www.uchongs.com/shop/d4',
      name: '家庭式寄养', provider_type: null, address: '某住宅小区' };
    const other = { ...base, merchant_url: 'https://www.uchongs.com/shop/d3', name: '另一家店' };
    writeFileSync(input, [base, personal, possiblePersonal, other].map((row) => JSON.stringify(row)).join('\n') + '\n');
    const run = spawnSync(process.execPath, [script, '--input', input, '--out', out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const rows = gunzipSync(readFileSync(join(out, 'merchants.jsonl.gz'))).toString('utf8').trim().split('\n').map(JSON.parse);
    const csv = gunzipSync(readFileSync(join(out, 'merchants.csv.gz'))).toString('utf8');
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, '=测试宠物店 [已脱敏电话]');
    assert.equal(rows[0].address, '测试路1号 [已脱敏电话]');
    assert.equal(rows[0].hours, '09:00-20:00');
    assert.equal('phone' in rows[0], false);
    assert.equal('description' in rows[0], false);
    assert.equal('image_urls' in rows[0].public_fields, false);
    assert.equal('phone_label_raw' in rows[0].public_fields, false);
    assert.deepEqual(rows[0].public_fields.detail_facts.map((fact) => fact.label), ['营业时间', '服务']);
    assert.equal(rows[0].public_fields.detail_facts[1].value, '预约 [已脱敏电话]');
    assert.match(csv, /"'=测试宠物店 \[已脱敏电话\]"/);
    assert.equal(manifest.records_in, 4);
    assert.equal(manifest.records_published, 2);
    assert.equal(manifest.excluded_personal, 1);
    assert.equal(manifest.excluded_possible_personal, 1);
    assert.deepEqual(manifest.by_site, { uchongs: 2 });
    assert.equal(manifest.files['merchants.jsonl.gz'].sha256.length, 64);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
