// wf.legal.tool_search > "Tool answer": what the model sees, numbered excerpts with their source.
const r = $input.first().json.r || {};
const ex = r.excerpts || [];
if (!ex.length) return [{ json: { found: 0, note: 'No excerpt found for this query.', excerpts: [] } }];
return [{ json: { found: ex.length, excerpts: ex.map((e) => ({ n: e.n, source: e.source, type: e.type,
  article: e.article || null, text: e.text })) } }];
