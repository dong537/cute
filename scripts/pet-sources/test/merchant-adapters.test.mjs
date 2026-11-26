import test from 'node:test';
import assert from 'node:assert/strict';
import { MERCHANT_SOURCES, classifyMerchantUrl, parseMerchantPage } from '../merchant-adapters.mjs';

test('merchant seeds and URL classifications cover only verified public routes', () => {
  assert.deepEqual(MERCHANT_SOURCES, {
    bagong: 'https://www.bagong.cn/jiyang/beijing/',
    uchongs: 'https://www.uchongs.com/shop/s0n1',
    achong: 'https://achong.net/sitemap.xml',
    mengchong: 'https://www.mengchong.cn/sitemap.xml',
    apwol: 'https://www.apwol.com/sitemap_index.xml',
  });
  assert.equal(classifyMerchantUrl('bagong', 'https://www.bagong.cn/jiyang/beijing/?p=46'), 'list');
  assert.equal(classifyMerchantUrl('bagong', 'https://www.bagong.cn/s45/service?t=jiyang'), 'detail');
  assert.equal(classifyMerchantUrl('bagong', 'https://www.bagong.cn/s3839/'), 'detail');
  assert.equal(classifyMerchantUrl('bagong', 'https://www.bagong.cn/sj/beijing/?p=2'), 'list');
  assert.equal(classifyMerchantUrl('bagong', 'https://www.bagong.cn/s224683'), 'detail');
  assert.equal(classifyMerchantUrl('uchongs', 'https://www.uchongs.com/shop/s0n1p2'), 'list');
  assert.equal(classifyMerchantUrl('uchongs', 'https://www.uchongs.com/shop/s0n3'), 'list');
  assert.equal(classifyMerchantUrl('uchongs', 'https://www.uchongs.com/shop/d20593'), 'detail');
  assert.equal(classifyMerchantUrl('uchongs', 'https://www.uchongs.com/shop/s310000n3'), null);
  assert.equal(classifyMerchantUrl('bagong', 'https://www.bagong.cn/jiyang/beijing/?type=personal'), null);
  assert.equal(classifyMerchantUrl('achong', 'https://achong.net/hospital/chengdu/page/154'), 'list');
  assert.equal(classifyMerchantUrl('achong', 'https://achong.net/hospital/900350'), 'detail');
  assert.equal(classifyMerchantUrl('achong', 'https://achong.net/hospital/chengdu?page=2'), null);
  assert.equal(classifyMerchantUrl('mengchong', 'https://www.mengchong.cn/dianpu/10076.html'), 'detail');
  assert.equal(classifyMerchantUrl('mengchong', 'https://www.mengchong.cn/yiyuan/8448.html'), 'detail');
  assert.equal(classifyMerchantUrl('mengchong', 'https://www.mengchong.cn/chongwu/8448.html'), 'detail');
  assert.equal(classifyMerchantUrl('mengchong', 'https://www.mengchong.cn/d/file/1.jpg'), null);
  assert.equal(classifyMerchantUrl('apwol', 'https://www.apwol.com/sitemap_provider.xml'), 'list');
  assert.equal(classifyMerchantUrl('apwol', 'https://www.apwol.com/provider/list/?page=17'), 'list');
  assert.equal(classifyMerchantUrl('apwol', 'https://www.apwol.com/city/zibo/provider/detail/192'), 'detail');
  assert.equal(classifyMerchantUrl('apwol', 'https://www.apwol.com/api/providers'), null);
});

test('bagong city shop list discovers businesses, services and pagination', () => {
  const html = '<ul class="media-list"><li class="media" data-link="/s224683">'
    + '<h4 class="media-heading"><a class="shop_name" href="/s224683">Sample Pet Shop</a></h4>'
    + '<div class="desc-cell"><i class="fa fa-clock-o"></i>10:00 - 20:00</div>'
    + '<div class="desc-cell"><i class="fa fa-map-marker"></i>Beijing Road 1</div>'
    + '<div class="shop-tags"><span>寄养</span><span>美容</span></div></li></ul>'
    + '<a href="/sj/beijing">same page without trailing slash</a>'
    + '<a href="/sj/beijing/?p=1">first page again</a>'
    + '<a href="/sj/beijing/?p=2">2</a>';
  const result = parseMerchantPage('bagong', html, 'https://www.bagong.cn/sj/beijing/');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].merchant_url, 'https://www.bagong.cn/s224683/');
  assert.equal(result.records[0].provider_type, 'business');
  assert.equal(result.records[0].address, 'Beijing Road 1');
  assert.equal(result.records[0].hours, '10:00 - 20:00');
  assert.deepEqual(result.records[0].public_fields.service_tags, ['寄养', '美容']);
  assert.deepEqual(result.listUrls, ['https://www.bagong.cn/sj/beijing/?p=2']);
  assert.deepEqual(result.detailUrls, ['https://www.bagong.cn/s224683/']);
});

