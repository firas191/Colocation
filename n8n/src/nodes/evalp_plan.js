// wf.eval.prompts > "Plan"
// Input: job row with the dataset's items, the requested prompt versions and the extraction
// context of every jurisdiction. Output: one item per run to create (model x version).
// Throws (job fails) when the dataset, a version or the items are missing.
const row = $input.first().json;
if (!row.job_id) throw new Error('job not found or already finished');
const inp = row.input;
if (!row.dataset_id) throw new Error(`dataset ${inp.dataset} v${inp.dataset_version} not found`);
const want = { P1_router: 'routing', P2_profile_extractor: 'extraction' }[inp.prompt];
if (row.kind !== want) throw new Error(`dataset ${inp.dataset} is of kind ${row.kind}, prompt ${inp.prompt} needs ${want}`);
const found = (row.versions || []).map((v) => v.version);
const missing = inp.versions.filter((v) => !found.includes(v));
if (missing.length) throw new Error(`${inp.prompt}: versions not in the registry: ${missing.join(', ')} (run scripts/prompts.py sync)`);
let items = row.queries || [];
if (inp.item_ids) items = items.filter((q) => inp.item_ids.includes(q.external_id));
if (inp.limit) items = items.slice(0, inp.limit);
if (!items.length) throw new Error('no items to evaluate');
const models = inp.models || [row.default_model];
const runs = [];
for (const model of models) {
  for (const v of row.versions) {
    runs.push({ key: `${model}|${v.version}`, prompt_version_id: v.version_id,
      config: { prompt: inp.prompt, version: v.version, model, items: items.length, label: inp.label, kind: 'prompt' } });
  }
}
return [{ json: { job_id: row.job_id, dataset_id: row.dataset_id, git_sha: inp.git_sha, runs, item_ids: items.map((q) => q.id) } }];
