import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchWithPolicy } from '../net.mjs';

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    await run('http://127.0.0.1:' + address.port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('redirect to a robots-disallowed path is not fetched', async () => {
  let privateHits = 0;
  const beforeRequests = [];
  await withServer((req, res) => {
    if (req.url === '/go') { res.writeHead(302, { location: '/private' }); res.end(); return; }
    if (req.url === '/private') privateHits++;
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>private</h1>');
  }, async (origin) => {
    await assert.rejects(
      fetchWithPolicy(origin + '/go', {
        origin, robotsText: 'User-agent: *\nDisallow: /private\n',
        beforeRequest: async (url) => { beforeRequests.push(url.pathname); },
      }),
      (error) => error.code === 'ROBOTS_DENIED',
    );
  });
  assert.equal(privateHits, 0);
  assert.deepEqual(beforeRequests, ['/go']);
});

test('beforeRequest runs before both GETs in an allowed redirect', async () => {
  const beforeRequests = [];
  const hits = [];
  await withServer((req, res) => {
    hits.push({ path: req.url, callbacks: beforeRequests.length });
    if (req.url === '/go') { res.writeHead(302, { location: '/final' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>final</h1>');
  }, async (origin) => {
    const result = await fetchWithPolicy(origin + '/go', {
      origin, robotsText: 'User-agent: *\nAllow: /\n',
      beforeRequest: async (url) => {
        await Promise.resolve();
        beforeRequests.push(url.pathname);
      },
    });
    assert.equal(result.url, origin + '/final');
  });
  assert.deepEqual(beforeRequests, ['/go', '/final']);
  assert.deepEqual(hits, [{ path: '/go', callbacks: 1 }, { path: '/final', callbacks: 2 }]);
});

test('a 403 response stops after one request', async () => {
  let hits = 0;
  await withServer((req, res) => { hits++; res.writeHead(403); res.end('Forbidden'); }, async (origin) => {
    await assert.rejects(
      fetchWithPolicy(origin + '/blocked', { origin, robotsText: 'User-agent: *\nAllow: /\n' }),
      (error) => error.code === 'HTTP_BLOCKED' && error.status === 403,
    );
  });
  assert.equal(hits, 1);
});

test('a 503 response blocks the site after one request', async () => {
  let hits = 0;
  await withServer((req, res) => { hits++; res.writeHead(503); res.end('Unavailable'); }, async (origin) => {
    await assert.rejects(
      fetchWithPolicy(origin + '/busy', { origin, robotsText: 'User-agent: *\nAllow: /\n' }),
      (error) => error.code === 'HTTP_BLOCKED' && error.status === 503,
    );
  });
  assert.equal(hits, 1);
});

test('XML is accepted only when explicitly requested for a sitemap', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
    res.end('<urlset><url><loc>https://example.com/shop/1</loc></url></urlset>');
  }, async (origin) => {
    await assert.rejects(
      fetchWithPolicy(origin + '/sitemap.xml', { origin, robotsText: 'User-agent: *\nAllow: /\n' }),
      (error) => error.code === 'UNSUPPORTED_CONTENT_TYPE',
    );
    const result = await fetchWithPolicy(origin + '/sitemap.xml', {
      origin, robotsText: 'User-agent: *\nAllow: /\n', acceptXml: true,
    });
    assert.match(result.html, /<urlset>/);
  });
});