test('uchongs public list discovers shop details without province duplicate lists', () => {
  const html = '<div class="slbd"><div class="svbd"><a href="/shop/d20593">'
    + '<dl><dd><b>Sample Hospital</b><u>宠物医院 评分：4.8 / 5</u>'
    + '<i>上海市 普陀区</i><p>铜川路516号</p></dd></dl></a></div></div>'
    + '<a href="/shop/s0n3p2">2</a><a href="/shop/s310000n3">上海</a>';
  const result = parseMerchantPage('uchongs', html, 'https://www.uchongs.com/shop/s0n3');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].address, '铜川路516号');
  assert.equal(result.records[0].rating_text, '4.8 / 5');
  assert.deepEqual(result.detailUrls, ['https://www.uchongs.com/shop/d20593']);
  assert.deepEqual(result.listUrls, ['https://www.uchongs.com/shop/s0n3p2']);
});

test('uchongs detail keeps visible facts but not coded phone or reviews', () => {
  const html = '<div class="pdtsr"><ul class="mphd mphd1">'
    + '<li><h1>Sample Hospital</h1><u class="dpjj">医院</u></li>'
    + '<li><i>地 区：</i>上海市 普陀区</li><li><i>地 址：</i>铜川路516号</li>'
    + '<li><i>营 业：</i>周一至周日</li>'
    + '<li><i>电 话：</i><script>teledh("coded")</script></li>'
    + '</ul></div><div class="review">Private reviewer text</div>';
  const result = parseMerchantPage('uchongs', html, 'https://www.uchongs.com/shop/d20593');
  assert.equal(result.records[0].address, '铜川路516号');
  assert.equal(result.records[0].hours, '周一至周日');
  assert.equal(result.records[0].phone, null);
  assert.equal(JSON.stringify(result.records[0]).includes('Private reviewer text'), false);
});

test('empty public shop lists fail visibly instead of closing a crawl branch', () => {
  const maintenance = '<html><title>Service maintenance</title><body>Try again later</body></html>';
  for (const [site, url] of [
    ['bagong', 'https://www.bagong.cn/sj/beijing/?p=2'],
    ['uchongs', 'https://www.uchongs.com/shop/s0n3p2'],
  ]) {
    assert.throws(() => parseMerchantPage(site, maintenance, url), (error) => error.code === 'PARSE_EMPTY');
  }
});

test('provider sitemap index follows only its provider child', () => {
  const xml = '<sitemapindex><sitemap><loc>https://www.apwol.com/sitemap_article.xml</loc></sitemap>'
    + '<sitemap><loc>https://www.apwol.com/sitemap_provider.xml</loc></sitemap>'
    + '<sitemap><loc>https://other.example/sitemap_provider.xml</loc></sitemap></sitemapindex>';
  const result = parseMerchantPage('apwol', xml, 'https://www.apwol.com/sitemap_index.xml');
  assert.deepEqual(result.listUrls, ['https://www.apwol.com/sitemap_provider.xml']);
  assert.deepEqual(result.detailUrls, []);
  assert.deepEqual(result.records, []);
});

test('sitemaps expose all merchant URLs without a 25 or 50 URL cap', () => {
  const xml = '<urlset>' + Array.from({ length: 60 }, (_, i) =>
    '<url><loc>https://www.mengchong.cn/dianpu/' + (10000 + i) + '.html</loc></url>').join('')
    + '<url><loc>https://www.mengchong.cn/dianpu/10000.html</loc></url>'
    + '<url><loc>https://other.example/dianpu/1.html</loc></url>'
    + '<url><loc>https://www.mengchong.cn/gougoubaike/1.html</loc></url></urlset>';
  const result = parseMerchantPage('mengchong', xml, MERCHANT_SOURCES.mengchong);
  assert.equal(result.detailUrls.length, 60);
  assert.equal(result.detailUrls[0], 'https://www.mengchong.cn/dianpu/10000.html');
  assert.equal(result.detailUrls.at(-1), 'https://www.mengchong.cn/dianpu/10059.html');
});

