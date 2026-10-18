-- migrate:up
-- Platform phase P10 (docs/PLATFORM_SPEC.md 3.9, 7.4, 9 P10; backend spec 13.5, 13.6; DECISIONS D-109): moving out
-- (checklist, deposits, leaving with the balance), the exit inventory compared with the entry one, deleting one's
-- account (DELETE /v1/me) with its stored files, and the retention run.

insert into app.settings (key, value, description) values
  ('retention.drafts_days', '7', 'Document drafts not used are deleted after this many days (D-109, a choice)'),
  ('retention.notifications_days', '180', 'Read notifications are deleted after this many days (D-109, a choice)'),
  ('retention.search_hits_days', '180', 'Saved-search alert records are deleted after this many days (D-109, a choice)'),
  ('retention.idempotency_days', '2', 'Stored idempotent answers are deleted after this many days (D-109, a choice)')
on conflict (key) do nothing;

-- 1. Deposits: what each flatmate paid, who holds it, what came back and why something was kept
create table home.deposits (
  household_id   uuid not null references home.households(id) on delete cascade,
  user_id        uuid not null references app.users(id) on delete cascade,
  amount_minor   bigint not null check (amount_minor > 0),
  paid_on        date,
  held_by        text not null default 'owner' check (held_by in ('owner', 'flatmates')),
  returned_minor bigint check (returned_minor >= 0),
  returned_on    date,
  deductions     jsonb not null default '[]',        -- [{reason, amount_minor}]
  updated_by     uuid references app.users(id) on delete set null,
  updated_at     timestamptz not null default now(),
  primary key (household_id, user_id),
  check (returned_minor is null or returned_minor <= amount_minor)
);
-- 2. Moving out: one open move-out per member; the checklist's manual items (the others are computed)
create table home.move_outs (
  household_id uuid not null references home.households(id) on delete cascade,
  user_id      uuid not null references app.users(id) on delete cascade,
  planned_on   date not null,
  manual       jsonb not null default '{}',          -- {"keys_returned": true, "bills_transferred": false, "notice_flatmates": true}
  created_at   timestamptz not null default now(),
  primary key (household_id, user_id)
);
alter table home.deposits enable row level security;   alter table home.deposits force row level security;
alter table home.move_outs enable row level security;  alter table home.move_outs force row level security;
create policy deposits_members on home.deposits for all using (household_id in (select home.my_households()))
  with check (household_id in (select home.my_households()));
create policy moveouts_members on home.move_outs for all using (household_id in (select home.my_households()))
  with check (household_id in (select home.my_households()));
grant select, insert, update on home.deposits, home.move_outs to app_rls;

create or replace function api._deposit_json(d home.deposits) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('user', api._name(d.user_id), 'amount', api._money(d.amount_minor, h.currency), 'paid_on', d.paid_on, 'held_by', d.held_by,
    'returned', case when d.returned_minor is null then null else api._money(d.returned_minor, h.currency) end, 'returned_on', d.returned_on,
    'deductions', d.deductions, 'kept_minor', case when d.returned_minor is null then null else d.amount_minor - d.returned_minor end,
    'updated_at', d.updated_at)
    from home.households h where h.id = d.household_id
$$;

-- GET /v1/households/{id}/deposits: the owner member sees every deposit, a flatmate their own
create or replace function api.deposits_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; v_role text;
begin
  perform api._as(p_user);
  e := api._need(v_id); if e is not null then return e; end if;
  v_role := api._my_role(v_id);
  return api._ok(jsonb_build_object('items', coalesce((select jsonb_agg(api._deposit_json(d) order by d.updated_at)
    from home.deposits d where d.household_id = v_id and (v_role = 'owner' or d.user_id = p_user)), '[]')));
end $$;

