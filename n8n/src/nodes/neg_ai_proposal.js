/* @include lib/negotiation.js */
const v = $('AI input').first().json;
const r = v.record;
const output = $input.first().json || {};
const p = proposal(typeof output.output==='string'?output.output:'',{
  asking_minor:Number(r.asking_minor),target_minor:Number(r.target_minor),max_minor:Number(r.max_minor)});
return [{json:{ok:true,gw:v.gw,record:r,proposal:p,
  params:[null,r.id,r.version,'propose',p.amount_minor,JSON.stringify({model_used:p.model_used,rationale:p.rationale,
    request_id:v.gw.request_id,idempotency_key:v.gw.idempotency?.key||null})]}}];