test('mengchong sitemap includes shops, pet hospitals, and pet merchants', () => {
  const xml = '<urlset><url><loc>https://www.mengchong.cn/dianpu/8560.html</loc></url>'
    + '<url><loc>https://www.mengchong.cn/yiyuan/8448.html</loc></url>'
    + '<url><loc>https://www.mengchong.cn/chongwu/8448.html</loc></url>'
    + '<url><loc>https://www.mengchong.cn/gougoubaike/1.html</loc></url></urlset>';
  const result = parseMerchantPage('mengchong', xml, MERCHANT_SOURCES.mengchong);
  assert.deepEqual(result.detailUrls, [
    'https://www.mengchong.cn/dianpu/8560.html',
    'https://www.mengchong.cn/yiyuan/8448.html',
    'https://www.mengchong.cn/chongwu/8448.html',
  ]);
});

test('hospital sitemap exposes clean detail and city list paths', () => {
  const xml = '<urlset><url><loc>https://achong.net/hospital/3</loc></url>'
    + '<url><loc>https://achong.net/hospital/chengdu</loc></url>'
    + '<url><loc>https://achong.net/hospital/chengdu/jinjiang</loc></url>'
    + '<url><loc>https://achong.net/hospital/3?from=sitemap</loc></url></urlset>';
  const result = parseMerchantPage('achong', xml, MERCHANT_SOURCES.achong);
  assert.deepEqual(result.detailUrls, ['https://achong.net/hospital/3']);
  assert.deepEqual(result.listUrls, ['https://achong.net/hospital/chengdu', 'https://achong.net/hospital/chengdu/jinjiang']);
});

test('bagong list preserves public price but marks home boarding as unverified', () => {
  const html = '<ul class="media-list">'
    + '<a class="clearfix" href="/s45/service?t=jiyang"><li class="jy-cell-con"><h4 class="media-heading">宠爱佳宠物会馆</h4><div class="address">北京市昌平区某路...</div><div class="jiyang-type"><span class="label">狗</span><span class="label">猫</span><span class="price">40</span><span class="price_unit">/天</span></div></li></a>'
    + '<a class="clearfix" href="/s3839/"><li class="jy-cell-con"><h4 class="media-heading">家庭式寄养者</h4><div class="address">北京市昌平区住宅楼</div><div class="jiyang-type"><span class="price">25</span><span class="price_unit">/天</span></div></li></a>'
    + '</ul><div class="pagination"><a href="/jiyang/beijing/?p=2">2</a><a href="/jiyang/beijing/?p=2">下一页</a></div>';
  const result = parseMerchantPage('bagong', html, MERCHANT_SOURCES.bagong);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].price_text, '40/天');
  assert.equal(result.records[0].merchant_url, 'https://www.bagong.cn/s45/');
  assert.equal(result.records[0].address, null);
  assert.equal(result.records[0].address_hint, '北京市昌平区某路...');
  assert.deepEqual(result.records[0].public_fields.pet_types, ['狗', '猫']);
  assert.equal(result.records[1].provider_type, 'personal_or_unverified');
  assert.equal(result.records[1].address, null);
  assert.deepEqual(result.listUrls, ['https://www.bagong.cn/jiyang/beijing/?p=2']);
  assert.deepEqual(result.detailUrls, [
    'https://www.bagong.cn/s45/service?t=jiyang', 'https://www.bagong.cn/s3839/',
  ]);
});

test('bagong personal detail never decodes hidden phone or residential address', () => {
  const html = '<title>家庭寄养者_北京市</title><meta name="description" content="家庭式寄养，可提供全天视频在线">'
    + '<h1>家庭寄养者</h1><span class="encrypted-phone" data-tel="MTM4MDAxMzgwMDA">点击查看电话</span>'
    + '<span class="addr"><span class="addr-char">住</span><span class="addr-fake">5</span><span class="addr-char">宅</span></span>'
    + '<div class="shopdetail-page"><div id="mobile-banner"><div class="swiper-slide"><img src="/private-home.jpg"></div></div></div>';
  const result = parseMerchantPage('bagong', html, 'https://www.bagong.cn/s3839/');
  assert.equal(result.records[0].name, '家庭寄养者');
  assert.equal(result.records[0].provider_type, 'personal_or_unverified');
  assert.equal(result.records[0].phone, null);
  assert.equal(result.records[0].address, null);
  assert.equal(result.records[0].public_fields.description, '家庭式寄养，可提供全天视频在线');
  assert.deepEqual(result.records[0].public_fields.image_urls, []);
});