-- PUT /v1/households/{id}/deposits/{user_id}: recorded by the owner member (or by the flatmates when the household has
-- no owner member). The amounts kept must add up: returned + deductions = amount once the return is recorded.
create or replace function api.deposit_put(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; v_u uuid := (p#>>'{params,user_id}')::uuid; b jsonb := coalesce(p->'body', '{}'); e jsonb;
  v_ded bigint; d home.deposits;
begin
  perform api._as(p_user);
  e := api._need(v_id); if e is not null then return e; end if;
  if api._my_role(v_id) <> 'owner' and exists (select 1 from home.household_members where household_id = v_id and role = 'owner' and status <> 'left') then
    return api._err(403, 'FORBIDDEN', 'Deposits are recorded by the owner member');
  end if;
  if not exists (select 1 from home.household_members where household_id = v_id and user_id = v_u and role = 'flatmate') then
    return api._err(404, 'NOT_FOUND', 'Flatmate not found');
  end if;
  select coalesce(sum((x->>'amount_minor')::bigint), 0) into v_ded from jsonb_array_elements(coalesce(b->'deductions', '[]')) x;
  if b->>'returned_minor' is not null and (b->>'returned_minor')::bigint + v_ded <> (b->>'amount_minor')::bigint then
    return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', jsonb_build_array(jsonb_build_object('field', 'deductions',
      'issue', 'sum_mismatch', 'expected_minor', (b->>'amount_minor')::bigint - (b->>'returned_minor')::bigint, 'given_minor', v_ded)));
  end if;
  insert into home.deposits (household_id, user_id, amount_minor, paid_on, held_by, returned_minor, returned_on, deductions, updated_by, updated_at)
  values (v_id, v_u, (b->>'amount_minor')::bigint, (b->>'paid_on')::date, coalesce(b->>'held_by', 'owner'), (b->>'returned_minor')::bigint,
          (b->>'returned_on')::date, coalesce(b->'deductions', '[]'), p_user, now())
  on conflict (household_id, user_id) do update set amount_minor = excluded.amount_minor, paid_on = excluded.paid_on, held_by = excluded.held_by,
    returned_minor = excluded.returned_minor, returned_on = excluded.returned_on, deductions = excluded.deductions, updated_by = p_user, updated_at = now()
  returning * into d;
  if d.returned_on is not null and v_u <> p_user then
    perform api.notify_emit(v_u, 'deposit_returned', jsonb_build_object('returned_minor', d.returned_minor), 'household', v_id::text);
  end if;
  return api._ok(api._deposit_json(d));
end $$;

-- 3. Moving out: GET / POST /v1/households/{id}/move-out, PATCH /v1/households/{id}/move-out/{item}
create or replace function api._moveout_json(m home.move_outs) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('planned_on', m.planned_on, 'created_at', m.created_at, 'items', jsonb_build_array(
      jsonb_build_object('key', 'notice_flatmates', 'kind', 'manual', 'done', coalesce((m.manual->>'notice_flatmates')::boolean, false)),
      jsonb_build_object('key', 'balance_settled', 'kind', 'computed', 'done', coalesce((api._balances(m.household_id)->>m.user_id::text)::bigint, 0) = 0,
                         'balance_minor', coalesce((api._balances(m.household_id)->>m.user_id::text)::bigint, 0)),
      jsonb_build_object('key', 'exit_inventory', 'kind', 'computed', 'done', exists (select 1 from home.documents d where d.household_id = m.household_id
                         and d.kind = 'inventory_exit' and d.status = 'ready' and d.created_at >= m.created_at - interval '30 days')),
      jsonb_build_object('key', 'deposit_returned', 'kind', 'computed', 'done', exists (select 1 from home.deposits d where d.household_id = m.household_id
                         and d.user_id = m.user_id and d.returned_on is not null) or not exists (select 1 from home.deposits d
                         where d.household_id = m.household_id and d.user_id = m.user_id)),
      jsonb_build_object('key', 'keys_returned', 'kind', 'manual', 'done', coalesce((m.manual->>'keys_returned')::boolean, false)),
      jsonb_build_object('key', 'bills_transferred', 'kind', 'manual', 'done', coalesce((m.manual->>'bills_transferred')::boolean, false))))
