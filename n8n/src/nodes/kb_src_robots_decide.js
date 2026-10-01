// wf.kb.ingest_source > "Robots decision"
// Input: the robots.txt answer (full response, text, never-error) or a network
// error item. RFC 9309 rules in kb/lib/robots.js.
/* @include kb/lib/robots.js */
const x = $('Robots URL').first().json;
const r = $input.first().json;
const status = Number(r.statusCode || 0);
const body = typeof r.data === 'string' ? r.data : (typeof r.body === 'string' ? r.body : '');
const d = robotsDecision(r.error ? 0 : status, body, x.cfg.user_agent, x.source.url);
return [{ json: { ...x, robots: { status: r.error ? 0 : status, ...d } } }];