test('bagong unknown homepage omits gallery until the provider is clearly commercial', () => {
  const html = '<h1>小白照护</h1><div class="shopdetail-page"><div id="mobile-banner">'
    + '<div class="swiper-slide"><img src="/home.jpg"></div></div></div>';
  const row = parseMerchantPage('bagong', html, 'https://www.bagong.cn/s999/').records[0];
  assert.equal(row.provider_type, null);
  assert.deepEqual(row.public_fields.image_urls, []);
});

test('achong listing joins structured detail URLs by matching names and follows clean pagination', () => {
  const itemList = { '@type': 'CollectionPage', mainEntity: { itemListElement: [
    { name: '宠益宠物诊所', url: 'https://achong.net/hospital/3' },
    { name: '蓝净动物诊所', url: 'https://achong.net/hospital/5' },
  ] } };
  const html = '<script type="application/ld+json">' + JSON.stringify(itemList) + '</script>'
    + '<div class="hp-list"><div class="hp-hos"><span class="hp-hos-name">宠益宠物诊所</span><b class="hp-score">5</b><span class="hp-src">百度地图</span><div class="hp-hos-addr">📍 成都市锦江区一号</div><a href="tel:02812345678">电话</a></div>'
    + '<div class="hp-hos"><span class="hp-hos-name">蓝净动物诊所</span></div></div>'
    + '<a href="/hospital/chengdu/page/2">下一页</a><a href="/hospital/chengdu?page=2">错误参数页</a>';
  const result = parseMerchantPage('achong', html, 'https://achong.net/hospital/chengdu');
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].merchant_url, 'https://achong.net/hospital/3');
  assert.equal(result.records[0].rating_text, '5（百度地图）');
  assert.equal(result.records[0].address, '成都市锦江区一号');
  assert.deepEqual(result.detailUrls, ['https://achong.net/hospital/3', 'https://achong.net/hospital/5']);
  assert.deepEqual(result.listUrls, ['https://achong.net/hospital/chengdu/page/2']);
});

test('parser accepts local integration origins but rejects links leaving that origin', () => {
  const url = 'http://127.0.0.1:49731/hospital/chengdu';
  const html = '<script type="application/ld+json">'
    + JSON.stringify({ '@type': 'CollectionPage', mainEntity: { itemListElement: [
      { name: '本地医院', url: 'http://127.0.0.1:49731/hospital/3' },
      { name: '外站医院', url: 'https://achong.net/hospital/4' },
    ] } }) + '</script>'
    + '<div class="hp-list"><div class="hp-hos"><span class="hp-hos-name">本地医院</span></div></div>';
  const result = parseMerchantPage('achong', html, url);
  assert.deepEqual(result.detailUrls, ['http://127.0.0.1:49731/hospital/3']);
  assert.equal(result.records[0].merchant_url, 'http://127.0.0.1:49731/hospital/3');
});

test('achong skips a card whose name cannot be joined to a public detail URL', () => {
  const html = '<script type="application/ld+json">'
    + JSON.stringify({ '@type': 'CollectionPage', mainEntity: { itemListElement: [
      { name: '医院甲', url: 'https://achong.net/hospital/3' },
    ] } }) + '</script>'
    + '<div class="hp-list"><div class="hp-hos"><span class="hp-hos-name">医院乙</span></div></div>';
  const result = parseMerchantPage('achong', html, 'https://achong.net/hospital/chengdu');
  assert.deepEqual(result.detailUrls, ['https://achong.net/hospital/3']);
  assert.deepEqual(result.records, []);
});

