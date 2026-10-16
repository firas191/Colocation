const v = $('Validate body').first().json;
const r = $input.first().json.r || {};
if (!r.ok) return [{json:{ok:false,gw:v.gw,status:r.reason==='disabled'?503:422,
  error:{code:r.reason==='disabled'?'AGENT_DISABLED':'VALIDATION_FAILED',message:r.reason||'Negotiation unavailable',details:[]}}}];
const prompt = JSON.stringify({asking_minor:Number(r.asking_minor),target_minor:Number(r.target_minor),
  max_minor:Number(r.max_minor),currency:r.currency,round:1});
return [{json:{ok:true,gw:v.gw,record:r,prompt}}];
