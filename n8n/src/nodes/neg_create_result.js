const v = $('Guard proposal').first().json;
const r = $input.first().json.r || {};
if (!r.ok) return [{json:{ok:false,gw:v.gw,status:409,error:{code:'CONFLICT',message:r.reason||'Proposal failed',details:[]}}}];
return [{json:{ok:true,gw:v.gw,status:201,data:{negotiation_id:r.id,status:r.status,round:r.round,
  version:r.version,currency:v.record.currency,offer_minor:v.proposal.amount_minor,
  model_used:v.proposal.model_used,rationale:v.proposal.rationale,
  notice:'Draft for renter review only; no message was sent to the landlord.'}}}];
