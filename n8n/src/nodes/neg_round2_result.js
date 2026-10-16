const v = $('Guard round 2').first().json;
const r = $input.first().json.r || {};
if (!r.ok) return [{json:{ok:false,gw:v.gw,status:409,error:{code:'CONFLICT',message:r.reason||'Proposal failed',details:[]}}}];
return [{json:{ok:true,gw:v.gw,data:{...r,currency:v.record.currency,offer_minor:v.proposal.amount_minor,
 model_used:v.proposal.model_used,rationale:v.proposal.rationale,
 notice:'Round 2 draft for renter review only; no message was sent.'}}}];
