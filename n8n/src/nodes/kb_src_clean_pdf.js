// wf.kb.ingest_source > "Clean PDF"
// Input: the Extract From File (PDF) result with one text per page and the
// original response kept (keepSource = both). Pages -> paragraphs (kb/lib/text.js).
/* @include kb/lib/text.js */
const x = $('Robots decision').first().json;
const r = $input.first().json;
const status = Number(r.statusCode || 0);
if (status < 200 || status >= 300) throw new Error(`fetch_http_${status || 'error'} ${x.source.url}`);
const pages = Array.isArray(r.text) ? r.text : [String(r.text || '')];
const buf = await this.helpers.getBinaryDataBuffer(0, 'data');
const f = x.source.fetch || {};
const out = pdfPagesToText(pages);
if (out.text.length < (f.min_chars || 200)) throw new Error(`extracted_too_short ${out.text.length} chars (scanned PDF without a text layer?)`);
return [{ json: {
  ...x, http_status: status, content_type: String((r.headers || {})['content-type'] || 'application/pdf').slice(0, 200),
  content: out.text, extractor: 'pdf_v1', bytes_b64: buf.toString('base64'),
  doc_metadata: { pages: out.pages, lines_dropped: out.lines_dropped, raw_bytes: buf.length,
                  pdf_info: r.info ? { Title: r.info.Title || null, Producer: r.info.Producer || null } : null,
                  fetch_ms: Date.now() - x.t0 },
} }];