test('broken JSON-LD warns and falls back to an actual HTML hospital link', () => {
  const html = '<script type="application/ld+json">{"@type":</script>'
    + '<div class="hp-list"><div class="hp-hos"><span class="hp-hos-name">医院甲</span>'
    + '<a href="/hospital/3">查看详情</a></div></div>';
  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(message);
  let result;
  try { result = parseMerchantPage('achong', html, 'https://achong.net/hospital/chengdu'); }
  finally { console.warn = warn; }
  assert.equal(result.records[0].merchant_url, 'https://achong.net/hospital/3');
  assert.deepEqual(result.detailUrls, ['https://achong.net/hospital/3']);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Malformed JSON-LD/);
  assert.deepEqual(warnings, result.warnings);
});

test('broken optional JSON-LD does not hide an HTML provider card', () => {
  const html = '<script type="application/ld+json">{bad</script>'
    + '<article class="pm-provider-card"><h3><a href="/city/zibo/provider/detail/192">示例服务商</a></h3></article>';
  const warn = console.warn;
  console.warn = () => {};
  let result;
  try { result = parseMerchantPage('apwol', html, 'https://www.apwol.com/provider/list/'); }
  finally { console.warn = warn; }
  assert.equal(result.records[0].name, '示例服务商');
  assert.deepEqual(result.detailUrls, ['https://www.apwol.com/city/zibo/provider/detail/192']);
  assert.equal(result.warnings.length, 1);
});

test('recognized detail with no merchant identity raises a parse error', () => {
  assert.throws(
    () => parseMerchantPage('achong', '<html><body>页面暂不可用</body></html>', 'https://achong.net/hospital/3'),
    (error) => error.code === 'PARSE_EMPTY',
  );
  assert.throws(
    () => parseMerchantPage('apwol', '<h1>页面暂不可用</h1>', 'https://www.apwol.com/city/zibo/provider/detail/192'),
    (error) => error.code === 'PARSE_EMPTY',
  );
});

test('missing third-party review count remains unknown rather than zero', () => {
  const html = '<script type="application/ld+json">'
    + JSON.stringify({ '@type': 'LocalBusiness', name: '示例医院',
      aggregateRating: { ratingValue: 5, reviewCount: null } }) + '</script>';
  const row = parseMerchantPage('achong', html, 'https://achong.net/hospital/3').records[0];
  assert.equal(row.public_fields.review_count, null);
});

test('bagong business detail keeps visible hours and skips hidden contacts', () => {
  const html = '<h1>宠爱佳宠物会馆</h1><div class="linkus"><ul><li><span class="fa fa-clock-o"></span>09:30 - 21:00<span class="yingye">休业中</span></li></ul></div>'
    + '<span class="encrypted-phone" data-tel="MDEwLTYwNzg2MjEy">点击查看电话</span>'
    + '<span class="addr"><span class="addr-char">北</span><span class="addr-fake">3</span></span>'
    + '<div class="shopdetail-page"><div id="mobile-banner"><div class="swiper-slide"><img src="http://i1.bagong.cn/s-45/shop.jpg"></div></div></div>'
    + '<img src="/jic/i/weidian/menu_contact_75.png">';
  const result = parseMerchantPage('bagong', html, 'https://www.bagong.cn/s45/');
  assert.equal(result.records[0].hours, '09:30 - 21:00');
  assert.equal(result.records[0].phone, null);
  assert.equal(result.records[0].address, null);
  assert.equal(result.records[0].provider_type, 'business');
  assert.deepEqual(result.records[0].public_fields.image_urls, ['http://i1.bagong.cn/s-45/shop.jpg']);
});

test('bagong booking page discovers its linked shop homepage and uses one merchant key', () => {
  const html = '<a class="nav-brand" href="/s45/"><h1>宠爱佳宠物会馆</h1></a>';
  const result = parseMerchantPage('bagong', html, 'https://www.bagong.cn/s45/service?t=jiyang');
  assert.equal(result.records[0].merchant_url, 'https://www.bagong.cn/s45/');
  assert.equal(result.records[0].source_url, 'https://www.bagong.cn/s45/service?t=jiyang');
  assert.equal(result.records[0].provider_type, 'business');
  assert.deepEqual(result.detailUrls, ['https://www.bagong.cn/s45/']);
});

