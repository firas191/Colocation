// wf.kb.ingest_source > "Robots URL"
// Input: {job_id, force, cfg, models, source}. Adds the robots.txt URL. A source URL inside the stack or the local
// network is refused before any request (lib/url_guard.js, D-111), unless its host:port is in kb.fetch_allow_hosts
// (the tests' fixtures server); no request is made and the source fails with the reason.
/* @include kb/lib/robots.js */
/* @include lib/url_guard.js */
const x = $input.first().json;
const u = splitUrl(x.source.url);
if (!u) throw new Error(`unsupported URL ${x.source.url}`);
const allow = ((x.cfg || {}).fetch_allow_hosts || []).map((h) => String(h).toLowerCase());
const refused = allow.includes(u.host.toLowerCase()) ? null : urlRefusal(x.source.url);
return [{ json: { ...x, refused, robots_url: refused ? null : `${u.protocol}//${u.host}/robots.txt`, t0: Date.now() } }];
