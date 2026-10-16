-- migrate:up
-- A4: database-owned negotiation state. All amounts are integer minor units.
insert into app.settings(key,value,description) values
 ('rent.negotiator_enabled','false','Enable A4 after APInex credential and live verification'),
 ('rent.negotiator_model','"free/gpt-6-luna"','APInex chat model for A4')
on conflict(key) do nothing;

create table app.negotiations (
 id uuid primary key default gen_random_uuid(),
 renter_id uuid not null references app.users(id),
 listing_id uuid not null references app.listings(id),
 landlord_id uuid references app.users(id),
 asking_minor bigint not null check(asking_minor > 0),
 currency char(3) not null references app.currencies(code),
 target_minor bigint not null check(target_minor > 0),
 max_minor bigint not null check(max_minor > 0),
 proposed_minor bigint check(proposed_minor > 0),
 counter_minor bigint check(counter_minor > 0),
 round smallint not null default 1 check(round between 1 and 2),
 status text not null default 'draft' check(status in ('draft','awaiting_renter','awaiting_landlord','landlord_countered','renter_rejected','landlord_rejected','tentative_agreement','unresolved','manual_review')),
 version integer not null default 0 check(version >= 0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check(target_minor <= max_minor),
 check(renter_id is distinct from landlord_id)
);
create index on app.negotiations(renter_id,created_at desc);
create table app.negotiation_events (
 id bigint generated always as identity primary key,
 negotiation_id uuid not null references app.negotiations(id) on delete cascade,
 version integer not null check(version > 0),
 actor_id uuid references app.users(id),
 actor_type text not null check(actor_type in ('renter','landlord','agent','system')),
 action text not null,
 round smallint not null check(round between 1 and 2),
 amount_minor bigint check(amount_minor > 0),
 currency char(3) not null references app.currencies(code),
 metadata jsonb not null default '{}',
 occurred_at timestamptz not null default now(),
 unique(negotiation_id,version)
);
create index on app.negotiation_events(negotiation_id,id);

create function app.negotiation_view(p_user uuid,p_id uuid) returns jsonb language sql stable as $$
 select jsonb_build_object('id',n.id,'listing_id',n.listing_id,'renter_id',n.renter_id,
  'landlord_id',n.landlord_id,'asking_minor',n.asking_minor,'currency',n.currency,
  'target_minor',n.target_minor,'max_minor',n.max_minor,'proposed_minor',n.proposed_minor,
  'counter_minor',n.counter_minor,'round',n.round,'status',n.status,'version',n.version,
  'history',coalesce((select jsonb_agg(jsonb_build_object('action',e.action,'actor_type',e.actor_type,
   'actor_id',e.actor_id,'round',e.round,'amount_minor',e.amount_minor,'currency',e.currency,
   'metadata',e.metadata,'occurred_at',e.occurred_at) order by e.id)
   from app.negotiation_events e where e.negotiation_id=n.id),'[]'::jsonb))
 from app.negotiations n where n.id=p_id and p_user in (n.renter_id,n.landlord_id)
$$;

create function app.negotiation_create(p_user uuid,p_listing uuid,p_target bigint,p_max bigint) returns jsonb
language plpgsql as $$
declare l record; n app.negotiations%rowtype;
begin
 if coalesce((select value #>> '{}' from app.settings where key='rent.negotiator_enabled'),'false') <> 'true' then
  return jsonb_build_object('ok',false,'reason','disabled'); end if;
 select id,owner_id,rent_monthly_minor,currency into l from app.listings
  where id=p_listing and status='published' and not is_synthetic;
 if not found or l.owner_id is null or l.owner_id=p_user or l.rent_monthly_minor is null then
  return jsonb_build_object('ok',false,'reason','listing_unavailable'); end if;
 if not exists(select 1 from app.users where id=l.owner_id and verified_level >= 1 and deleted_at is null) then
  return jsonb_build_object('ok',false,'reason','landlord_unverified'); end if;
 if p_target is null or p_max is null or p_target <= 0 or p_max <= 0 or p_target > p_max then
  return jsonb_build_object('ok',false,'reason','invalid_budget'); end if;
 insert into app.negotiations(renter_id,listing_id,landlord_id,asking_minor,currency,target_minor,max_minor)
 values(p_user,l.id,l.owner_id,l.rent_monthly_minor,l.currency,p_target,p_max) returning * into n;
 insert into app.negotiation_events(negotiation_id,version,actor_id,actor_type,action,round,currency,metadata)
 values(n.id,1,p_user,'renter','created',1,n.currency,jsonb_build_object('target_minor',p_target,'max_minor',p_max));
 update app.negotiations set version=1 where id=n.id;
 return jsonb_build_object('ok',true,'id',n.id,'currency',n.currency,'asking_minor',n.asking_minor,
  'target_minor',n.target_minor,'max_minor',n.max_minor,'round',1,'version',1,
  'model',coalesce((select value #>> '{}' from app.settings where key='rent.negotiator_model'),'free/gpt-6-luna'));
end $$;

create function app.negotiation_transition(p_actor uuid,p_id uuid,p_expected_version integer,p_action text,p_amount bigint default null,p_metadata jsonb default '{}') returns jsonb
language plpgsql as $$
declare n app.negotiations%rowtype; new_status text; new_round smallint; who text;
begin
 select * into n from app.negotiations where id=p_id for update;
 if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
 if p_expected_version is distinct from n.version then return jsonb_build_object('ok',false,'reason','stale'); end if;
 if p_action <> 'propose' and (p_metadata->>'submitted_currency' is distinct from n.currency::text
  or (p_metadata->>'submitted_round')::smallint is distinct from n.round) then
  return jsonb_build_object('ok',false,'reason','offer_mismatch'); end if;
 who:=case when p_actor=n.renter_id then 'renter' when p_actor=n.landlord_id then 'landlord' else null end;
 if who='landlord' and not exists(select 1 from app.users where id=p_actor and verified_level >= 1 and deleted_at is null) then
  return jsonb_build_object('ok',false,'reason','landlord_unverified'); end if;
 if p_action='propose' and p_actor is null and n.status in ('draft','landlord_countered') then
  if p_amount is null or p_amount <= 0 or p_amount > n.max_minor or p_amount > n.asking_minor
    or (n.round=2 and p_amount > n.counter_minor) then
   return jsonb_build_object('ok',false,'reason','over_budget_or_invalid'); end if;
  new_status:='awaiting_renter'; new_round:=n.round;
 elsif p_action in ('approve','reject') and who='renter' and n.status='awaiting_renter' and p_amount=n.proposed_minor then
  new_status:=case when p_action='approve' then 'awaiting_landlord' else 'renter_rejected' end; new_round:=n.round;
 elsif p_action in ('accept','reject','counter') and who='landlord' and n.status='awaiting_landlord' then
  if p_action='counter' and (p_amount is null or p_amount <= 0) then return jsonb_build_object('ok',false,'reason','invalid_amount'); end if;
  if p_action<>'counter' and p_amount is distinct from n.proposed_minor then return jsonb_build_object('ok',false,'reason','offer_mismatch'); end if;
  new_status:=case when p_action='accept' then 'tentative_agreement' when p_action='reject' then 'landlord_rejected'
   when n.round=2 then 'unresolved' else 'landlord_countered' end;
  new_round:=case when p_action='counter' and n.round=1 then 2 else n.round end;
 else return jsonb_build_object('ok',false,'reason','unauthorized_or_invalid_transition'); end if;
 update app.negotiations set status=new_status,round=new_round,version=version+1,updated_at=now(),
  proposed_minor=case when p_action='propose' then p_amount else proposed_minor end,
  counter_minor=case when p_action='counter' then p_amount else counter_minor end where id=n.id;
 insert into app.negotiation_events(negotiation_id,version,actor_id,actor_type,action,round,amount_minor,currency,metadata)
 values(n.id,n.version+1,p_actor,coalesce(who,'agent'),p_action,n.round,p_amount,n.currency,coalesce(p_metadata,'{}'));
 return jsonb_build_object('ok',true,'id',n.id,'status',new_status,'round',new_round,'version',n.version+1,
  'asking_minor',n.asking_minor,'target_minor',n.target_minor,'max_minor',n.max_minor,'currency',n.currency,
  'counter_minor',case when p_action='counter' then p_amount else n.counter_minor end,
  'model',coalesce((select value #>> '{}' from app.settings where key='rent.negotiator_model'),'free/gpt-6-luna'));
end $$;

revoke all on app.negotiations,app.negotiation_events from public;
grant select,insert,update on app.negotiations,app.negotiation_events to n8n_worker;
grant usage,select on sequence app.negotiation_events_id_seq to n8n_worker;
revoke execute on function app.negotiation_view(uuid,uuid),app.negotiation_create(uuid,uuid,bigint,bigint),app.negotiation_transition(uuid,uuid,integer,text,bigint,jsonb) from public;
grant execute on function app.negotiation_view(uuid,uuid),app.negotiation_create(uuid,uuid,bigint,bigint),app.negotiation_transition(uuid,uuid,integer,text,bigint,jsonb) to n8n_worker;

-- migrate:down
drop function if exists app.negotiation_transition(uuid,uuid,integer,text,bigint,jsonb);
drop function if exists app.negotiation_create(uuid,uuid,bigint,bigint);
drop function if exists app.negotiation_view(uuid,uuid);
drop table if exists app.negotiation_events;
drop table if exists app.negotiations;
delete from app.settings where key in ('rent.negotiator_enabled','rent.negotiator_model');
