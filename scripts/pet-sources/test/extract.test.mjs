import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPage, canFollow } from '../extract.mjs';

test('bagong list yields a merchant lead and a detail URL', () => {
  const html = `<ul class="media-list"><a class="clearfix" href="https://www.bagong.cn/s45/service?t=jiyang"><li class="jy-cell-con"><h4 class="media-heading">示例寄养馆</h4><span class="address">北京市朝阳区</span><div class="jiyang-type"><span class="price">80</span><span class="price_unit">元/天</span><span class="label">猫</span></div></li></a></ul>`;
  const result = extractPage('bagong', html, 'https://www.bagong.cn/jiyang/');
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.links, ['https://www.bagong.cn/s45/service?t=jiyang']);
  assert.equal(result.records[0].name, '示例寄养馆');
  assert.equal(result.records[0].price_text, '80元/天');
  assert.equal(result.records[0].verified, false);
});

test('a truncated listing address is a hint rather than a complete address', () => {
  const html = '<ul class="media-list"><a class="clearfix" href="https://www.bagong.cn/s45/service?t=jiyang"><li class="jy-cell-con"><h4 class="media-heading">示例寄养馆</h4><span class="address">北京市昌平区某路...</span></li></a></ul>';
  const row = extractPage('bagong', html, 'https://www.bagong.cn/jiyang/').records[0];
  assert.equal(row.address, null);
  assert.equal(row.address_hint, '北京市昌平区某路...');
});

test('achong listing records preserve third-party rating as unverified text', () => {
  const html = `<div class="hp-list"><div class="hp-hos"><div class="hp-hos-name">示例动物医院</div><span class="hp-score">5</span><span class="hp-src">百度地图</span><p class="hp-hos-addr">成都市锦江区一号</p><a href="tel:02812345678">电话</a></div></div><script type="application/ld+json">{"@type":"CollectionPage","mainEntity":{"itemListElement":[{"url":"https://achong.net/hospital/3"}]}}</script>`;
  const result = extractPage('achong', html, 'https://achong.net/hospital/chengdu');
  assert.equal(result.records[0].name, '示例动物医院');
  assert.equal(result.records[0].phone, '02812345678');
  assert.equal(result.records[0].rating_text, '5（百度地图）');
  assert.deepEqual(result.links, ['https://achong.net/hospital/3']);
});

test('achong listing joins a matching structured-data URL and strips the map pin', () => {
  const html = '<div class="hp-list"><div class="hp-hos"><div class="hp-hos-name">某某诊所</div><div class="hp-hos-addr">📍 成都市一号</div></div></div>'
    + '<script type="application/ld+json">' + JSON.stringify({ '@type': 'CollectionPage', mainEntity: { itemListElement: [{ name: '某某诊所', url: 'https://achong.net/hospital/3' }] } }) + '</script>';
  const row = extractPage('achong', html, 'https://achong.net/hospital/chengdu').records[0];
  assert.equal(row.merchant_url, 'https://achong.net/hospital/3');
  assert.equal(row.address, '成都市一号');
});

test('mengchong detail extracts contact fields without trusting the score', () => {
  const html = `<div class="pdtsr"><ul class="mphd"><h1>示例宠物馆</h1><li>地 址： 上海市浦东新区一号</li><li>电 话： 13800138000</li><li>营 业： 周一至周日 10:00-20:00</li></ul></div>`;
  const result = extractPage('mengchong', html, 'https://www.mengchong.cn/dianpu/8560.html');
  assert.equal(result.records[0].name, '示例宠物馆');
  assert.equal(result.records[0].address, '上海市浦东新区一号');
  assert.equal(result.records[0].phone, '13800138000');
  assert.equal(result.records[0].hours, '周一至周日 10:00-20:00');
  assert.equal(result.records[0].rating_text, null);
});

test('article metadata is retained without copying the article body', () => {
  const html = `<html><head><meta name="description" content="犬猫健康研究简介"><script type="application/ld+json">{"@type":"Article","headline":"一项研究","datePublished":"2026-01-02","author":{"name":"编辑甲"}}</script></head><body><h1>一项研究</h1><article>不应保存的长正文。</article></body></html>`;
  const result = extractPage('petdr', html, 'https://www.petdr.cn/medical/example.html');
  assert.equal(result.records[0].type, 'content_link');
  assert.equal(result.records[0].title, '一项研究');
  assert.equal(result.records[0].published_at, '2026-01-02');
  assert.equal(result.records[0].author, '编辑甲');
  assert.equal(JSON.stringify(result).includes('不应保存的长正文'), false);
});

