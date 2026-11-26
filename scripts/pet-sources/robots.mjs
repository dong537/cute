/** Minimal RFC 9309 rule evaluation for the public pages used by this pilot. */
export function parseRobots(text) {
  const groups = [];
  let agents = [];
  let rules = [];
  let crawlDelays = [];
  const flush = () => {
    if (agents.length) groups.push({ agents, rules, crawlDelays });
    agents = [];
    rules = [];
    crawlDelays = [];
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#', 1)[0].trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (rules.length || crawlDelays.length) flush();
      agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && agents.length) {
      if (value) rules.push({ allow: key === 'allow', path: value });
    } else if (key === 'crawl-delay' && agents.length) {
      crawlDelays.push(value);
    }
  }
  flush();
  return groups;
}

function ruleRegex(path) {
  let out = '^';
  for (let i = 0; i < path.length; i++) {
    const char = path[i];
    if (char === '*') out += '.*';
    else if (char === '$' && i === path.length - 1) out += '$';
    else out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out);
}

export function robotsAllows(text, userAgent, url) {
  const target = new URL(url);
  const path = target.pathname + target.search;
  const ua = userAgent.toLowerCase();
  const matching = [];
  for (const group of parseRobots(text)) {
    for (const agent of group.agents) {
      if (agent === '*' || ua.includes(agent)) matching.push({ rank: agent === '*' ? 0 : agent.length, rules: group.rules });
    }
  }
  if (!matching.length) return true;
  const bestAgent = Math.max(...matching.map((item) => item.rank));
  const rules = matching.filter((item) => item.rank === bestAgent).flatMap((item) => item.rules);
  let bestRule = null;
  for (const rule of rules) {
    if (!ruleRegex(rule.path).test(path)) continue;
    const rank = rule.path.replace(/\*/g, '').replace(/\$$/, '').length;
    if (!bestRule || rank > bestRule.rank || (rank === bestRule.rank && rule.allow)) {
      bestRule = { rank, allow: rule.allow };
    }
  }
  return bestRule?.allow ?? true;
}

export function robotsCrawlDelayMs(text, userAgent) {
  const ua = userAgent.toLowerCase();
  let bestAgent = -1;
  let values = [];
  for (const group of parseRobots(text)) {
    for (const agent of group.agents) {
      if (agent !== '*' && !ua.includes(agent)) continue;
      const rank = agent === '*' ? 0 : agent.length;
      if (rank > bestAgent) {
        bestAgent = rank;
        values = [...group.crawlDelays];
      } else if (rank === bestAgent) {
        values.push(...group.crawlDelays);
      }
    }
  }
  let delayMs = 0;
  for (const raw of values) {
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) continue;
    const seconds = Number(raw);
    const milliseconds = seconds * 1000;
    if (Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(milliseconds)) {
      delayMs = Math.max(delayMs, Math.ceil(milliseconds));
    }
  }
  return delayMs;
}