$$;
create or replace function api.moveout_get(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; m home.move_outs;
begin
  perform api._as(p_user);
  e := api._need(v_id, 'flatmate'); if e is not null then return e; end if;
  select * into m from home.move_outs where household_id = v_id and user_id = p_user;
  return api._ok(jsonb_build_object('move_out', case when m.household_id is null then null else api._moveout_json(m) end));
end $$;
create or replace function api.moveout_start(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; m home.move_outs;
begin
  perform api._as(p_user);
  e := api._need(v_id, 'flatmate'); if e is not null then return e; end if;
  insert into home.move_outs (household_id, user_id, planned_on) values (v_id, p_user, (p#>>'{body,planned_on}')::date)
  on conflict (household_id, user_id) do update set planned_on = excluded.planned_on returning * into m;
  update home.household_members set status = 'leaving', move_out_on = m.planned_on where household_id = v_id and user_id = p_user and status = 'active';
  perform api.notify_emit(x.user_id, 'flatmate_moving_out', jsonb_build_object('name', api._name(p_user)->>'display_name', 'on', m.planned_on),
                          'household', v_id::text)
     from home.household_members x where x.household_id = v_id and x.user_id <> p_user and x.status in ('active', 'leaving');
  return api._ok(jsonb_build_object('move_out', api._moveout_json(m)), 201);
end $$;
create or replace function api.moveout_item(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; v_item text := p#>>'{params,item}'; m home.move_outs; e jsonb;
begin
  perform api._as(p_user);
  e := api._need(v_id, 'flatmate'); if e is not null then return e; end if;
  if v_item not in ('notice_flatmates', 'keys_returned', 'bills_transferred') then
    return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', '[{"field": "item", "issue": "computed_or_unknown"}]');
  end if;
  update home.move_outs set manual = manual || jsonb_build_object(v_item, coalesce((p#>>'{body,done}')::boolean, true))
   where household_id = v_id and user_id = p_user returning * into m;
  if m.household_id is null then return api._err(404, 'NOT_FOUND', 'No move-out started'); end if;
  return api._ok(jsonb_build_object('move_out', api._moveout_json(m)));
end $$;

-- 4. Leaving: refused while the person's balance is not zero, unless they say they know (PLATFORM_SPEC 3.9)
create or replace function api.household_leave(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb; v_bal bigint;
begin
  perform api._as(p_user);
  e := api._need(v_id); if e is not null then return e; end if;
  v_bal := coalesce((api._balances(v_id)->>p_user::text)::bigint, 0);
  if v_bal <> 0 and not coalesce((p#>>'{body,acknowledge_balance}')::boolean, false) then
    return api._err(409, 'CONFLICT', 'The balance is not settled', jsonb_build_array(jsonb_build_object('field', 'balance',
      'issue', 'balance_not_settled', 'balance_minor', v_bal)));
  end if;
  update home.household_members set status = 'left', move_out_on = coalesce(move_out_on, current_date)
   where household_id = v_id and user_id = p_user;
  return api._ok(jsonb_build_object('household_id', v_id, 'status', 'left', 'balance_minor', v_bal));
end $$;

-- 5. Exit inventory against the entry inventory: GET /v1/documents/{id}/comparison
create or replace function api.document_comparison(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare x home.documents; n home.documents; rows jsonb;
begin
  perform api._as(p_user);
  select * into x from home.documents where id = (p#>>'{params,id}')::uuid;
  if x.id is null then return api._err(404, 'NOT_FOUND', 'Document not found'); end if;
  if x.kind <> 'inventory_exit' then
    return api._err(422, 'VALIDATION_FAILED', 'Request is invalid', '[{"field": "id", "issue": "not_an_exit_inventory"}]');
  end if;
  select * into n from home.documents where household_id = x.household_id and kind = 'inventory_entry' and status = 'ready' and created_at <= x.created_at
   order by created_at desc limit 1;
  with a as (select lower(btrim(r->>'room')) rk, lower(btrim(r->>'item')) ik, r from jsonb_array_elements(coalesce(n.inputs#>'{items,rows}', '[]')) r),
       b as (select lower(btrim(r->>'room')) rk, lower(btrim(r->>'item')) ik, r from jsonb_array_elements(coalesce(x.inputs#>'{items,rows}', '[]')) r)
  select coalesce(jsonb_agg(jsonb_build_object('room', coalesce(b.r->>'room', a.r->>'room'), 'item', coalesce(b.r->>'item', a.r->>'item'),
           'entry', a.r->>'condition', 'exit', b.r->>'condition', 'exit_notes', b.r->>'notes',
           'state', case when a.r is null then 'only_at_exit' when b.r is null then 'missing_at_exit'
                         when lower(btrim(a.r->>'condition')) = lower(btrim(b.r->>'condition')) then 'same' else 'changed' end)
           order by coalesce(b.rk, a.rk), coalesce(b.ik, a.ik)), '[]')
    into rows
    from a full join b on a.rk = b.rk and a.ik = b.ik;
  return api._ok(jsonb_build_object('exit_document_id', x.id, 'entry_document_id', n.id, 'rows', case when n.id is null then '[]'::jsonb else rows end,
    'changed', (select count(*) from jsonb_array_elements(rows) r where r->>'state' <> 'same')));
end $$;

do $$
declare f text;
  internal text[] := array['api._deposit_json(home.deposits)', 'api._moveout_json(home.move_outs)'];
  public_ text[] := array['api.deposits_list(uuid, jsonb)', 'api.deposit_put(uuid, jsonb)', 'api.moveout_get(uuid, jsonb)', 'api.moveout_start(uuid, jsonb)',
    'api.moveout_item(uuid, jsonb)', 'api.household_leave(uuid, jsonb)', 'api.document_comparison(uuid, jsonb)'];
begin
  foreach f in array internal || public_ loop
    execute format('alter function %s owner to app_rls', f);
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to app_rls', f);
  end loop;
  foreach f in array public_ loop execute format('grant execute on function %s to n8n_worker', f); end loop;
end $$;

-- 6. Deleting one's account (DELETE /v1/me, backend spec 13.6): app.erase_user plus the platform's data. The files go
--    through delete_media jobs (keys kept in the job), done by wf.ops.retention.
create or replace function app.platform_privacy_on_user_erased() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    insert into app.jobs (type, input, idempotency_key)
      select 'delete_media', jsonb_build_object('reason', 'erase_user_household_documents', 'storage_keys', jsonb_agg(d.storage_key order by d.storage_key)),
             'erase-hdocs-' || new.id
        from home.documents d where d.created_by = new.id and d.storage_key is not null
      having count(*) > 0
      on conflict (idempotency_key) do nothing;
    delete from home.documents where created_by = new.id;
    delete from home.document_drafts where user_id = new.id;
    delete from home.move_outs where user_id = new.id;
    update home.deposits set deductions = '[]' where user_id = new.id;
    delete from agent_memory.chat_histories where session_id like 'docs:' || new.id::text || ':%';
  end if;
  return new;
end $$;
create trigger trg_platform_privacy_erased after update of deleted_at on app.users
  for each row execute function app.platform_privacy_on_user_erased();
revoke execute on function app.platform_privacy_on_user_erased() from public;

-- DELETE /v1/me?confirm=DELETE: runs app.erase_user for the caller (the website then removes the sign-in)
create or replace function app.me_erase(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if coalesce(p#>>'{query,confirm}', p#>>'{body,confirm}', '') <> 'DELETE' then
    return jsonb_build_object('status', 422, 'error', jsonb_build_object('code', 'VALIDATION_FAILED', 'message', 'Request is invalid',
      'details', '[{"field": "confirm", "issue": "must_be_DELETE"}]'::jsonb));
  end if;
  if not exists (select 1 from app.users where id = p_user and deleted_at is null) then
    return jsonb_build_object('status', 404, 'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'User not found', 'details', '[]'::jsonb));
  end if;
  perform app.erase_user(p_user);
  return jsonb_build_object('status', 200, 'data', jsonb_build_object('erased', true,
    'files_queued', (select coalesce(sum(jsonb_array_length(input->'storage_keys')), 0) from app.jobs
                      where type = 'delete_media' and status = 'queued' and created_at > now() - interval '1 minute')));
end $$;
revoke execute on function app.me_erase(uuid, jsonb) from public;
grant execute on function app.me_erase(uuid, jsonb) to n8n_worker;

-- 7. Retention (backend spec 13.5): what is kept no longer than needed, with fixed dates for tests; and the file
--    deletion jobs (taken here, done by the Media service, marked here).
create or replace function app.retention_run(p_today date default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare d date := coalesce(p_today, current_date); s jsonb; n_dr int; n_no int; n_sh int; n_id int;
begin
  select jsonb_object_agg(key, (value #>> '{}')::int) into s from app.settings where key like 'retention.%';
  delete from home.document_drafts where created_at < d - make_interval(days => coalesce((s->>'retention.drafts_days')::int, 7));
  get diagnostics n_dr = row_count;
  delete from notify.notifications where read_at is not null and read_at < d - make_interval(days => coalesce((s->>'retention.notifications_days')::int, 180));
  get diagnostics n_no = row_count;
  delete from social.saved_search_hits where sent_at < d - make_interval(days => coalesce((s->>'retention.search_hits_days')::int, 180));
  get diagnostics n_sh = row_count;
  delete from app.idempotency_keys where created_at < d - make_interval(days => coalesce((s->>'retention.idempotency_days')::int, 2));
  get diagnostics n_id = row_count;
  return jsonb_build_object('drafts', n_dr, 'notifications', n_no, 'search_hits', n_sh, 'idempotency_keys', n_id, 'today', d);
end $$;
create or replace function app.media_deletions_take(p_limit int default 20) returns jsonb
language sql security definer set search_path = pg_catalog, pg_temp as $$
  with j as (
    update app.jobs set status = 'running', started_at = now(), attempts = attempts + 1, lease_until = now() + interval '10 minutes'
     where id in (select id from app.jobs where type = 'delete_media' and status = 'queued' order by created_at limit p_limit for update skip locked)
    returning id, input)
  select coalesce(jsonb_agg(jsonb_build_object('job_id', id, 'keys', coalesce(input->'storage_keys', '[]'))), '[]') from j
$$;
create or replace function app.media_deletions_done(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare x jsonb; n int := 0;
begin
  for x in select * from jsonb_array_elements(coalesce(p, '[]')) loop
    update app.jobs set status = case when (x->>'ok')::boolean then 'succeeded' when attempts >= 5 then 'failed' else 'queued' end,
           finished_at = case when (x->>'ok')::boolean or attempts >= 5 then now() end, lease_until = null,
           output = jsonb_build_object('deleted', x->'deleted'), input = case when (x->>'ok')::boolean then input - 'storage_keys' || '{"keys_deleted": true}' else input end
     where id = (x->>'job_id')::uuid;
    n := n + 1;
  end loop;
  return jsonb_build_object('jobs', n);
end $$;
revoke execute on function app.retention_run(date), app.media_deletions_take(int), app.media_deletions_done(jsonb) from public;
grant execute on function app.retention_run(date), app.media_deletions_take(int), app.media_deletions_done(jsonb) to n8n_worker;

-- migrate:down
drop function if exists app.media_deletions_done(jsonb), app.media_deletions_take(int), app.retention_run(date), app.me_erase(uuid, jsonb);
drop trigger if exists trg_platform_privacy_erased on app.users;
drop function if exists app.platform_privacy_on_user_erased();
create or replace function api.household_leave(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid := (p#>>'{params,id}')::uuid; e jsonb;
begin
  perform api._as(p_user);
  e := api._need(v_id); if e is not null then return e; end if;
  update home.household_members set status = 'left', move_out_on = coalesce(move_out_on, current_date)
   where household_id = v_id and user_id = p_user;
  return api._ok(jsonb_build_object('household_id', v_id, 'status', 'left'));
end $$;
drop function if exists api.document_comparison(uuid, jsonb), api.moveout_item(uuid, jsonb), api.moveout_start(uuid, jsonb), api.moveout_get(uuid, jsonb),
  api._moveout_json(home.move_outs), api.deposit_put(uuid, jsonb), api.deposits_list(uuid, jsonb), api._deposit_json(home.deposits);
drop table if exists home.move_outs, home.deposits;
delete from app.settings where key in ('retention.drafts_days', 'retention.notifications_days', 'retention.search_hits_days', 'retention.idempotency_days');
