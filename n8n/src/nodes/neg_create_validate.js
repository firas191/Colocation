/* @include lib/negotiation.js */
const gw = $input.first().json;
const b = gw.ctx.body || {};
const valid = uuid(b.listing_id) && minor(b.target_minor) && minor(b.max_minor)
  && b.target_minor <= b.max_minor && Object.keys(b).every(k => ['listing_id','target_minor','max_minor'].includes(k));
if (!valid) return [{json:{ok:false,gw,status:422,error:{code:'VALIDATION_FAILED',message:'Invalid listing or budget in minor units',details:[]}}}];
return [{json:{ok:true,gw,params:[gw.ctx.user_id,b.listing_id,b.target_minor,b.max_minor]}}];
