// wf.kb.ingest_source > "Robots URL"
// Input: {job_id, force, cfg, models, source}. Adds the robots.txt URL.
/* @include kb/lib/robots.js */
const x = $input.first().json;
const u = splitUrl(x.source.url);
if (!u) throw new Error(`unsupported URL ${x.source.url}`);
return [{ json: { ...x, robots_url: `${u.protocol}//${u.host}/robots.txt`, t0: Date.now() } }];
