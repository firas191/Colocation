// wf.legal.agent > "Check answer"
// The AI Agent node's answer -> a checked answer with its citations, or an abstention (spec 10.6), and one trace step.
//  - [NOT_FOUND] from the model, no search made, or no valid [n] marker left -> abstained (abstain_reason says which)
//  - markers whose number search_law did not give are removed (warning legal_invalid_citation); the kept ones are
//    renumbered 1, 2, ... and the citations list follows that order
//  - every number in the answer must come from the message, the memory or an excerpt (agent_check.checkAnswer);
//    otherwise -> abstained, reason unsupported_numbers (a wrong delay or amount is worse than no answer)
//  - no answer at all (model down, too many iterations) -> ok false, and the orchestrator answers 503
/* @include lib/agent_check.js */
/* @include lib/legal_check.js */
const a = $('Agent input').first().json;
const r = $('Legal agent').first().json;
const src = ($input.first().json || {}).s || { sources: [], searches: 0, best_similarity: null };
const calls = toolCalls(r.intermediateSteps);
const latency = Date.now() - a.t0;
const err = r.error ? String(r.error.message || r.error).slice(0, 300) : null;
const raw = typeof r.output === 'string' ? r.output.trim() : '';
const markdown = /\*\*|__|^\s*(?:[-*+•]|#{1,6})\s|\[[^\]]+\]\(/m.test(raw);
const searches = calls.filter((x) => x.tool === 'search_law');
const sources = Array.isArray(src.sources) ? src.sources : [];
const byN = new Map(sources.map((x) => [Number(x.n), x]));
const p = parseLegal(plainText(raw));
const warnings = [];
let status = 'answered';
let reason = null;
let answer = null;
let missing = null;
let used = [];
let invalid = [];
let cut = false;
let unc = 0;
const sourcesText = [a.text, a.memory_text, ...calls.map((x) => x.output)];
if (!err && raw) {
  if (p.notFound) {
    status = 'abstained'; reason = 'not_found';
    const t = stripMarkers(p.text);
    if (t && checkAnswer(t, sourcesText).ok) missing = shorten(t, 300).text;
  } else if (!searches.length) {
    status = 'abstained'; reason = 'no_search';
  } else {
    const rn = renumber(p.text, [...byN.keys()]);
    invalid = rn.invalid;
    if (invalid.length) warnings.push('legal_invalid_citation');
    if (!rn.used.length) { status = 'abstained'; reason = 'no_citation'; }
    else {
      const chk = checkAnswer(stripMarkers(rn.text), sourcesText);
      if (!chk.ok) { status = 'abstained'; reason = 'unsupported_numbers'; }
      else {
        const sh = shorten(rn.text, a.answer_max_chars || 900);
        answer = sh.text; cut = sh.cut;
        if (cut) warnings.push('legal_answer_cut');
        // citations still in the text after the cut (numbered by first appearance, so a cut keeps 1..j)
        const left = new Set(markers(answer));
        used = rn.used.filter((n, i) => left.has(i + 1));
        if (!used.length) { status = 'abstained'; reason = 'no_citation'; answer = null; }
        else {
          unc = uncited(answer);
          if (unc) warnings.push('legal_uncited_sentences');
        }
      }
    }
  }
}
const ok = !err && !!raw;
const citations = used.map((n, i) => {
  const x = byN.get(n) || {};
  return { n: i + 1, title: x.title || null, cite_as: x.cite_as || null, url: x.url || null, source_type: x.source_type || null,
    reliability: x.reliability ?? null, article: x.article || null, retrieved_at: x.retrieved_at || null, chunk_id: x.chunk_id || null };
});
const conflict = status === 'answered' && p.conflict;
// no raw text in the trace (D-062): sizes, counts and chunk ids only
const step = { agent: 'A5_legal_agent', prompt_version_id: a.prompt_version_id || null, model: a.model || null,
  input: { chars: Array.from(a.text || '').length, memory_messages: a.memory_messages ?? null },
  output: { status, abstain_reason: reason, conflict, conflict_token: p.conflict, answer_chars: answer ? Array.from(answer).length : 0,
            raw_chars: Array.from(raw).length, markdown_removed: markdown, cut, citations: citations.length,
            invalid_citations: invalid.length, uncited_sentences: unc, searches: searches.length,
            best_similarity: src.best_similarity ?? null,
            retrieved: sources.filter((x) => x.request_id === a.request_id)
              .map((x) => ({ n: x.n, chunk_id: x.chunk_id, similarity: x.similarity ?? null })) },
  tool_calls: calls.map((x) => ({ tool: x.tool,
    input_chars: x.input && x.input.query ? Array.from(String(x.input.query)).length : undefined,
    found: x.output && typeof x.output === 'object' ? (x.output.found ?? null) : null })),
  latency_ms: latency, tokens_in: null, tokens_out: null,
  error: err || (ok ? null : 'no_answer') };
if (!ok) return [{ json: { ok: false, error_code: err ? 'agent_failed' : 'no_answer', steps: [step] } }];
return [{ json: { ok: true, status, answer, abstained: status === 'abstained', abstain_reason: reason, conflict, citations,
  missing_information: missing, notice_version: a.notice_version, warnings, steps: [step],
  agent: { tool_calls: calls.map((x) => x.tool), memory_messages: a.memory_messages } } }];
