// wf.api.listings_submit > "Trust report": the check's stored report for the second app.listing_submit call. A
// failed check gives no report: the submit then answers 409 {field: trust, issue: missing} and nothing is published.
const t = $input.first().json || {};
const v = $('Validate').first().json;
return [{ json: { params: [v.gw.ctx.user_id, v.input.params.id, JSON.stringify(t.ok ? { report_id: t.report_id } : { report_id: null })] } }];
