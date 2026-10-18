// wf.listing.trust > "Report": the stored report for the second app.listing_submit call, as in the v1 submit.
// A check that stored no report gives report_id null: app.listing_submit then answers 409 {trust: missing}.
const t = $input.first().json || {};
const p = $('Plan').first().json;
return [{ json: { params: [p.user_id, p.listing_id, JSON.stringify(t.ok ? { report_id: t.report_id } : { report_id: null })] } }];
