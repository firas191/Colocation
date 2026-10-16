const v = $('Validate decision').first().json;
const r = $input.first().json.r || {};
if (!r.ok) return [{json:{ok:false,gw:v.gw,status:r.reason==='not_found'?404:409,
  error:{code:r.reason==='not_found'?'NOT_FOUND':'CONFLICT',message:r.reason||'Decision rejected',details:[]}}}];
return [{json:{ok:true,gw:v.gw,data:r}}];
