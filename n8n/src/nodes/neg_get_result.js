const gw = $('Gateway').first().json;
const v = $input.first().json.v;
if (!v) return [{json:{ok:false,gw,status:404,error:{code:'NOT_FOUND',message:'Negotiation not found',details:[]}}}];
return [{json:{ok:true,gw,data:v}}];
