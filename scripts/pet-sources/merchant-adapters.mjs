import { load } from 'cheerio';

export const MERCHANT_SOURCES = Object.freeze({
  bagong: 'https://www.bagong.cn/jiyang/beijing/',
  uchongs: 'https://www.uchongs.com/shop/s0n1',
  achong: 'https://achong.net/sitemap.xml',
  mengchong: 'https://www.mengchong.cn/sitemap.xml',
  apwol: 'https://www.apwol.com/sitemap_index.xml',
});

const clean = (value) => value == null ? null : (String(value).replace(/\s+/g, ' ').trim() || null);
const textAt = ($, selector) => clean($(selector).first().text());
const unique = (items) => [...new Set(items.filter(Boolean))];
const isIncompleteAddress = (value) => /\.{2,}|…|详细地址见|详见工商|地址见工商/.test(value ?? '');

function mediaUrl(raw, pageUrl) {
  const value = typeof raw === 'string' ? raw : raw?.url;
  if (!value) return null;
  try {
    const url = new URL(value, pageUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function mediaUrls($, selector, pageUrl) {
  return unique($(selector).map((_, node) => mediaUrl($(node).attr('src'), pageUrl)).get());
}

function bagongShopUrl(rawUrl, pageUrl) {
  const url = new URL(rawUrl, pageUrl);
  const id = /^\/s(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
  return id ? new URL('/s' + id + '/', url).href : null;
}

export function classifyMerchantUrl(site, rawUrl) {
  if (!MERCHANT_SOURCES[site]) return null;
  let url;
  try { url = new URL(rawUrl, MERCHANT_SOURCES[site]); } catch { return null; }
  const path = url.pathname;
  const query = url.search;

  if (site === 'bagong') {
    if (/^\/s\d+\/?$/.test(path) && !query) return 'detail';
    if (/^\/s\d+\/service\/?$/.test(path) && query === '?t=jiyang') return 'detail';
    if (/^\/jiyang(?:\/[a-z]+)?\/?$/.test(path) && (!query || /^\?p=[1-9]\d*$/.test(query))) return 'list';
    if (/^\/sj(?:\/[a-z]+)?\/?$/.test(path) && (!query || /^\?p=[1-9]\d*$/.test(query))) return 'list';
    return null;
  }
  if (site === 'uchongs') {
    if (query) return null;
    if (/^\/shop\/d\d+$/.test(path)) return 'detail';
    if (/^\/shop\/s0n[13](?:p[1-9]\d*)?$/.test(path)) return 'list';
    return null;
  }
  if (site === 'achong') {
    if (query) return null;
    if (/^\/hospital\/\d+\/?$/.test(path)) return 'detail';
    if (path === '/sitemap.xml' || /^\/hospital(?:\/chengdu(?:\/[a-z]+)?(?:\/page\/[1-9]\d*)?)?\/?$/.test(path)) return 'list';
    return null;
  }
  if (site === 'mengchong') {
    if (query) return null;
    if (/^\/(?:dianpu|yiyuan|chongwu)\/\d+\.html$/.test(path)) return 'detail';
    if (path === '/sitemap.xml' || /^\/dianpu\/?$/.test(path)) return 'list';
    return null;
  }
  if (site === 'apwol') {
    if (/^\/city\/[a-z][a-z0-9_]*\/provider\/detail\/\d+\/?$/.test(path) && !query) return 'detail';
    if ((path === '/sitemap_index.xml' || path === '/sitemap_provider.xml') && !query) return 'list';
    if (/^\/provider\/list\/?$/.test(path) && (!query || /^\?page=[1-9]\d*$/.test(query))) return 'list';
    if (/^\/city\/[a-z][a-z0-9_]*\/provider\/?$/.test(path) && !query) return 'list';
  }
  return null;
}

function publicUrl(site, raw, pageUrl, expected) {
  if (!raw) return null;
  let url;
  try { url = new URL(raw, pageUrl); } catch { return null; }
  if (url.origin !== new URL(pageUrl).origin) return null;
  url.hash = '';
  if (site === 'bagong' && /^\/sj(?:\/[a-z]+)?$/.test(url.pathname)) url.pathname += '/';
  if (site === 'bagong' && /^\/sj(?:\/[a-z]+)?\/$/.test(url.pathname) && url.search === '?p=1') url.search = '';
  if (site === 'bagong' && /^\/s\d+$/.test(url.pathname) && !url.search) url.pathname += '/';
  if (expected && classifyMerchantUrl(site, url.href) !== expected) return null;
  return url.href;
}

function record(site, sourceUrl, merchantUrl, name, fields = {}) {
  return {
    type: 'merchant_lead', source_site: site, source_url: sourceUrl,
    merchant_url: merchantUrl, name, address: null, address_hint: null,
    phone: null, hours: null, price_text: null, rating_text: null,
    claim_status: null, provider_type: null, public_fields: {},
    source_level: 'commercial_directory', verified: false, license_verified: false,
    ...fields,
  };
}

function structuredData($, pageUrl, warnings) {
  const result = [];
  function add(value) {
    if (Array.isArray(value)) { value.forEach(add); return; }
    if (!value || typeof value !== 'object') return;
    result.push(value);
    if (value['@graph']) add(value['@graph']);
    if (value.mainEntity) add(value.mainEntity);
  }
  $('script[type="application/ld+json"]').each((_, node) => {
    const raw = $(node).html();
    if (!raw?.trim()) return;
    try { add(JSON.parse(raw)); }
    catch (error) {
      const warning = 'Malformed JSON-LD at ' + pageUrl + ': ' + error.message;
      warnings.push(warning);
      console.warn(warning);
    }
  });
  return result;
}

function hasType(value, type) {
  const types = Array.isArray(value?.['@type']) ? value['@type'] : [value?.['@type']];
  return types.some((item) => typeof item === 'string' && item.split('/').at(-1) === type);
}

function detailAddress(value, personal = false) {
  const raw = clean(typeof value === 'string' ? value : value?.streetAddress);
  if (personal) return { address: null, address_hint: null };
  return isIncompleteAddress(raw)
    ? { address: null, address_hint: raw }
    : { address: raw, address_hint: null };
}

function jsonLdBusinessFields(business) {
  if (!business) return {};
  const fields = {};
  for (const key of ['url', 'email', 'sameAs', 'paymentAccepted', 'openingHours', 'priceRange']) {
    const value = business[key];
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    fields[key] = value;
  }
  const geo = business.geo;
  const lat = Number(geo?.latitude);
  const lon = Number(geo?.longitude);
  if (geo && Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat !== 0 || lon !== 0)) {
    fields.geo = geo;
  }
  return fields;
}

function labelled($, label) {
  let value = null;
  $('.pdtsr .mphd li').each((_, node) => {
    const raw = clean($(node).text()) ?? '';
    const match = raw.match(new RegExp('^' + label + '\\s*[:：]\\s*(.+)$'));
    if (match) value = clean(match[1]);
  });
  return value;
}

function factRow(label, value, section = null, subsection = null) {
  return { label, value, section, subsection };
}

function achongDetailFacts($) {
  const facts = [];
  $('.hd-lic-row').each((_, node) => {
    const row = $(node);
    const label = clean(row.find('span').first().text());
    const value = clean(row.find('b').first().text());
    if (!label || !value) return;
    const section = clean(row.closest('section.hd-card').find('.hd-sec-head h2').first().text());
    const block = row.closest('.hd-dblock, .hd-src-block');
    const title = block.find('.hd-dt-title').first();
    const subsection = clean(title.children('span').first().text()) ?? clean(title.text());
    facts.push(factRow(label, value, section, subsection));
  });
  return facts;
}

function mengchongDetailFacts($, phoneLooksLikeHours) {
  const facts = [];
  $('.pdtsr .mphd li').each((_, node) => {
    const row = $(node);
    const label = clean(row.find('i').first().text());
    if (!label) return;
    const visibleValue = row.clone();
    visibleValue.find('i').first().remove();
    const value = clean(visibleValue.text());
    if (!value || (phoneLooksLikeHours && /^电\s*话[：:]?$/.test(label))) return;
    facts.push(factRow(label, value));
  });
  return facts;
}

function apwolDetailFacts($) {
  const facts = [];
  $('.pm-detail-grid > .pm-detail-item').each((_, node) => {
    const row = $(node);
    const label = clean(row.children('span').first().text());
    const value = clean(row.children('strong').first().text());
    if (!label || !value || /^(?:暂未提供|暂无|未提供)/.test(value)) return;
    if (label === '详细地址' && isIncompleteAddress(value)) return;
    facts.push(factRow(label, value));
  });
  return facts;
}

export function parseMerchantPage(site, html, pageUrl) {
  if (!MERCHANT_SOURCES[site]) throw new Error('Unknown merchant site: ' + site);
  const page = new URL(pageUrl);
  const kind = classifyMerchantUrl(site, page.href);
  if (!kind) throw new Error('Unsupported merchant page URL: ' + pageUrl);
  const xml = page.pathname.endsWith('.xml');
  const $ = load(html, xml ? { xmlMode: true } : undefined);
  const records = [];
  const listUrls = [];
  const detailUrls = [];
  const warnings = [];
  const listed = new Set();
  const detailed = new Set();
  function addUrl(raw) {
    const url = publicUrl(site, raw, page.href);
    if (!url || url === page.href) return null;
    const type = classifyMerchantUrl(site, url);
    if (type === 'list' && !listed.has(url)) { listed.add(url); listUrls.push(url); }
    if (type === 'detail' && !detailed.has(url)) { detailed.add(url); detailUrls.push(url); }
    return type === 'detail' ? url : null;
  }

  if (xml) {
    $('loc').each((_, node) => addUrl(clean($(node).text())));
    return { records, listUrls, detailUrls, warnings };
  }

  const data = structuredData($, page.href, warnings);
  if (kind === 'list') {
    if (site === 'bagong') {
      if (page.pathname.startsWith('/sj')) {
        $('ul.media-list li.media').each((_, node) => {
          const card = $(node);
          const merchantUrl = publicUrl(site,
            card.find('a.shop_name[href]').first().attr('href') ?? card.attr('data-link'), page.href, 'detail');
          const name = clean(card.find('a.shop_name').first().text()) ?? clean(card.attr('data-title'));
          if (!merchantUrl || !name) return;
          addUrl(merchantUrl);
          const hoursLine = card.find('.desc-cell').filter((_, el) =>
            $(el).find('.fa-clock-o').length > 0).first().text();
          const addressLine = card.find('.desc-cell').filter((_, el) =>
            $(el).find('.fa-map-marker').length > 0).first().text();
          records.push(record(site, page.href, bagongShopUrl(merchantUrl, page.href), name, {
            provider_type: 'business',
            ...detailAddress(addressLine),
            hours: clean(hoursLine.match(/\d{1,2}:\d{2}\s*[-–—至]\s*\d{1,2}:\d{2}/)?.[0]),
            public_fields: {
              service_tags: unique(card.find('.shop-tags span').map((_, el) => clean($(el).text())).get()),
              map_coordinates_raw: clean(card.attr('data-loc')),
            },
          }));
        });
      } else $('ul.media-list a.clearfix[href]').each((_, node) => {
        const card = $(node);
        const merchantUrl = publicUrl(site, card.attr('href'), page.href, 'detail');
        const name = clean(card.find('h4.media-heading').first().text());
        if (!merchantUrl || !name) return;
        addUrl(merchantUrl);
        const personal = /^\/s\d+\/$/.test(new URL(merchantUrl).pathname);
        const address = detailAddress(card.find('.address').first().text(), personal);
        const price = clean(card.find('.jiyang-type .price').first().text());
        const unit = clean(card.find('.jiyang-type .price_unit').first().text());
        records.push(record(site, page.href, bagongShopUrl(merchantUrl, page.href), name, {
          ...address, price_text: price ? price + (unit ?? '') : null,
          provider_type: personal ? 'personal_or_unverified' : null,
          public_fields: { pet_types: unique(card.find('.jiyang-type .label').map((_, el) => clean($(el).text())).get()) },
        }));
      });
    } else if (site === 'uchongs') {
      $('.slbd .svbd > a[href]').each((_, node) => {
        const card = $(node);
        const merchantUrl = publicUrl(site, card.attr('href'), page.href, 'detail');
        const name = clean(card.find('dd b').first().text());
        if (!merchantUrl || !name) return;
        addUrl(merchantUrl);
        const categoryLine = clean(card.find('dd u').first().text());
        const rating = categoryLine?.match(/评分[：:]\s*(\d+(?:\.\d+)?\s*\/\s*\d+)/)?.[1] ?? null;
        records.push(record(site, page.href, merchantUrl, name, {
          address: clean(card.find('dd p').first().text()),
          rating_text: rating,
          public_fields: {
            region: clean(card.find('dd i').first().text()),
            category_text: categoryLine?.split(/评分[：:]/)[0].trim() || null,
          },
        }));
      });
    } else if (site === 'achong') {
      const itemList = data.find((item) => Array.isArray(item.itemListElement));
      const byName = new Map();
      for (const item of itemList?.itemListElement ?? []) {
        const name = clean(item.name);
        const url = publicUrl(site, item.url ?? item.item?.url, page.href, 'detail');
        if (!name || !url) continue;
        addUrl(url);
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(url);
      }
      $('.hp-list .hp-hos').each((_, node) => {
        const card = $(node);
        const name = clean(card.find('.hp-hos-name').first().text());
        if (!name) return;
        const htmlLink = card.find('a[href]').map((_, link) =>
          publicUrl(site, $(link).attr('href'), page.href, 'detail')).get().find(Boolean);
        const merchantUrl = byName.get(name)?.shift() ?? htmlLink ?? null;
        if (!merchantUrl) return;
        addUrl(merchantUrl);
        const score = clean(card.find('.hp-score').first().text());
        const scoreSource = clean(card.find('.hp-src').first().text());
        const phone = card.find('a[href^="tel:"]').first().attr('href')?.slice(4);
        records.push(record(site, page.href, merchantUrl, name, {
          address: clean(card.find('.hp-hos-addr').first().text())?.replace(/^📍\s*/, '') ?? null,
          phone: clean(phone),
          rating_text: score ? score + (scoreSource ? '（' + scoreSource + '）' : '') : null,
          public_fields: { categories: unique(card.find('.hp-hos-tags .hp-tag').map((_, el) => clean($(el).text())).get()) },
        }));
      });
    } else if (site === 'mengchong') {
      $('.slbd .svbd > a[href]').each((_, node) => {
        const card = $(node);
        const merchantUrl = publicUrl(site, card.attr('href'), page.href, 'detail');
        const name = clean(card.find('dd b').first().text());
        if (!merchantUrl || !name) return;
        addUrl(merchantUrl);
        records.push(record(site, page.href, merchantUrl, name, {
          address: clean(card.find('dd p').first().text()),
          public_fields: { region: clean(card.find('dd i').first().text()) },
        }));
      });
    } else if (site === 'apwol') {
      for (const item of data.find((entry) => Array.isArray(entry.itemListElement))?.itemListElement ?? []) {
        addUrl(item.url ?? item.item?.url);
      }
      $('article.pm-provider-card').each((_, node) => {
        const card = $(node);
        const anchor = card.find('h3 a[href]').first();
        const merchantUrl = publicUrl(site, anchor.attr('href'), page.href, 'detail');
        const name = clean(anchor.text());
        if (!merchantUrl || !name) return;
        addUrl(merchantUrl);
        const addressLine = card.find('p.pm-small').filter((_, el) => /地址[：:]/.test($(el).text())).first();
        const address = detailAddress(clean(addressLine.text())?.replace(/^地址[：:]\s*/, ''));
        const unclaimed = card.find('.pm-pstatus--unclaimed').length > 0;
        records.push(record(site, page.href, merchantUrl, name, {
          ...address, claim_status: unclaimed ? '未认领' : null,
          public_fields: { service_tags: unique(card.find('.pm-provider-card__tags > span.pm-tag:not(.pm-tag--city)').map((_, el) => clean($(el).text())).get()) },
        }));
      });
    }
    $('a[href]').each((_, node) => {
      const raw = $(node).attr('href');
      if (publicUrl(site, raw, page.href, 'list')) addUrl(raw);
    });
  } else if (site === 'bagong') {
    const name = textAt($, 'h1');
    const description = clean($('meta[name="description"]').attr('content'));
    const hoursLine = $('.linkus li').filter((_, node) => $(node).find('.fa-clock-o').length > 0).first().text();
    const hours = clean(hoursLine.match(/\d{1,2}:\d{2}\s*[-–—至]\s*\d{1,2}:\d{2}/)?.[0]);
    const shopUrl = bagongShopUrl(page.href, page.href);
    const linkedShopUrl = publicUrl(site, $('a.nav-brand[href]').first().attr('href'), page.href, 'detail');
    if (linkedShopUrl === shopUrl) addUrl(linkedShopUrl);
    const personal = /家庭式寄养|家庭寄养|个人寄养/.test((name ?? '') + ' ' + (description ?? ''));
    const business = /宠物(?:会馆|生活馆|用品店|医院|诊所|美容|乐园)|会馆|宠物店|动物医院/.test(name ?? '');
    const providerType = personal ? 'personal_or_unverified' : business ? 'business' : null;
    if (name && shopUrl) records.push(record(site, page.href, shopUrl, name, {
      provider_type: providerType,
      hours,
      public_fields: {
        description,
        detail_facts: hours ? [factRow('营业时间', hours,
          clean($('.linkus').first().closest('.tab-block').find('h4').first().text()))] : [],
        image_urls: providerType === 'business'
          ? mediaUrls($, '.shopdetail-page #mobile-banner .swiper-slide img', page.href) : [],
      },
    }));
  } else if (site === 'uchongs') {
    const name = textAt($, '.pdtsr h1');
    if (name) {
      const detailFacts = mengchongDetailFacts($, false);
      records.push(record(site, page.href, page.href, name, {
        address: labelled($, '地\\s*址'),
        hours: labelled($, '营\\s*业'),
        public_fields: {
          region: labelled($, '地\\s*区'),
          category_text: textAt($, '.pdtsr .dpjj'),
          detail_facts: detailFacts.filter((fact) => !/^电\s*话/.test(fact.label)),
          image_urls: mediaUrls($, '.pdtsl .pbimg img', page.href),
        },
      }));
    }
  } else if (site === 'mengchong') {
    const name = textAt($, '.pdtsr h1');
    const phoneLabel = labelled($, '电\\s*话');
    const phoneLooksLikeHours = /(?:周[一二三四五六日天]|星期|\d{1,2}:\d{2})/.test(phoneLabel ?? '');
    const detailFacts = mengchongDetailFacts($, phoneLooksLikeHours);
    if (name) records.push(record(site, page.href, page.href, name, {
      address: labelled($, '地\\s*址'), phone: phoneLooksLikeHours ? null : phoneLabel,
      hours: labelled($, '营\\s*业'),
      public_fields: {
        region: labelled($, '地\\s*区'),
        phone_label_raw: phoneLooksLikeHours ? phoneLabel : null,
        detail_facts: detailFacts,
        site_score_text: detailFacts.find((fact) => /^评\s*分[：:]?$/.test(fact.label))?.value ?? null,
        categories: unique($('.pdtsr .dpjj a').map((_, node) => clean($(node).text())).get()),
        image_urls: mediaUrls($, '.pdtsl .pbimg img', page.href),
      },
    }));
  } else {
    const business = data.find((item) => hasType(item, 'LocalBusiness'));
    const name = clean(business?.name) ?? textAt($, 'h1');
    const personal = false;
    if (name) {
      const address = detailAddress(business?.address, personal);
      const ratingSource = site === 'achong'
        ? clean($('.hd-hero .hd-src').first().text()?.replace(/^来源\s*/, '')) : null;
      const hoursLine = site === 'achong'
        ? $('.hd-hero .hd-loc-line').filter((_, node) => /🕒/.test($(node).text())).first().text() : '';
      const hours = site === 'achong'
        ? clean(hoursLine.match(/\d{1,2}:\d{2}\s*[-–—至]\s*\d{1,2}:\d{2}/)?.[0]) : null;
      const detailFacts = site === 'achong' ? achongDetailFacts($) : apwolDetailFacts($);
      const fact = (label) => detailFacts.find((item) => item.label === label)?.value ?? null;
      const imageItems = Array.isArray(business?.image) ? business.image : [business?.image];
      const imageUrls = unique(imageItems.map((item) => mediaUrl(item, page.href)));
      const jsonLdFields = jsonLdBusinessFields(business);
      const fields = site === 'achong'
        ? {
            ...jsonLdFields,
            review_count: business?.aggregateRating?.reviewCount != null
              && business.aggregateRating.reviewCount !== ''
              && Number.isInteger(Number(business.aggregateRating.reviewCount))
              && Number(business.aggregateRating.reviewCount) >= 0
              ? Number(business.aggregateRating.reviewCount) : null,
            rating_source: ratingSource,
            categories: unique($('.hd-hero .hd-tag').map((_, node) => clean($(node).text())).get()),
            detail_facts: detailFacts,
            platform_verification: fact('平台核验'),
            business_scope: fact('经营范围'),
            image_urls: imageUrls,
          }
        : {
            ...jsonLdFields,
            description: clean(business?.description),
            area_served: typeof business?.areaServed === 'string' ? clean(business.areaServed) : null,
            detail_facts: detailFacts,
            service_tags: unique($('.pm-provider-card__tags > span.pm-tag:not(.pm-tag--city)').map((_, node) => clean($(node).text())).get()),
            review_count: (() => {
              const heading = $('main h2, main h3').map((_, node) => clean($(node).text())).get()
                .find((value) => /用户评价[（(]\s*\d+\s*[）)]/.test(value ?? ''));
              const match = heading?.match(/用户评价[（(]\s*(\d+)\s*[）)]/);
              return match ? Number(match[1]) : null;
            })(),
            image_urls: imageUrls,
          };
      records.push(record(site, page.href, page.href, name, {
        ...address,
        phone: clean(business?.telephone),
        hours,
        rating_text: site === 'achong' && business?.aggregateRating?.ratingValue != null
          ? String(business.aggregateRating.ratingValue) + '（' + (ratingSource ?? '页面自述') + '）' : null,
        claim_status: site === 'apwol' && $('.pm-pstatus--unclaimed, .pm-pstatus').first().text().includes('未认领')
          ? '未认领' : null,
        public_fields: fields,
      }));
    }
  }
  if (kind === 'list' && (site === 'uchongs' || (site === 'bagong' && page.pathname.startsWith('/sj')))
    && records.length === 0) {
    const error = new Error('No merchant cards found in public list at ' + page.href);
    error.code = 'PARSE_EMPTY';
    throw error;
  }
  if (kind === 'detail' && (records.length === 0 || records.every((row) =>
    /^(?:页面暂不可用|页面不存在|访问受限|验证码|403 Forbidden|404 Not Found)$/i.test(row.name)))) {
    const error = new Error('No usable merchant identity at ' + page.href);
    error.code = 'PARSE_EMPTY';
    throw error;
  }
  return { records, listUrls, detailUrls, warnings };
}