test('apwol unclaimed profile keeps missing phone null', () => {
  const html = `<script type="application/ld+json">{"@graph":[{"@type":"LocalBusiness","name":"示例善终服务","address":{"streetAddress":"南京市某区"},"telephone":""}]}</script><main><p>未认领</p><a href="tel:">联系商家</a></main>`;
  const result = extractPage('apwol', html, 'https://www.apwol.com/city/nanjing/provider/detail/181');
  assert.equal(result.records[0].name, '示例善终服务');
  assert.equal(result.records[0].phone, null);
  assert.equal(result.records[0].claim_status, '未认领');
});

test('a placeholder business address stays a hint', () => {
  const html = '<script type="application/ld+json">' + JSON.stringify({ '@type': 'LocalBusiness', name: '示例商家', address: { streetAddress: '山东省淄博市（详细地址见工商登记）' } }) + '</script>';
  const row = extractPage('apwol', html, 'https://www.apwol.com/city/zibo/provider/detail/192').records[0];
  assert.equal(row.address, null);
  assert.equal(row.address_hint, '山东省淄博市（详细地址见工商登记）');
});

test('moguvet article list discovers only article links on the same host', () => {
  const html = `<a href="/article/1005739">犬猫知识</a><a href="https://other.example/article/1005739">外站</a><a href="/article/list/">栏目</a>`;
  const result = extractPage('moguvet', html, 'https://www.moguvet.com/article/list/');
  assert.deepEqual(result.links, ['https://www.moguvet.com/article/1005739']);
});

test('boqii keeps list titles without requesting blocked article pages', () => {
  const html = '<a href="/article/185398.html">狗狗洗护提示</a>';
  const result = extractPage('boqii', html, 'https://www.boqii.com/baike/dog/');
  assert.equal(result.records[0].title, '狗狗洗护提示');
  assert.equal(result.records[0].source_url, 'https://www.boqii.com/baike/dog/');
  assert.deepEqual(result.links, []);
});

test('boqii preserves same-host HTTP article URLs from the live list format', () => {
  const html = '<a href="http://www.boqii.com/article/185398.html">银狐犬为什么很少人养</a>';
  const result = extractPage('boqii', html, 'https://www.boqii.com/baike/dog/');
  assert.equal(result.records[0].target_url, 'http://www.boqii.com/article/185398.html');
  assert.deepEqual(result.links, []);
});

test('chongso homepage keeps only same-host question links', () => {
  const html = '<a href="/d/mrspdvxkb/">一个月的拉布拉多容易养活吗</a><a href="https://other.example/d/abc/">外站</a><a href="/new1/">视频</a>';
  const result = extractPage('chongso', html, 'https://m.chongso.com/');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].target_url, 'https://m.chongso.com/d/mrspdvxkb/');
  assert.deepEqual(result.links, ['https://m.chongso.com/d/mrspdvxkb/']);
});

test('chongso question detail captures title and summary without body', () => {
  const html = '<title>一个月的拉布拉多容易养活吗_宠搜网</title><meta name="description" content="摘要"><main>不保存正文</main>';
  const result = extractPage('chongso', html, 'https://m.chongso.com/d/mrspdvxkb/');
  assert.equal(result.records[0].title, '一个月的拉布拉多容易养活吗');
  assert.equal(result.records[0].description, '摘要');
  assert.equal(JSON.stringify(result).includes('不保存正文'), false);
});

test('chongwunet brand profile is promotional content, not a merchant lead', () => {
  const html = '<h1>示例品牌</h1><meta name="description" content="品牌介绍">';
  const row = extractPage('chongwunet', html, 'https://www.chongwunet.com/pp/brand').records[0];
  assert.equal(row.type, 'content_link');
  assert.equal(row.title, '示例品牌');
  assert.equal(row.name, null);
  assert.equal(row.source_level, 'promotional_content');
});

test('detail scope rejects external, query, and unexpected paths', () => {
  assert.equal(canFollow('achong', 'https://achong.net/hospital/3', 'https://achong.net'), true);
  assert.equal(canFollow('achong', 'https://achong.net/hospital/3?x=1', 'https://achong.net'), false);
  assert.equal(canFollow('achong', 'https://other.example/hospital/3', 'https://achong.net'), false);
  assert.equal(canFollow('achong', 'https://achong.net/api/hospital/3', 'https://achong.net'), false);
});
