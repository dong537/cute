import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportMerchants, inspectRun, runSync } from '../merchant-full.mjs';

async function withServer(handler, run) {
  let origin;
  const server = createServer((req, res) => handler(origin, req, res));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = 'http://127.0.0.1:' + server.address().port;
  try { await run(origin); }
  finally { await new Promise((done) => server.close(done)); }
}

function tempOut() { return mkdtempSync(join(tmpdir(), 'pet-merchant-full-')); }

test('Bagong trailing-slash variants share one resumed detail task', () => {
  const out = tempOut();
  try {
    const base = 'https://www.bagong.cn/s45';
    writeFileSync(join(out, 'queue.jsonl'), [
      { site: 'bagong', url: base, kind: 'detail' },
      { site: 'bagong', url: base + '/', kind: 'detail' },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    writeFileSync(join(out, 'pages.jsonl'), JSON.stringify({
      site: 'bagong', url: base + '/', kind: 'detail', status: 'done',
    }) + '\n');
    const status = inspectRun({ out }).bySite.bagong.details;
    assert.equal(status.done, 1);
    assert.equal(status.pending, 0);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('sitemap discoveries resume without refetching finished merchants', async () => {
  const out = tempOut();
  const hits = new Map();
  try {
    await withServer((origin, req, res) => {
      hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
      if (req.url === '/robots.txt') { res.end('User-agent: *\nAllow: /\n'); return; }
      if (req.url === '/sitemap.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end('<urlset><url><loc>' + origin + '/hospital/3</loc></url><url><loc>' + origin + '/hospital/3/</loc></url><url><loc>' + origin + '/hospital/4</loc></url></urlset>');
        return;
      }
      const id = req.url?.split('/').at(-1);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<script type="application/ld+json">' + JSON.stringify({ '@type': 'LocalBusiness', name: '医院' + id, address: { streetAddress: '成都市' + id + '号' } }) + '</script><h1>医院' + id + '</h1>');
    }, async (origin) => {
      const sources = { achong: origin + '/sitemap.xml' };
      await runSync({ out, sources, sites: ['achong'], phase: 'lists', maxRequests: 1 });
      assert.equal(inspectRun({ out, sources }).bySite.achong.details.pending, 2);
      await runSync({ out, sources, sites: ['achong'], phase: 'details', maxRequests: 1 });
      assert.equal(inspectRun({ out, sources }).bySite.achong.details.done, 1);
      await runSync({ out, sources, sites: ['achong'], phase: 'details', maxRequests: 2 });
      const status = inspectRun({ out, sources }).bySite.achong;
      assert.equal(status.details.done, 2);
      assert.equal(status.details.pending, 0);
      assert.equal(exportMerchants({ out }).merchants, 2);
    });
    assert.equal(hits.get('/sitemap.xml'), 1);
    assert.equal(hits.get('/hospital/3'), 1);
    assert.equal(hits.get('/hospital/4'), 1);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('Bagong seeds the verified Beijing and Shanghai lists on the configured origin', async () => {
  const out = tempOut();
  const hits = new Map();
  try {
    await withServer((origin, req, res) => {
      hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
      if (req.url === '/robots.txt') { res.end('User-agent: *\nAllow: /\n'); return; }
      const id = req.url === '/jiyang/shanghai/' ? 46 : 45;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<ul class="media-list"><a class="clearfix" href="/s' + id + '/service?t=jiyang"><h4 class="media-heading">商家' + id + '</h4></a></ul>');
    }, async (origin) => {
      const sources = { bagong: origin + '/jiyang/beijing/' };
      await runSync({ out, sources, sites: ['bagong'], phase: 'lists', maxRequests: 2 });
      const status = inspectRun({ out, sources }).bySite.bagong;
      assert.equal(status.lists.done, 2);
      assert.equal(status.details.pending, 2);
    });
    assert.equal(hits.get('/jiyang/beijing/'), 1);
    assert.equal(hits.get('/jiyang/shanghai/'), 1);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('HTTP 403 blocks the site before the next merchant detail', async () => {
  const out = tempOut();
  const hits = new Map();
  try {
    await withServer((origin, req, res) => {
      hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
      if (req.url === '/robots.txt') { res.end('User-agent: *\nAllow: /\n'); return; }
      if (req.url === '/sitemap.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end('<urlset><url><loc>' + origin + '/hospital/3</loc></url><url><loc>' + origin + '/hospital/4</loc></url></urlset>');
        return;
      }
      res.writeHead(403); res.end('Forbidden');
    }, async (origin) => {
      const sources = { achong: origin + '/sitemap.xml' };
      await runSync({ out, sources, sites: ['achong'], phase: 'lists', maxRequests: 1 });
      await runSync({ out, sources, sites: ['achong'], phase: 'details', maxRequests: 2 });
      const status = inspectRun({ out, sources }).bySite.achong;
      assert.equal(status.blocked, true);
      assert.equal(status.details.blocked, 1);
      assert.equal(status.details.pending, 1);
    });
    assert.equal(hits.get('/hospital/3'), 1);
    assert.equal(hits.get('/hospital/4') ?? 0, 0);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('robots denial blocks only the forbidden detail and continues allowed details', async () => {
  const out = tempOut();
  const hits = new Map();
  try {
    await withServer((origin, req, res) => {
      hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
      if (req.url === '/robots.txt') {
        res.end('User-agent: *\nDisallow: /hospital/3\nAllow: /\n');
        return;
      }
      if (req.url === '/sitemap.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end('<urlset><url><loc>' + origin + '/hospital/3</loc></url><url><loc>' + origin + '/hospital/4</loc></url></urlset>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>允许访问的医院</h1>');
    }, async (origin) => {
      const sources = { achong: origin + '/sitemap.xml' };
      await runSync({ out, sources, sites: ['achong'], phase: 'lists', maxRequests: 1 });
      await runSync({ out, sources, sites: ['achong'], phase: 'details', maxRequests: 2 });
      const status = inspectRun({ out, sources }).bySite.achong;
      assert.equal(status.blocked, false);
      assert.equal(status.details.blocked, 1);
      assert.equal(status.details.done, 1);
      await runSync({ out, sources, sites: ['achong'], phase: 'details', maxRequests: 2 });
    });
    assert.equal(hits.get('/hospital/3') ?? 0, 0);
    assert.equal(hits.get('/hospital/4'), 1);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('export merges list and detail while retaining a personal-provider flag', () => {
  const out = tempOut();
  try {
    const common = { source_site: 'bagong', merchant_url: 'https://www.bagong.cn/s3/', name: '家庭寄养', verified: false, license_verified: false };
    writeFileSync(join(out, 'observations.jsonl'), [
      JSON.stringify({ ...common, source_url: 'https://www.bagong.cn/jiyang/beijing/', address_hint: '北京市某区...', provider_type: 'personal_or_unverified' }),
      JSON.stringify({ ...common, source_url: common.merchant_url, description: '家庭寄养介绍', phone: '123456', public_fields: { service: '寄养' } }),
    ].join('\n') + '\n');
    const result = exportMerchants({ out });
    assert.equal(result.merchants, 1);
    const row = JSON.parse(readFileSync(result.jsonlPath, 'utf8').trim());
    assert.equal(row.provider_type, 'personal_or_unverified');
    assert.equal(row.description, null);
    assert.equal(row.phone, null);
    assert.equal(row.public_fields.service, '寄养');
    assert.equal(row.source_urls.length, 2);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('personal provider redacts residential details after list and detail merge', () => {
  const out = tempOut();
  try {
    writeFileSync(join(out, 'observations.jsonl'), [
      JSON.stringify({ source_site: 'bagong', source_url: 'https://www.bagong.cn/jiyang/beijing/',
        merchant_url: 'https://www.bagong.cn/s1755/service?t=jiyang', name: '家庭寄养',
        address: '北京市某住宅楼', public_fields: { pet_types: ['猫'] } }),
      JSON.stringify({ source_site: 'bagong', source_url: 'https://www.bagong.cn/s1755/',
        merchant_url: 'https://www.bagong.cn/s1755/', name: '家庭寄养',
        provider_type: 'personal_or_unverified', phone: '13800000000',
        description: '居家寄养介绍', public_fields: { description: '居家寄养介绍',
          image_urls: ['https://example.com/home.jpg'], detail_facts: [{ label: '营业时间', value: '全天' }] } }),
    ].join(String.fromCharCode(10)) + String.fromCharCode(10));
    const result = exportMerchants({ out });
    assert.equal(result.merchants, 1);
    const row = JSON.parse(readFileSync(result.jsonlPath, 'utf8').trim());
    assert.equal(row.provider_type, 'personal_or_unverified');
    assert.equal(row.address, null);
    assert.equal(row.address_hint, null);
    assert.equal(row.phone, null);
    assert.equal(row.description, null);
    assert.equal(row.public_fields.description, undefined);
    assert.equal(row.public_fields.image_urls, undefined);
    assert.equal(row.public_fields.detail_facts, undefined);
    assert.deepEqual(row.public_fields.pet_types, ['猫']);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('export canonicalizes Bagong service URLs and lets business detail correct a legacy list flag', () => {
  const out = tempOut();
  try {
    writeFileSync(join(out, 'observations.jsonl'), [
      JSON.stringify({ source_site: 'bagong', source_url: 'https://www.bagong.cn/jiyang/beijing/', merchant_url: 'https://www.bagong.cn/s45/service?t=jiyang', name: '宠物会馆', provider_type: 'personal_or_unverified' }),
      JSON.stringify({ source_site: 'bagong', source_url: 'https://www.bagong.cn/s45/', merchant_url: 'https://www.bagong.cn/s45/', name: '宠物会馆', provider_type: 'business', hours: '09:00-21:00' }),
    ].join('\n') + '\n');
    const result = exportMerchants({ out });
    assert.equal(result.merchants, 1);
    const row = JSON.parse(readFileSync(result.jsonlPath, 'utf8').trim());
    assert.equal(row.merchant_url, 'https://www.bagong.cn/s45/');
    assert.equal(row.provider_type, 'business');
    assert.equal(row.hours, '09:00-21:00');
    assert.equal(row.source_urls.length, 3);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('export joins trailing slash variants and keeps useful list fields and a real zero', () => {
  const out = tempOut();
  try {
    writeFileSync(join(out, 'observations.jsonl'), [
      JSON.stringify({ source_site: 'achong', source_url: 'https://achong.net/hospital/chengdu', merchant_url: 'https://achong.net/hospital/3/', name: '示例医院', public_fields: { categories: ['动物诊所'] } }),
      JSON.stringify({ source_site: 'achong', source_url: 'https://achong.net/hospital/3', merchant_url: 'https://achong.net/hospital/3', name: '示例医院', public_fields: { categories: [], review_count: 0 } }),
    ].join('\n') + '\n');
    const result = exportMerchants({ out });
    assert.equal(result.merchants, 1);
    const row = JSON.parse(readFileSync(result.jsonlPath, 'utf8').trim());
    assert.equal(row.merchant_url, 'https://achong.net/hospital/3');
    assert.deepEqual(row.public_fields.categories, ['动物诊所']);
    assert.equal(row.public_fields.review_count, 0);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('export corrects legacy Mengchong schedules mislabeled as phone numbers', () => {
  const out = tempOut();
  try {
    const raw = { source_site: 'mengchong', source_url: 'https://www.mengchong.cn/dianpu/10076.html',
      merchant_url: 'https://www.mengchong.cn/dianpu/10076.html', name: '小狗在家宠物寄养',
      phone: '周一至周日09:00-21:00', public_fields: { categories: ['寄养'] } };
    writeFileSync(join(out, 'observations.jsonl'), JSON.stringify(raw) + String.fromCharCode(10));
    const result = exportMerchants({ out });
    const row = JSON.parse(readFileSync(result.jsonlPath, 'utf8').trim());
    assert.equal(row.phone, null);
    assert.equal(row.public_fields.phone_label_raw, raw.phone);
    assert.deepEqual(row.public_fields.categories, ['寄养']);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('an active output lock rejects a second sync before network access', async () => {
  const out = tempOut();
  try {
    writeFileSync(join(out, 'sync.lock'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + '\n');
    await assert.rejects(runSync({ out, sites: [], sources: {}, maxRequests: 1 }), /already running/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('a damaged final journal line after UTF-8 text is repairable on resume', async () => {
  const out = tempOut();
  try {
    const good = JSON.stringify({ site: 'achong', url: 'https://achong.net/sitemap.xml', kind: 'list', label: '宠物医院' });
    writeFileSync(join(out, 'queue.jsonl'), good + '\n{"site":');
    assert.doesNotThrow(() => inspectRun({ out, sources: {} }));
    await runSync({ out, sites: [], sources: {}, maxRequests: 1 });
    assert.equal(readFileSync(join(out, 'queue.jsonl'), 'utf8'), good + '\n');
    assert.equal(readdirSync(out).some((name) => name.startsWith('queue.jsonl.recovered-tail-')), true);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('refresh-before refetches only older done details and exports newer facts', async () => {
  const out = tempOut();
  const hits = new Map();
  let phone = '02811111111';
  let hours = 'Mo-Su 09:00-20:00';
  try {
    await withServer((origin, req, res) => {
      hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
      if (req.url === '/robots.txt') { res.end('User-agent: *\nAllow: /\n'); return; }
      if (req.url === '/sitemap.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end('<urlset><url><loc>' + origin + '/hospital/3</loc></url></urlset>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<script type="application/ld+json">' + JSON.stringify({
        '@type': 'LocalBusiness', name: '示例医院', telephone: phone, openingHours: hours,
      }) + '</script>');
    }, async (origin) => {
      const sources = { achong: origin + '/sitemap.xml' };
      await runSync({ out, sources, sites: ['achong'], phase: 'lists', maxRequests: 1 });
      await runSync({ out, sources, sites: ['achong'], phase: 'details', maxRequests: 1 });
      assert.equal((await runSync({ out, sources, sites: ['achong'], phase: 'all', maxRequests: 3 })).requests, 0);
      phone = '02822222222';
      hours = 'Mo-Su 10:00-21:00';
      assert.equal((await runSync({
        out, sources, sites: ['achong'], phase: 'all', maxRequests: 3,
        refreshBefore: '2000-01-01T00:00:00Z',
      })).requests, 0);
      const refreshed = await runSync({
        out, sources, sites: ['achong'], phase: 'details', maxRequests: 3,
        refreshBefore: new Date(Date.now() + 60_000).toISOString(),
      });
      assert.equal(refreshed.requests, 1);
      assert.equal(hits.get('/sitemap.xml'), 1);
      assert.equal(hits.get('/hospital/3'), 2);
      assert.equal(readFileSync(join(out, 'observations.jsonl'), 'utf8').trim().split('\n').length, 2);
      const exported = exportMerchants({ out });
      const row = JSON.parse(readFileSync(exported.jsonlPath, 'utf8').trim());
      assert.equal(row.phone, '02822222222');
      assert.equal(row.public_fields.openingHours, 'Mo-Su 10:00-21:00');
    });
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('refresh-before in lists phase revisits an old sitemap to discover new URLs', async () => {
  const out = tempOut();
  const hits = new Map();
  let detailIds = [3];
  try {
    await withServer((origin, req, res) => {
      hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
      if (req.url === '/robots.txt') { res.end('User-agent: *\nAllow: /\n'); return; }
      if (req.url === '/sitemap.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end('<urlset>' + detailIds.map((id) => '<url><loc>' + origin + '/hospital/' + id + '</loc></url>').join('') + '</urlset>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>不应抓取详情</h1>');
    }, async (origin) => {
      const sources = { achong: origin + '/sitemap.xml' };
      await runSync({ out, sources, sites: ['achong'], phase: 'lists', maxRequests: 1 });
      detailIds = [3, 4];
      assert.equal((await runSync({ out, sources, sites: ['achong'], phase: 'lists', maxRequests: 3 })).requests, 0);
      const refreshed = await runSync({
        out, sources, sites: ['achong'], phase: 'lists', maxRequests: 3,
        refreshBefore: new Date(Date.now() + 60_000).toISOString(),
      });
      assert.equal(refreshed.requests, 1);
      const status = inspectRun({ out, sources }).bySite.achong;
      assert.equal(status.lists.done, 1);
      assert.equal(status.details.pending, 2);
    });
    assert.equal(hits.get('/sitemap.xml'), 2);
    assert.equal(hits.get('/hospital/3') ?? 0, 0);
    assert.equal(hits.get('/hospital/4') ?? 0, 0);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('refresh-before rejects a timestamp without an explicit timezone', async () => {
  const out = tempOut();
  try {
    await assert.rejects(
      runSync({ out, sites: [], sources: {}, refreshBefore: '2026-11-25T12:00:00' }),
      /ISO timestamp with timezone/,
    );
  } finally { rmSync(out, { recursive: true, force: true }); }
});
