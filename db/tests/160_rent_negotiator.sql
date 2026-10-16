-- A4 state machine, ownership, amount, two-round and stale-version checks.
\ir helpers.psql
begin;
select plan(16);
insert into app.jurisdictions(code,country_code,name,default_currency,default_locale,timezone)
values('ZR','ZR','Negotiator test','TND','fr','UTC');
insert into app.users(id,email,role,jurisdiction_code,verified_level) values
 ('00000000-0000-0000-0000-0000000001a1','rent-a@example.test','user','ZR',1),
 ('00000000-0000-0000-0000-0000000001a2','owner-a@example.test','owner','ZR',1),
 ('00000000-0000-0000-0000-0000000001a3','other-a@example.test','user','ZR',1);
insert into app.listings(id,owner_id,jurisdiction_code,status,rent_minor,currency,source,is_synthetic)
values('00000000-0000-0000-0000-0000000001b1','00000000-0000-0000-0000-0000000001a2','ZR','published',600000,'TND','user',false);
select is(app.negotiation_create('00000000-0000-0000-0000-0000000001a1','00000000-0000-0000-0000-0000000001b1',450000,500000)->>'reason','disabled','off by default');
update app.settings set value='true' where key='rent.negotiator_enabled';
select is(app.negotiation_create('00000000-0000-0000-0000-0000000001a1','00000000-0000-0000-0000-0000000001b1',501000,500000)->>'reason','invalid_budget','target cannot exceed max');
create temp table a4 as select app.negotiation_create('00000000-0000-0000-0000-0000000001a1','00000000-0000-0000-0000-0000000001b1',450000,500000) r;
select is((select r->>'ok' from a4),'true','created');
select is(app.negotiation_view('00000000-0000-0000-0000-0000000001a3',(select (r->>'id')::uuid from a4)),null,'nonparticipant cannot view');
select is((select app.negotiation_transition(null,(r->>'id')::uuid,1,'propose',510000)->>'reason' from a4),'over_budget_or_invalid','AI over budget blocked');
select is((select app.negotiation_transition(null,(r->>'id')::uuid,1,'propose',450000)->>'status' from a4),'awaiting_renter','first proposal');
select is((select app.negotiation_transition('00000000-0000-0000-0000-0000000001a3',(r->>'id')::uuid,2,'approve',450000,'{"submitted_currency":"TND","submitted_round":1}')->>'reason' from a4),'unauthorized_or_invalid_transition','other user cannot approve');
select is((select app.negotiation_transition('00000000-0000-0000-0000-0000000001a1',(r->>'id')::uuid,2,'approve',450000,'{"submitted_currency":"EUR","submitted_round":1}')->>'reason' from a4),'offer_mismatch','wrong currency blocked');
select is((select app.negotiation_transition('00000000-0000-0000-0000-0000000001a1',(r->>'id')::uuid,2,'approve',450000,'{"submitted_currency":"TND","submitted_round":1}')->>'status' from a4),'awaiting_landlord','renter approved exact offer');
select is((select app.negotiation_transition('00000000-0000-0000-0000-0000000001a1',(r->>'id')::uuid,2,'approve',450000,'{"submitted_currency":"TND","submitted_round":1}')->>'reason' from a4),'stale','duplicate approval blocked');
select is((select app.negotiation_transition('00000000-0000-0000-0000-0000000001a2',(r->>'id')::uuid,3,'counter',480000,'{"submitted_currency":"TND","submitted_round":1}')->>'round' from a4),'2','first counter starts second round');
select is((select app.negotiation_transition(null,(r->>'id')::uuid,4,'propose',480001)->>'reason' from a4),'over_budget_or_invalid','second offer over counter blocked');
select is((select app.negotiation_transition(null,(r->>'id')::uuid,4,'propose',470000)->>'status' from a4),'awaiting_renter','second draft');
select is((select app.negotiation_transition('00000000-0000-0000-0000-0000000001a1',(r->>'id')::uuid,5,'approve',470000,'{"submitted_currency":"TND","submitted_round":2}')->>'status' from a4),'awaiting_landlord','round two approved');
select is((select app.negotiation_transition('00000000-0000-0000-0000-0000000001a2',(r->>'id')::uuid,6,'counter',490000,'{"submitted_currency":"TND","submitted_round":2}')->>'status' from a4),'unresolved','second counter stops automation');
select is((select jsonb_array_length(app.negotiation_view('00000000-0000-0000-0000-0000000001a1',(r->>'id')::uuid)->'history') from a4),7,'full event history');
select * from finish();
rollback;
