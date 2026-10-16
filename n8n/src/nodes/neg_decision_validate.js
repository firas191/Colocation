/* @include lib/negotiation.js */
const gw = $input.first().json;
const b = gw.ctx.body || {};
const role = '__ROLE__';
const actions = role === 'renter' ? ['approve','reject'] : ['accept','reject','counter'];
const valid = uuid(gw.ctx.params.id) && Number.isSafeInteger(b.version) && b.version >= 1
  && actions.includes(b.action) && minor(b.offer_minor)
  && Object.keys(b).every(k => ['version','action','offer_minor','currency','round'].includes(k))
  && typeof b.currency === 'string' && /^[A-Z]{3}$/.test(b.currency)
  && (b.round === 1 || b.round === 2);
if (!valid) return [{json:{ok:false,gw,status:422,error:{code:'VALIDATION_FAILED',message:'Decision must identify offer, round, currency and version',details:[]}}}];
return [{json:{ok:true,gw,body:b,role,params:[gw.ctx.user_id,gw.ctx.params.id,b.version,b.action,b.offer_minor,
  JSON.stringify({submitted_round:b.round,submitted_currency:b.currency,
    request_id:gw.request_id,idempotency_key:gw.idempotency?.key||null})]}}];
