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
// decodeBytes throws decoding_failed when the charset cannot be established (F-029, F-032).
const dec = decodeBytes(buf, ctype);
const raw = dec.text;
const charset = dec.charset;
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
// Text in the wrong script for the source's language: a font without a Unicode mapping
// or a wrong decoder. Stop instead of storing it (F-038).
const scriptErr = scriptProblem(content, x.source.language);
if (scriptErr) throw new Error(`wrong_script ${x.source.language}: ${scriptErr}`);
// Replacement characters left in the kept text mean a wrong decoder: stop instead of
// storing garbled text. Counted after cleaning, so comments and dropped markup do not count.
const bad = (content.match(/\ufffd/g) || []).length;
if (bad > Math.max(5, content.length * 0.001)) throw new Error(`decoding_failed ${charset}: ${bad} replacement characters in the extracted text`);
return [{ json: {
  ...x, http_status: status, content_type: ctype.slice(0, 200), content,
  extractor: 'html_v1', bytes_b64: buf.toString('base64'),
  doc_metadata: { charset, charset_source: dec.source, invalid_bytes: dec.invalid_bytes,
                  charset_note: dec.note || null, replacement_chars: bad, selected, cut, raw_bytes: buf.length, fetch_ms: Date.now() - x.t0 },
} }];
