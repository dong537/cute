import { load } from 'cheerio';

const clean = (value) => value == null ? null : (String(value).replace(/\s+/g, ' ').trim() || null);
const pickText = ($, selector) => clean($(selector).first().text());

const paths = {
  bagong: /^\/s\d+\/service\/?$/,
  achong: /^\/hospital\/\d+\/?$/,
  mengchong: /^\/dianpu\/\d+\.html$/,
  apwol: /^\/city\/[^/]+\/provider\/detail\/\d+\/?$/,
  chongwunet: /^\/pp\/[a-z0-9]+(?:\/zs\/\d+)?\/?$/i,
  chongso: /^\/d\/[a-z0-9]+\/?$/i,
  moguvet: /^\/article\/\d+\/?$/,
  petdr: /^\/medical\/[^/?]+\.html$/,
  chongwu365: /^\/news\/\d+\.html$/,
  petdian: /^\/doc\/\d+\.html$/,
};

export function canFollow(site, rawUrl, origin) {
  const pattern = paths[site];
  if (!pattern) return false;
  let url;
  try { url = new URL(rawUrl, origin); } catch { return false; }
  if (url.origin !== new URL(origin).origin || !pattern.test(url.pathname)) return false;
  if (site === 'bagong') return !url.search || url.search === '?t=jiyang';
  return !url.search;
}

function structuredData($) {
  const out = [];
  const add = (value) => {
    if (Array.isArray(value)) return value.forEach(add);
    if (!value || typeof value !== 'object') return;
    out.push(value);
    if (value['@graph']) add(value['@graph']);
    if (value.mainEntity) add(value.mainEntity);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try { add(JSON.parse($(el).html())); } catch { /* malformed optional metadata */ }
  });
  return out;
}

function hasType(item, type) {
  const types = Array.isArray(item?.['@type']) ? item['@type'] : [item?.['@type']];
  return types.some((value) => typeof value === 'string' && value.split('/').at(-1) === type);
}

function discoverLinks($, site, pageUrl, data) {
  const pattern = paths[site];
  if (!pattern) return [];
  const page = new URL(pageUrl);
  const raw = [];
  $('a[href]').each((_, el) => raw.push($(el).attr('href')));
  for (const item of data) for (const entry of item.itemListElement ?? []) raw.push(entry.url ?? entry.item?.url);
  const found = new Set();
  for (const href of raw) {
    if (!href) continue;
    let url;
    try { url = new URL(href, page); } catch { continue; }
    if (!canFollow(site, url.href, page.origin)) continue;
    url.hash = '';
    if (url.href !== page.href) found.add(url.href);
  }
  return [...found].slice(0, 50);
}

function record(type, site, pageUrl, fields) {
  return {
    type, source_site: site, source_url: pageUrl,
    title: null, description: null, author: null, published_at: null,
    name: null, address: null, address_hint: null, phone: null, hours: null, price_text: null,
    rating_text: null, claim_status: null, merchant_url: null, target_url: null,
    source_level: type === 'merchant_lead' ? 'commercial_directory' : 'editorial_content',
    verified: false, license_verified: false, ...fields,
  };
}

function labelled($, label) {
  let value = null;
  $('.pdtsr .mphd li').each((_, el) => {
    const raw = clean($(el).text()) ?? '';
    const match = raw.match(new RegExp('^' + label + '\\s*[:：]\\s*(.+)$'));
    if (match) value = clean(match[1]);
  });
  return value;
}