test('achong detail preserves sourced rating, visible hours, cover, and service facts', () => {
  const business = { '@type': 'LocalBusiness', name: '宠益宠物诊所', image: 'https://cdn.example/cover.jpg',
    address: { streetAddress: '成都市锦江区一号' }, telephone: '02812345678',
    aggregateRating: { ratingValue: 5, reviewCount: 3 } };
  const html = '<script type="application/ld+json">' + JSON.stringify(business) + '</script>'
    + '<div class="hd-hero"><span class="hd-src">来源 百度地图</span><span class="hd-tag">动物诊所</span>'
    + '<p class="hd-loc-line">🕒09:00-20:15</p></div>'
    + '<div class="hd-lic-row"><span>平台核验</span><b>待核验 / 源公示</b></div>'
    + '<div class="hd-lic-row"><span>经营范围</span><b>宠物诊疗服务、宠物美容服务</b></div>'
    + '<div class="hd-others"><img src="https://cdn.example/other.jpg"></div>';
  const row = parseMerchantPage('achong', html, 'https://achong.net/hospital/3').records[0];
  assert.equal(row.hours, '09:00-20:15');
  assert.equal(row.rating_text, '5（百度地图）');
  assert.equal(row.public_fields.rating_source, '百度地图');
  assert.equal(row.public_fields.review_count, 3);
  assert.deepEqual(row.public_fields.image_urls, ['https://cdn.example/cover.jpg']);
  assert.deepEqual(row.public_fields.categories, ['动物诊所']);
  assert.equal(row.public_fields.platform_verification, '待核验 / 源公示');
  assert.equal(row.public_fields.business_scope, '宠物诊疗服务、宠物美容服务');
});

test('present JSON-LD business attributes retain source values and units', () => {
  const geo = { '@type': 'GeoCoordinates', latitude: '30.67', longitude: '104.06' };
  const business = { '@type': 'LocalBusiness', name: '示例医院',
    url: 'https://achong.net/hospital/3', email: 'info@example.com',
    sameAs: ['https://example.com/profile'], paymentAccepted: '现金、银行卡',
    openingHours: 'Mo-Su 09:00-21:00', priceRange: '¥100-500', geo };
  const html = '<script type="application/ld+json">' + JSON.stringify(business) + '</script>';
  const fields = parseMerchantPage('achong', html, 'https://achong.net/hospital/3').records[0].public_fields;
  assert.equal(fields.url, business.url);
  assert.equal(fields.email, business.email);
  assert.deepEqual(fields.sameAs, business.sameAs);
  assert.equal(fields.paymentAccepted, business.paymentAccepted);
  assert.equal(fields.openingHours, business.openingHours);
  assert.equal(fields.priceRange, business.priceRange);
  assert.deepEqual(fields.geo, geo);
});

test('mengchong detail extracts visible contact and categories without reusing rating', () => {
  const html = '<div class="pdtsl"><div class="pbimg"><img src="/d/file/2022/12-04/shop.jpg"></div></div>'
    + '<div class="pdtsr"><ul class="mphd"><li><h1>LIEBE乐彼宠物馆</h1><u class="dpjj"><a href="/tag/chongwumeirong/">宠物美容</a></u></li>'
    + '<li><i>评 分： </i>4</li><li><i>地 区： </i>上海市 浦东新区</li><li><i>地 址： </i>源深路614号</li>'
    + '<li><i>电 话： </i>13120608920</li><li><i>营 业： </i>周一至周日 10:00-20:00</li></ul></div>'
    + '<div class="svbd"><img src="/d/file/other.jpg"></div>';
  const result = parseMerchantPage('mengchong', html, 'https://www.mengchong.cn/dianpu/8560.html');
  assert.equal(result.records[0].name, 'LIEBE乐彼宠物馆');
  assert.equal(result.records[0].phone, '13120608920');
  assert.equal(result.records[0].hours, '周一至周日 10:00-20:00');
  assert.equal(result.records[0].rating_text, null);
  assert.deepEqual(result.records[0].public_fields.categories, ['宠物美容']);
  assert.equal(result.records[0].public_fields.region, '上海市 浦东新区');
  assert.deepEqual(result.records[0].public_fields.image_urls, ['https://www.mengchong.cn/d/file/2022/12-04/shop.jpg']);
});

test('mengchong does not present a schedule mislabeled as a phone number', () => {
  const html = '<div class="pdtsr"><ul class="mphd"><li><h1>小狗在家宠物寄养</h1></li>'
    + '<li><i>电 话： </i>周一至周日09:00-21:00</li><li><i>营 业： </i></li></ul></div>';
  const row = parseMerchantPage('mengchong', html, 'https://www.mengchong.cn/dianpu/10076.html').records[0];
  assert.equal(row.phone, null);
  assert.equal(row.public_fields.phone_label_raw, '周一至周日09:00-21:00');
});

