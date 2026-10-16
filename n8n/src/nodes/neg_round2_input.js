const v = $('Validate decision').first().json;
const r = $input.first().json.r || {};
if (!r.ok) return [{json:{ok:false,gw:v.gw,status:r.reason==='not_found'?404:409,
  error:{code:'CONFLICT',message:r.reason||'Decision rejected',details:[]}}}];
return [{json:{ok:true,gw:v.gw,record:r,prompt:JSON.stringify({asking_minor:Number(r.asking_minor),
 target_minor:Number(r.target_minor),max_minor:Number(r.max_minor),counter_minor:Number(r.counter_minor),
 currency:r.currency,round:2})}}];
