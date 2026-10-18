-- migrate:up
-- Platform phase P9 (docs/PLATFORM_SPEC.md 3.7, 3.8, 9 P9; DECISIONS D-108): household documents rendered to PDF from
-- the templates of kb/templates, the Document agent's drafts, and the facts the templates are filled from.

insert into app.settings (key, value, description) values
  ('documents.notice_version', '"documents-notice-v1"', 'Notice printed on every document: a model, not legal advice (D-108)'),
  ('documents.agent_enabled', 'true', 'Use the Document agent (A6) on the documents page. Off: the forms only'),
  ('documents.agent_max_iterations', '6', 'Most model turns of the Document agent'),
  ('documents.agent_memory_turns', '4', 'Turns of the conversation the Document agent remembers'),
  ('documents.num_ctx', '8192', 'Context window of the Document agent'),
  ('documents.per_day', '30', 'Most documents one user may make in a day')
on conflict (key) do nothing;

create table home.documents (
  id                uuid primary key default gen_random_uuid(),
  household_id      uuid not null references home.households(id) on delete cascade,
  kind              text not null check (kind in ('flatmate_agreement', 'inventory_entry', 'inventory_exit', 'rent_receipt', 'house_rules')),
  jurisdiction_code text not null,
  language          text not null check (language in ('fr', 'ar', 'en')),
  template_key      text not null,
  template_version  int not null,
  inputs            jsonb not null,                -- the slot values printed (rent receipt: from the confirmed payment)
  sources           jsonb not null,                -- [{cite_as, title, url, retrieved_at, publisher}] as printed
  notice_version    text not null,
  status            text not null check (status in ('ready', 'failed')),
  storage_key       text,
  bytes             int,
  sha256            text,
  payment_id        uuid references home.rent_payments(id) on delete set null,
  draft_id          uuid,
  error_code        text,
  created_by        uuid references app.users(id) on delete set null,
  created_at        timestamptz not null default now()
);
create index documents_household on home.documents (household_id, created_at desc);
create table home.document_drafts (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references home.households(id) on delete cascade,
  user_id      uuid not null references app.users(id) on delete cascade,
  kind         text not null,
  language     text not null,
  slot_values  jsonb not null,                     -- only slots the template knows (checked in code before this)
  missing      jsonb not null default '[]',
  used_at      timestamptz,
  created_at   timestamptz not null default now()
);
alter table home.documents enable row level security;        alter table home.documents force row level security;
alter table home.document_drafts enable row level security;  alter table home.document_drafts force row level security;
create policy documents_members on home.documents for select using (household_id in (select home.my_households()));
create policy documents_insert on home.documents for insert with check (household_id in (select home.my_households()) and created_by = app.current_user_id());
create policy drafts_own on home.document_drafts for all using (user_id = app.current_user_id() and household_id in (select home.my_households()))
  with check (user_id = app.current_user_id() and household_id in (select home.my_households()));
grant select, insert on home.documents to app_rls;
grant select, insert, update on home.document_drafts to app_rls;

create or replace function api._document_json(d home.documents) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('document_id', d.id, 'household_id', d.household_id, 'kind', d.kind, 'jurisdiction_code', d.jurisdiction_code,
    'language', d.language, 'template', jsonb_build_object('key', d.template_key, 'version', d.template_version), 'sources', d.sources,
    'notice_version', d.notice_version, 'status', d.status, 'bytes', d.bytes, 'created_at', d.created_at, 'created_by', api._name(d.created_by),
    'error_code', d.error_code)
$$;

