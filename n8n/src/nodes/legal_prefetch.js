// wf.legal.agent > "Prefetch": the excerpts found for the question, as the text the system message shows the model
// ({{excerpts}} in P5 v2). Numbered like the search tool's, so the model cites them as [n].
const r = $input.first().json.r || {};
const ex = r.excerpts || [];
const text = ex.length
  ? ex.map((e) => `[${e.n}] Source: ${e.source}; type: ${e.type}${e.article ? `; ${e.article}` : ''}\n${String(e.text || '').trim()}`).join('\n\n')
  : '(no excerpt found)';
return [{ json: { found: ex.length, mode: r.mode || null, best_similarity: r.best_similarity ?? null, excerpts_text: text,
  vars: { excerpts: text } } }];
