// robots.txt handling for source fetches (spec 10.1: respect robots.txt).
// Follows RFC 9309: the most specific matching group for our user agent (else
// "*"), longest matching rule wins, Allow wins a tie, "*" and "$" wildcards.
// Status handling (RFC 9309 section 2.3.1): 2xx -> parse; 4xx -> no
// restrictions; 5xx, network error or no answer -> treat as complete disallow.

function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      if (current) current.rules.push({ allow: field === 'allow', path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;   // sitemap, crawl-delay and others do not end a group but are ignored
    }
  }
  return groups;
}

function patternMatches(pattern, path) {
  if (pattern === '') return false;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp('^' + body.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  return re.test(path);
}

// Product token: the first word of the User-Agent, lower case ("flatsharekb").
function robotsAllowed(groups, userAgent, pathAndQuery) {
  const token = String(userAgent || '').split(/[\/\s]/)[0].toLowerCase();
  let chosen = groups.filter((g) => g.agents.some((a) => a !== '*' && a === token));
  if (!chosen.length) chosen = groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  let best = null;
  for (const r of rules) {
    if (!patternMatches(r.path, pathAndQuery)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow, path: r.path };
  }
  return best ? { allowed: best.allow, rule: (best.allow ? 'allow ' : 'disallow ') + best.path } : { allowed: true, rule: null };
}

// URL parts without the WHATWG URL class (not available in n8n's Code node sandbox).
function splitUrl(url) {
  const m = /^(https?):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i.exec(String(url || ''));
  if (!m) return null;
  return { protocol: m[1].toLowerCase() + ':', host: m[2], pathname: m[3] || '/', search: m[4] || '' };
}

// Decision from the robots.txt HTTP answer. status 0 / null = network error.
function robotsDecision(status, body, userAgent, url) {
  const u = splitUrl(url);
  if (!u) return { allowed: false, reason: 'bad_url', rule: null };
  const path = u.pathname + u.search;
  if (status >= 200 && status < 300) {
    const r = robotsAllowed(parseRobots(body), userAgent, path);
    return { allowed: r.allowed, reason: r.allowed ? 'robots_allows' : 'robots_disallows', rule: r.rule };
  }
  if (status >= 400 && status < 500) return { allowed: true, reason: 'robots_absent_' + status, rule: null };
  return { allowed: false, reason: status ? 'robots_unreachable_' + status : 'robots_unreachable', rule: null };
}

if (typeof module !== 'undefined') {
  module.exports = { parseRobots, robotsAllowed, robotsDecision, patternMatches, splitUrl };
}