-- Facts a template is filled from, and who may make which kind (7.3): a rent receipt is made by the owner member from a
-- rent payment they confirmed; the flatmate agreement by a flatmate; the inventories and house rules by any member.
create or replace function api.document_facts(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; b jsonb := coalesce(p->'body', '{}'); v_kind text := b->>'kind'; e jsonb; h home.households;
  r home.rent_payments; f jsonb; v_role text; v_today int;
begin
  perform api._as(p_user);
  e := api._need(v_id);
  if e is not null then return e; end if;
  h := api._hh(v_id);
  v_role := api._my_role(v_id);
  if v_kind = 'rent_receipt' and v_role <> 'owner' then return api._err(403, 'FORBIDDEN', 'Rent receipts are made by the owner member'); end if;
  if v_kind = 'flatmate_agreement' and v_role <> 'flatmate' then return api._err(403, 'FORBIDDEN', 'The agreement is made by a flatmate'); end if;
  select count(*) into v_today from home.documents where created_by = p_user and created_at > now() - interval '1 day';
  if v_today >= api._setting_int('documents.per_day', 30) then
    return api._err(429, 'RATE_LIMITED', 'Too many documents today', jsonb_build_array(jsonb_build_object('retry_after_s', 3600)));
  end if;
  f := jsonb_build_object(
    'household', h.name, 'address', h.address_text,
    'landlord', (select string_agg(api._name(m.user_id)->>'display_name', ', ' order by m.joined_at) from home.household_members m
                  where m.household_id = v_id and m.role = 'owner' and m.status in ('active', 'leaving')),
    'occupants', (select string_agg(api._name(m.user_id)->>'display_name', ', ' order by m.joined_at) from home.household_members m
                   where m.household_id = v_id and m.role = 'flatmate' and m.status in ('active', 'leaving')),
    'rules', (select jsonb_agg(jsonb_build_object('category', category, 'text', text) order by position) from home.house_rules where household_id = v_id));
  f := f || jsonb_build_object('flatmates', f->'occupants');
  if v_kind = 'rent_receipt' then
    select * into r from home.rent_payments where id = (b->>'payment_id')::uuid and household_id = v_id;
    if r.id is null then return api._err(404, 'NOT_FOUND', 'Rent payment not found'); end if;
    if r.confirmed_at is null then
      return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', '[{"field": "payment_id", "issue": "payment_not_confirmed"}]');
    end if;
    f := f || jsonb_build_object('tenant', api._name(r.user_id)->>'display_name', 'period', r.period, 'amount', r.amount_minor,
      'paid_on', r.paid_on, 'confirmed_on', (r.confirmed_at at time zone h.timezone)::date, 'payment_id', r.id);
  end if;
  return api._ok(jsonb_build_object('household_id', h.id, 'jurisdiction_code', h.jurisdiction_code, 'currency', h.currency,
    'exponent', api._exp(h.currency), 'country', (select name from app.jurisdictions where code = h.jurisdiction_code), 'my_role', v_role,
    'today', (now() at time zone h.timezone)::date, 'facts', f,
    'notice_version', coalesce((select value #>> '{}' from app.settings where key = 'documents.notice_version'), 'documents-notice-v1')));
end $$;

-- After the PDF was written (or failed): the document row, as the person sees it
create or replace function api.document_store(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare d home.documents; s jsonb := p->'store';
begin
  perform api._as(p_user);
  insert into home.documents (household_id, kind, jurisdiction_code, language, template_key, template_version, inputs, sources, notice_version,
                              status, storage_key, bytes, sha256, payment_id, draft_id, error_code, created_by)
  values ((s->>'household_id')::uuid, s->>'kind', s->>'jurisdiction_code', s->>'language', s->>'template_key', (s->>'template_version')::int,
          s->'inputs', coalesce(s->'sources', '[]'), s->>'notice_version', s->>'status', s->>'storage_key', (s->>'bytes')::int, s->>'sha256',
          (s->>'payment_id')::uuid, (s->>'draft_id')::uuid, s->>'error_code', p_user)
  returning * into d;
  if d.draft_id is not null then update home.document_drafts set used_at = now() where id = d.draft_id; end if;
  if d.status <> 'ready' then
    return api._err(503, 'UPSTREAM_UNAVAILABLE', 'The document could not be made',
                    jsonb_build_array(jsonb_build_object('issue', coalesce(d.error_code, 'render_failed'), 'document_id', d.id)));
  end if;
  return api._ok(api._document_json(d) || jsonb_build_object('storage_key', d.storage_key), 201);
end $$;

create or replace function api.documents_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb;
begin
  perform api._as(p_user);
  e := api._need(v_id);
  if e is not null then return e; end if;
  return api._ok(jsonb_build_object('items', coalesce((select jsonb_agg(api._document_json(d) order by d.created_at desc)
    from (select * from home.documents where household_id = v_id order by created_at desc limit 100) d), '[]')));
end $$;

-- GET /v1/documents/{id}: the row and the storage key the workflow signs (the key never reaches the client)
create or replace function api.document_get(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare d home.documents;
begin
  perform api._as(p_user);
  select * into d from home.documents where id = (p#>>'{params,id}')::uuid;
  if d.id is null then return api._err(404, 'NOT_FOUND', 'Document not found'); end if;
  return api._ok(api._document_json(d) || jsonb_build_object('storage_key', d.storage_key, 'inputs', d.inputs));
end $$;

-- The Document agent's proposal (A6): stored for the person, confirmed with POST .../documents {draft_id}
create or replace function api.document_draft_put(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p->>'household_id')::uuid; e jsonb; d home.document_drafts;
begin
  perform api._as(p_user);
  e := api._need(v_id);
  if e is not null then return e; end if;
  insert into home.document_drafts (household_id, user_id, kind, language, slot_values, missing)
  values (v_id, p_user, p->>'kind', coalesce(p->>'language', 'fr'), coalesce(p->'values', '{}'), coalesce(p->'missing', '[]'))
  returning * into d;
  return api._ok(jsonb_build_object('draft_id', d.id, 'kind', d.kind, 'language', d.language, 'values', d.slot_values, 'missing', d.missing), 201);
end $$;
create or replace function api.document_draft_get(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare d home.document_drafts;
begin
  perform api._as(p_user);
  select * into d from home.document_drafts where id = (p->>'draft_id')::uuid and household_id = (p->>'household_id')::uuid
     and used_at is null and created_at > now() - interval '1 day';
  if d.id is null then return api._err(404, 'NOT_FOUND', 'Draft not found'); end if;
  return api._ok(jsonb_build_object('draft_id', d.id, 'kind', d.kind, 'language', d.language, 'values', d.slot_values, 'missing', d.missing));
end $$;
-- the conversation's last proposal for the answer (the agent's text is not trusted for it)
create or replace function api.document_draft_last(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare d home.document_drafts;
begin
  perform api._as(p_user);
  select * into d from home.document_drafts where household_id = (p->>'household_id')::uuid and created_at >= (p->>'since')::timestamptz
   order by created_at desc limit 1;
  if d.id is null then return api._ok(jsonb_build_object('draft', null)); end if;
  return api._ok(jsonb_build_object('draft', jsonb_build_object('draft_id', d.id, 'kind', d.kind, 'language', d.language,
    'values', d.slot_values, 'missing', d.missing)));
end $$;

do $$
declare f text;
  internal text[] := array['api._document_json(home.documents)'];
  public_ text[] := array['api.document_facts(uuid, jsonb)', 'api.document_store(uuid, jsonb)', 'api.documents_list(uuid, jsonb)',
    'api.document_get(uuid, jsonb)', 'api.document_draft_put(uuid, jsonb)', 'api.document_draft_get(uuid, jsonb)', 'api.document_draft_last(uuid, jsonb)'];
begin
  foreach f in array internal || public_ loop
    execute format('alter function %s owner to app_rls', f);
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to app_rls', f);
  end loop;
  foreach f in array public_ loop execute format('grant execute on function %s to n8n_worker', f); end loop;
end $$;

-- migrate:down
drop function if exists api.document_draft_last(uuid, jsonb), api.document_draft_get(uuid, jsonb), api.document_draft_put(uuid, jsonb),
  api.document_get(uuid, jsonb), api.documents_list(uuid, jsonb), api.document_store(uuid, jsonb), api.document_facts(uuid, jsonb),
  api._document_json(home.documents);
drop table if exists home.document_drafts, home.documents;
delete from app.settings where key in ('documents.notice_version', 'documents.agent_enabled', 'documents.agent_max_iterations',
  'documents.agent_memory_turns', 'documents.num_ctx', 'documents.per_day');
