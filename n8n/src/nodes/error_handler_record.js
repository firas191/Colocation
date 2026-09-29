// wf.ops.error_handler > "Build record"
// Input from the Error Trigger. Keeps only what is needed to find the failure:
// no input data, which may contain personal data.
const e = $input.first().json;
const ex = e.execution || {};
const wf = e.workflow || {};
const err = ex.error || e.trigger?.error || {};
return [{ json: {
  workflow: String(wf.name || wf.id || 'unknown'),
  n8n_execution_id: ex.id != null ? String(ex.id) : null,
  error: `${err.name || 'Error'}: ${String(err.message || 'unknown error').slice(0, 500)} (node: ${ex.lastNodeExecuted || 'unknown'}, mode: ${ex.mode || 'unknown'})`,
} }];