export function extractPage(site, html, pageUrl) {
  const $ = load(html);
  const data = structuredData($);
  const links = discoverLinks($, site, pageUrl, data);
  const records = [];
  const path = new URL(pageUrl).pathname;

  if (site === 'bagong' && path.startsWith('/jiyang/')) {
    $('ul.media-list a.clearfix[href]').slice(0, 25).each((_, el) => {
      const card = $(el);
      const name = clean(card.find('h4.media-heading').first().text());
      if (!name) return;
      const addressText = clean(card.find('.address').first().text());
      const addressTruncated = /(?:\.{2,}|…)/.test(addressText ?? '');
      const price = clean(card.find('.jiyang-type .price').first().text());
      const unit = clean(card.find('.jiyang-type .price_unit').first().text());
      records.push(record('merchant_lead', site, pageUrl, {
        name, address: addressTruncated ? null : addressText,
        address_hint: addressTruncated ? addressText : null,
        price_text: price ? price + (unit ?? '') : null,
        merchant_url: new URL(card.attr('href'), pageUrl).href,
      }));
    });
  } else if (site === 'achong' && !paths.achong.test(path)) {
    const listed = data.find((item) => Array.isArray(item.itemListElement))?.itemListElement ?? [];
    $('.hp-list .hp-hos').slice(0, 25).each((index, el) => {
      const card = $(el);
      const name = clean(card.find('.hp-hos-name').first().text());
      if (!name) return;
      const entry = listed[index];
      const merchantUrl = clean(entry?.name) === name && canFollow(site, entry?.url, new URL(pageUrl).origin)
        ? new URL(entry.url, pageUrl).href : null;
      const rating = clean(card.find('.hp-score').first().text());
      const ratingSource = clean(card.find('.hp-src').first().text());
      records.push(record('merchant_lead', site, pageUrl, {
        name, merchant_url: merchantUrl,
        address: clean(card.find('.hp-hos-addr').first().text())?.replace(/^📍\s*/, '') ?? null,
        phone: clean(card.find('a[href^="tel:"]').first().attr('href')?.slice(4)),
        rating_text: rating ? rating + (ratingSource ? '（' + ratingSource + '）' : '') : null,
      }));
    });
  } else if (site === 'mengchong' && paths.mengchong.test(path)) {
    const name = pickText($, '.pdtsr h1') ?? pickText($, 'h1');
    if (name) records.push(record('merchant_lead', site, pageUrl, {
      name, merchant_url: pageUrl,
      address: labelled($, '地\\s*址'), phone: labelled($, '电\\s*话'), hours: labelled($, '营\\s*业'),
    }));
  } else if ((site === 'apwol' && paths.apwol.test(path)) || (site === 'achong' && paths.achong.test(path))) {
    const item = data.find((value) => hasType(value, 'LocalBusiness'));
    const name = clean(item?.name) ?? pickText($, 'h1');
    const address = typeof item?.address === 'string' ? item.address : item?.address?.streetAddress;
    const addressText = clean(address);
    const addressIncomplete = /(?:\.{2,}|…|详细地址见|详见)/.test(addressText ?? '');
    if (name) records.push(record('merchant_lead', site, pageUrl, {
      name, merchant_url: pageUrl, address: addressIncomplete ? null : addressText,
      address_hint: addressIncomplete ? addressText : null, phone: clean(item?.telephone),
      claim_status: site === 'apwol' && $('body').text().includes('未认领') ? '未认领' : null,
      rating_text: site === 'achong' && item?.aggregateRating?.ratingValue ? String(item.aggregateRating.ratingValue) + '（页面自述）' : null,
    }));
  } else if (site === 'chongwunet' && /^\/pp\/[^/]+\/?$/.test(path)) {
    const title = pickText($, 'h1');
    if (title) records.push(record('content_link', site, pageUrl, {
      title, description: clean($('meta[name="description"]').attr('content')),
      source_level: 'promotional_content',
    }));
  } else if (site === 'chongso' && path === '/') {
    const seen = new Set();
    $('a[href]').each((_, el) => {
      if (records.length >= 25) return;
      let url;
      try { url = new URL($(el).attr('href'), pageUrl); } catch { return; }
      const title = clean($(el).text());
      if (!canFollow(site, url.href, new URL(pageUrl).origin) || !title || seen.has(url.href)) return;
      seen.add(url.href);
      records.push(record('content_link', site, pageUrl, { title, target_url: url.href }));
    });
  } else if (site === 'chongso' && paths.chongso.test(path)) {
    const title = pickText($, 'h1') ?? clean($('title').text().replace(/_宠搜网$/, ''));
    if (title) records.push(record('content_link', site, pageUrl, {
      title, description: clean($('meta[name="description"]').attr('content')),
    }));
  } else if (['moguvet', 'petdr', 'chongwu365', 'petdian'].includes(site) && paths[site].test(path)) {
    const item = data.find((value) => ['Article', 'NewsArticle', 'BlogPosting'].some((type) => hasType(value, type)));
    const author = Array.isArray(item?.author) ? item.author[0] : item?.author;
    const title = clean(item?.headline) ?? pickText($, 'h1') ?? clean($('meta[property="og:title"]').attr('content'));
    if (title) records.push(record('content_link', site, pageUrl, {
      title, description: clean($('meta[name="description"]').attr('content')),
      published_at: clean(item?.datePublished) ?? clean($('meta[property="article:published_time"]').attr('content')),
      author: clean(typeof author === 'string' ? author : author?.name),
    }));
  } else if (site === 'boqii' && path.startsWith('/baike/')) {
    const page = new URL(pageUrl);
    const seen = new Set();
    $('a[href]').each((_, el) => {
      if (records.length >= 25) return;
      let url;
      try { url = new URL($(el).attr('href'), pageUrl); } catch { return; }
      const title = clean($(el).text());
      if (url.hostname !== page.hostname || url.port || !['http:', 'https:'].includes(url.protocol)
        || !/^\/article\/\d+\.html$/.test(url.pathname) || !title || seen.has(url.href)) return;
      seen.add(url.href);
      records.push(record('content_link', site, pageUrl, { title, target_url: url.href }));
    });
  }
  return { records, links };
}
