// wf.eval.prompts > "Expand"
// One item per (run, dataset item), grouped by model so Ollama loads each model once.
const plan = $('Plan').first().json;
const start = $('Start job').first().json;
const created = $input.all().map((i) => i.json);
const byKey = Object.fromEntries(created.map((r) => [r.key, r.id]));
const items = (start.queries || []).filter((q) => plan.item_ids.includes(q.id));
const out = [];
for (const r of plan.runs) {
  for (const q of items) {
    out.push({ json: { run_id: byKey[r.key], prompt: r.config.prompt, version: r.config.version, model: r.config.model,
      query_id: q.id, external_id: q.external_id, message: q.query, labels: q.gold.labels, context: q.gold.context, tags: q.tags } });
  }
}
return out;