test('apwol detail preserves missing fields and unclaimed status', () => {
  const jsonld = { '@graph': [{ '@type': 'LocalBusiness', name: '淄博齐城动物无害化处理有限公司',
    address: { streetAddress: '山东省淄博市（详细地址见工商登记）' },
    areaServed: '淄博市', telephone: '', geo: { latitude: 0, longitude: 0 },
    description: '平台未核验其经营资质' }] };
  const html = '<script type="application/ld+json">' + JSON.stringify(jsonld) + '</script>'
    + '<main><h1>淄博齐城动物无害化处理有限公司</h1><span class="pm-pstatus">未认领</span>'
    + '<p class="pm-provider-card__tags"><span class="pm-tag">无害化处理</span><span class="pm-tag pm-tag--city">淄博市</span>'
    + '<span class="pm-rank-detail"><a class="pm-tag" href="/rank/zibo/">查看榜单</a></span></p><h2>用户评价（0）</h2>'
    + '<a href="tel:">联系商家</a></main>';
  const result = parseMerchantPage('apwol', html, 'https://www.apwol.com/city/zibo/provider/detail/192');
  assert.equal(result.records[0].name, '淄博齐城动物无害化处理有限公司');
  assert.equal(result.records[0].phone, null);
  assert.equal(result.records[0].address, null);
  assert.equal(result.records[0].address_hint, '山东省淄博市（详细地址见工商登记）');
  assert.equal(result.records[0].claim_status, '未认领');
  assert.equal(result.records[0].public_fields.area_served, '淄博市');
  assert.deepEqual(result.records[0].public_fields.service_tags, ['无害化处理']);
  assert.equal(result.records[0].public_fields.review_count, 0);
  assert.deepEqual(result.records[0].public_fields.image_urls, []);
  assert.equal(result.records[0].public_fields.geo, undefined);
  assert.equal(result.records[0].verified, false);
  assert.equal(result.records[0].license_verified, false);
});

test('achong detail keeps all visible fact rows in order and under their page sections', () => {
  const html = '<h1>示例动物诊所</h1>'
    + '<section class="hd-card"><div class="hd-sec-head"><h2>🏥 医院档案</h2></div>'
    + '<div class="hd-dblock"><div class="hd-dt-title">📋 资质公示</div>'
    + '<div class="hd-lic-row"><span>平台核验</span><b>待核验 / 源公示</b></div></div></section>'
    + '<section class="hd-card"><div class="hd-sec-head"><h2>📎 数据来源</h2></div>'
    + '<div class="hd-src-block"><div class="hd-dt-title hd-dt-title-row"><span>工商信息</span>'
    + '<span class="hsc-badge"><span class="hsc-label">工商认证</span></span></div>'
    + '<div class="hd-lic-row"><span>企业名称</span><b>示例动物诊所</b></div>'
    + '<div class="hd-lic-row"><span>法人</span><b>王某</b></div>'
    + '<div class="hd-lic-row"><span>统一社会信用代码</span><b>91350000EXAMPLE</b></div>'
    + '<div class="hd-lic-row"><span>登记状态</span><b>开业</b></div>'
    + '<div class="hd-lic-row"><span>成立日期</span><b>2020-01-01</b></div>'
    + '<div class="hd-lic-row"><span>经营范围</span><b>宠物诊疗服务</b></div></div>'
    + '<div class="hd-src-block"><div class="hd-dt-title hd-dt-title-row"><span>地图平台</span>'
    + '<span class="hsc-badge"><span class="hsc-label">高德地图认证</span></span></div>'
    + '<div class="hd-lic-row"><span>商圈</span><b>中山路</b></div>'
    + '<div class="hd-lic-row"><span>百度评分</span><b>5</b></div>'
    + '<div class="hd-lic-row"><span>百度评论</span><b>3</b></div>'
    + '<div class="hd-lic-row"><span>标签</span><b>宠物医院 宠物美容</b></div></div></section>';
  const row = parseMerchantPage('achong', html, 'https://achong.net/hospital/3').records[0];
  const archive = { section: '🏥 医院档案', subsection: '📋 资质公示' };
  const business = { section: '📎 数据来源', subsection: '工商信息' };
  const maps = { section: '📎 数据来源', subsection: '地图平台' };
  assert.deepEqual(row.public_fields.detail_facts, [
    { label: '平台核验', value: '待核验 / 源公示', ...archive },
    { label: '企业名称', value: '示例动物诊所', ...business },
    { label: '法人', value: '王某', ...business },
    { label: '统一社会信用代码', value: '91350000EXAMPLE', ...business },
    { label: '登记状态', value: '开业', ...business },
    { label: '成立日期', value: '2020-01-01', ...business },
    { label: '经营范围', value: '宠物诊疗服务', ...business },
    { label: '商圈', value: '中山路', ...maps },
    { label: '百度评分', value: '5', ...maps },
    { label: '百度评论', value: '3', ...maps },
    { label: '标签', value: '宠物医院 宠物美容', ...maps },
  ]);
  assert.equal(row.verified, false);
  assert.equal(row.license_verified, false);
  assert.equal(row.rating_text, null);
});

