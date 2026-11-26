import { robotsAllows } from './robots.mjs';

export const USER_AGENT = 'PetSourceResearchBot/0.1 (bounded local research)';

function failure(code, message, status = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function checkUrl(url, origin, robotsText, userAgent) {
  if (url.origin !== origin) throw failure('CROSS_ORIGIN', 'Redirect left source origin: ' + url.href);
  if (!robotsAllows(robotsText, userAgent, url.href)) {
    throw failure('ROBOTS_DENIED', 'robots.txt disallows: ' + url.href);
  }
}

async function get(url, userAgent, timeoutMs) {
  try {
    return await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': userAgent, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw failure('NETWORK_ERROR', 'Request failed for ' + url + ': ' + cause.message);
  }
}

export async function fetchRobots(origin, { userAgent = USER_AGENT, timeoutMs = 15000 } = {}) {
  const url = new URL('/robots.txt', origin);
  const response = await get(url, userAgent, timeoutMs);
  if (response.status === 404 || response.status === 410) return { status: response.status, text: '' };
  if (response.status !== 200) {
    throw failure('ROBOTS_UNAVAILABLE', 'robots.txt returned HTTP ' + response.status, response.status);
  }
  return { status: 200, text: await response.text() };
}

export async function fetchWithPolicy(rawUrl, {
  origin, robotsText, userAgent = USER_AGENT, timeoutMs = 15000, maxBytes = 2_000_000,
  acceptXml = false, beforeRequest = null,
} = {}) {
  if (typeof robotsText !== 'string') throw failure('ROBOTS_UNAVAILABLE', 'robots.txt was not checked');
  const expectedOrigin = new URL(origin).origin;
  let current = new URL(rawUrl);
  for (let redirects = 0; redirects <= 3; redirects++) {
    checkUrl(current, expectedOrigin, robotsText, userAgent);
    if (beforeRequest) await beforeRequest(current);
    const response = await get(current, userAgent, timeoutMs);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw failure('BAD_REDIRECT', 'Redirect has no Location: ' + current.href);
      current = new URL(location, current);
      continue;
    }
    if ([400, 401, 403, 429, 503].includes(response.status)) {
      throw failure('HTTP_BLOCKED', 'HTTP ' + response.status + ' at ' + current.href, response.status);
    }
    if (!response.ok) throw failure('HTTP_ERROR', 'HTTP ' + response.status + ' at ' + current.href, response.status);
    const type = response.headers.get('content-type') ?? '';
    const allowedType = /text\/html|application\/xhtml\+xml/i.test(type)
      || (acceptXml && /(?:application|text)\/xml/i.test(type));
    if (type && !allowedType) {
      throw failure('UNSUPPORTED_CONTENT_TYPE', 'Expected HTML' + (acceptXml ? ' or XML' : '') + ' at ' + current.href + ', got ' + type);
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (declaredLength > maxBytes) throw failure('TOO_LARGE', 'Page exceeds byte limit: ' + current.href);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw failure('TOO_LARGE', 'Page exceeds byte limit: ' + current.href);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const headerCharset = /charset=([^;\s]+)/i.exec(type)?.[1];
    const head = bytes.subarray(0, 2048).toString('latin1');
    const metaCharset = /<meta[^>]+charset=["']?([a-z0-9-]+)/i.exec(head)?.[1];
    const charset = headerCharset || metaCharset || 'utf-8';
    let html;
    try { html = new TextDecoder(charset).decode(bytes); }
    catch { html = new TextDecoder('utf-8').decode(bytes); }
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
    if (/验证码|验证中心|请求不被防火墙认可|captcha|cf-challenge/i.test(title)) {
      throw failure('CHALLENGE', 'Verification page at ' + current.href);
    }
    return { status: response.status, url: current.href, html };
  }
  throw failure('TOO_MANY_REDIRECTS', 'More than three redirects: ' + rawUrl);
}
