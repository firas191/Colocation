// wf.kb.ingest_source > "Clean HTML"
// Input: the fetched page (full response, binary in "data"). Decodes the bytes
// with the declared or sniffed charset and converts HTML to cleaned text
// (kb/lib/text.js). Plain-text sources are only normalised.
/* @include kb/lib/text.js */
const x = $('Robots decision').first().json;
const r = $input.first().json;
const status = Number(r.statusCode || 0);
if (status < 200 || status >= 300) throw new Error(`fetch_http_${status || 'error'} ${x.source.url}`);
const buf = await this.helpers.getBinaryDataBuffer(0, 'data');
const headers = r.headers || {};
const ctype = String(headers['content-type'] || '');
const { text: raw, charset } = decodeBytes(buf, ctype);
// A wrong decoder produces replacement characters: stop instead of storing garbled text (F-029).
const bad = (raw.match(/\ufffd/g) || []).length;
if (bad > Math.max(5, raw.length * 0.001)) throw new Error(`decoding_failed ${charset}: ${bad} replacement characters`);
const f = x.source.fetch || {};
let content, selected = null;
if (/^text\/plain/i.test(ctype) || f.format === 'text') {
  content = normalizeText(raw);
} else {
  const r2 = htmlToText(raw, { select: f.select || [], keepBoilerplate: !!f.keep_boilerplate });
  content = r2.text;
  selected = r2.selected;
  if (f.select && f.select.length && !selected && f.require_select) throw new Error(`select_not_found ${JSON.stringify(f.select)}`);
}
let cut = null;
if (f.start_at || f.end_at) {
  const c = cutBetween(content, f.start_at, f.end_at);
  content = c.text;
  cut = { start_at: f.start_at || null, end_at: f.end_at || null, end_found: c.ended };
}
if (content.length < (f.min_chars || 200)) throw new Error(`extracted_too_short ${content.length} chars`);
return [{ json: {
  ...x, http_status: status, content_type: ctype.slice(0, 200), content,
  extractor: 'html_v1', bytes_b64: buf.toString('base64'),
  doc_metadata: { charset, selected, cut, raw_bytes: buf.length, fetch_ms: Date.now() - x.t0 },
} }];