test('mengchong detail keeps labeled visible facts but excludes identity header', () => {
  const html = '<div class="pdtsr"><ul class="mphd"><li><h1>示例宠物馆</h1><u class="dpjj">寄养</u></li>'
    + '<li><i>评 分： </i>4</li><li><i>地 区： </i>上海市 浦东新区</li>'
    + '<li><i>地 址： </i>源深路614号</li><li><i>电 话： </i>13120608920</li>'
    + '<li><i>营 业： </i>周一至周日 10:00-20:00</li></ul></div>';
  const row = parseMerchantPage('mengchong', html, 'https://www.mengchong.cn/dianpu/8560.html').records[0];
  assert.deepEqual(row.public_fields.detail_facts, [
    { label: '评 分：', value: '4', section: null, subsection: null },
    { label: '地 区：', value: '上海市 浦东新区', section: null, subsection: null },
    { label: '地 址：', value: '源深路614号', section: null, subsection: null },
    { label: '电 话：', value: '13120608920', section: null, subsection: null },
    { label: '营 业：', value: '周一至周日 10:00-20:00', section: null, subsection: null },
  ]);
  assert.equal(row.public_fields.site_score_text, '4');
  assert.equal(row.rating_text, null);
});

test('apwol detail omits contact placeholders and incomplete address but keeps real facts', () => {
  const html = '<main><h1>示例服务商</h1><div class="pm-detail-grid">'
    + '<div class="pm-detail-item"><span>联系电话</span><strong><a href="tel:">暂未提供（免费认领后补充）</a></strong></div>'
    + '<div class="pm-detail-item"><span>联系人</span><strong>暂未提供</strong></div>'
    + '<div class="pm-detail-item"><span>邮箱</span><strong>contact@example.com</strong></div>'
    + '<div class="pm-detail-item" data-intent="address"><span>详细地址</span><strong>山东省淄博市（详细地址见工商登记）</strong></div>'
    + '</div></main>';
  const row = parseMerchantPage('apwol', html, 'https://www.apwol.com/city/zibo/provider/detail/192').records[0];
  assert.deepEqual(row.public_fields.detail_facts, [
    { label: '邮箱', value: 'contact@example.com', section: null, subsection: null },
  ]);
});

test('bagong detail retains only visible hours, not encrypted contact or obfuscated address', () => {
  const html = '<div class="tab-block"><h4>联系我们</h4><div class="linkus"><ul>'
    + '<li><span class="fa fa-clock-o"></span>09:30 - 21:00</li>'
    + '<li><span class="fa fa-phone"></span><span class="encrypted-phone" data-tel="MDEwLTYwNzg2MjEy">点击查看电话</span></li>'
    + '<li><span class="fa fa-map-marker"></span><span class="addr-char">北</span><span class="addr-fake">3</span></li>'
    + '</ul></div></div><h1>宠爱佳宠物会馆</h1>';
  const row = parseMerchantPage('bagong', html, 'https://www.bagong.cn/s45/').records[0];
  assert.deepEqual(row.public_fields.detail_facts, [
    { label: '营业时间', value: '09:30 - 21:00', section: '联系我们', subsection: null },
  ]);
  assert.equal(row.phone, null);
  assert.equal(row.address, null);
});
