import test from 'node:test';
import assert from 'node:assert/strict';
import { robotsAllows, robotsCrawlDelayMs } from '../robots.mjs';

test('the most specific matching path rule wins', () => {
  const robots = 'User-agent: *\nDisallow: /article/\nAllow: /article/public/\n';
  assert.equal(robotsAllows(robots, 'PetSourceResearchBot', 'https://example.com/article/private'), false);
  assert.equal(robotsAllows(robots, 'PetSourceResearchBot', 'https://example.com/article/public/1'), true);
});

test('a specific bot group takes precedence over the wildcard group', () => {
  const robots = 'User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n';
  assert.equal(robotsAllows(robots, 'PetSourceResearchBot', 'https://example.com/page'), true);
  assert.equal(robotsAllows(robots, 'GPTBot', 'https://example.com/page'), false);
});

test('wildcard disallow covers query-string URLs', () => {
  const robots = 'User-agent: *\nDisallow: /*?*\n';
  assert.equal(robotsAllows(robots, 'PetSourceResearchBot', 'https://example.com/list?page=2'), false);
  assert.equal(robotsAllows(robots, 'PetSourceResearchBot', 'https://example.com/list'), true);
});

test('an empty Disallow does not block a page', () => {
  const robots = 'User-agent: *\nDisallow:\n';
  assert.equal(robotsAllows(robots, 'PetSourceResearchBot', 'https://example.com/page'), true);
});

test('crawl delay defaults to zero and accepts decimal seconds', () => {
  assert.equal(robotsCrawlDelayMs('User-agent: *\nAllow: /\n', 'PetSourceResearchBot'), 0);
  assert.equal(robotsCrawlDelayMs('User-agent: *\nCrawl-delay: 2.5\n', 'PetSourceResearchBot'), 2500);
});

test('the most specific user-agent group controls crawl delay', () => {
  const robots = 'User-agent: *\nCrawl-delay: 10\nUser-agent: PetSourceResearchBot\nCrawl-delay: 1.25\n';
  assert.equal(robotsCrawlDelayMs(robots, 'PetSourceResearchBot/0.1'), 1250);
  assert.equal(robotsCrawlDelayMs(robots, 'OtherBot'), 10000);
  assert.equal(robotsAllows(robots, 'PetSourceResearchBot/0.1', 'https://example.com/page'), true);
});

test('invalid delays are ignored and equivalent groups use the slower value', () => {
  const robots = 'User-agent: PetSourceResearchBot\nCrawl-delay: -1\nCrawl-delay: Infinity\nCrawl-delay: 1.5\nUser-agent: PetSourceResearchBot\nCrawl-delay: 2\n';
  assert.equal(robotsCrawlDelayMs(robots, 'PetSourceResearchBot/0.1'), 2000);
  assert.equal(robotsCrawlDelayMs('User-agent: *\nCrawl-delay: NaN\n', 'OtherBot'), 0);
  assert.equal(robotsCrawlDelayMs('User-agent: *\nCrawl-delay: 1e999\n', 'OtherBot'), 0);
});

test('crawl delay directives do not change allow and disallow precedence', () => {
  const robots = 'User-agent: *\nDisallow: /private\nCrawl-delay: 4\nUser-agent: PetSourceResearchBot\nAllow: /private\nCrawl-delay: 2\n';
  assert.equal(robotsAllows(robots, 'PetSourceResearchBot/0.1', 'https://example.com/private'), true);
  assert.equal(robotsAllows(robots, 'OtherBot', 'https://example.com/private'), false);
});
