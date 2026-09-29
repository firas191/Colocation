-- migrate:up
-- Fixes for defects found while reviewing the baseline schema. Each fix has a
-- regression test in db/tests/020_security_fixes.sql and an entry in docs/DECISIONS.md.

-- D-010: app.consents had table grants for api_user but no row level security,
-- so any end user could read and rewrite every other user's consent history.
-- Consent is an append-only log: insert and read own rows only.
alter table app.consents enable row level security;
create policy consents_owner_read on app.consents for select
  using (user_id = app.current_user_id());
create policy consents_owner_insert on app.consents for insert
  with check (user_id = app.current_user_id());
revoke update, delete on app.consents from api_user;

-- D-011: api_user could insert or update any column of its own listings,
-- including status = 'published', trust_score = 100, trust_verdict = 'ok',
-- is_synthetic and source. That bypasses the trust check and moderation.
-- Only owner-editable columns stay writable. Deleting goes through a workflow
-- (archive + media deletion jobs), so direct delete is revoked too.
revoke insert, update, delete on app.listings from api_user;
grant insert (owner_id, jurisdiction_code, kind, title, description, description_lang,
  rent_minor, currency, deposit_minor, bills_included, available_from, min_stay_months,
  bedrooms, bathrooms, total_area_m2, room_area_m2, furnished, current_flatmates,
  amenities, house_rules, country_code, admin_area, city, neighbourhood)
  on app.listings to api_user;
grant update (kind, title, description, description_lang,
  rent_minor, currency, deposit_minor, bills_included, available_from, min_stay_months,
  bedrooms, bathrooms, total_area_m2, room_area_m2, furnished, current_flatmates,
  amenities, house_rules, country_code, admin_area, city, neighbourhood)
  on app.listings to api_user;

-- D-012: api_user could insert messages with sender = 'assistant' or 'system'
-- into its own threads (spoofed assistant output), and edit or delete history.
drop policy messages_owner on app.messages;
create policy messages_owner_read on app.messages for select
  using (thread_id in (select id from app.threads where owner_id = app.current_user_id()));
create policy messages_owner_insert on app.messages for insert
  with check (thread_id in (select id from app.threads where owner_id = app.current_user_id())
              and sender = 'user' and sender_user_id = app.current_user_id());
revoke update, delete on app.messages from api_user;

-- D-013: least privilege on functions. PostgreSQL grants EXECUTE to PUBLIC on
-- every new function. The baseline granted all app/kb/ai functions to api_user.
-- api_user keeps only what its queries and RLS policies need.
revoke execute on all functions in schema app, kb, ai from public;
revoke execute on all functions in schema app, kb, ai from api_user;
grant execute on function app.current_user_id() to api_user, n8n_worker;
grant execute on function app.or_tsquery(text) to api_user, n8n_worker;
grant execute on function app.search_listings(vector, text, text, bigint, character, geography, integer, integer) to api_user, n8n_worker;
grant execute on function app.find_similar_media(bit, integer, uuid) to n8n_worker;
grant execute on function kb.search_chunks(text, text, vector, text, text, smallint, integer) to n8n_worker;
grant execute on function app.erase_user(uuid) to n8n_worker;
grant execute on function app.touch_updated_at() to n8n_worker;

-- New tables created by later migrations get service-role grants automatically.
alter default privileges in schema app, kb, ai, eval grant select, insert, update, delete on tables to n8n_worker;
alter default privileges in schema app, kb, ai, eval grant usage, select on sequences to n8n_worker;

-- D-014: erase_user deleted app.listing_media rows but queued delete_media jobs
-- that carried only the listing id, so the storage keys of the objects to delete
-- were lost. It also left generated documents (PDF keys and their inputs),
-- report texts, job inputs, execution links and stored idempotent responses.
create or replace function app.erase_user(p_user uuid) returns void
language plpgsql as $$
begin
  update app.messages set content = null, content_masked = null, sender_user_id = null
    where sender_user_id = p_user
       or thread_id in (select id from app.threads where owner_id = p_user);
  delete from app.profiles where user_id = p_user;

  -- Queue object deletion with the keys, before the rows that hold them are deleted.
  insert into app.jobs (type, input, idempotency_key)
    select 'delete_media',
           jsonb_build_object('listing_id', l.id,
             'storage_keys', coalesce((select jsonb_agg(m.storage_key order by m.storage_key)
                                       from app.listing_media m where m.listing_id = l.id), '[]'::jsonb)),
           'erase-media-' || l.id
    from app.listings l where l.owner_id = p_user
    on conflict (idempotency_key) do nothing;
  insert into app.jobs (type, input, idempotency_key)
    select 'delete_media',
           jsonb_build_object('reason', 'erase_user_documents',
             'storage_keys', jsonb_agg(d.storage_key order by d.storage_key)),
           'erase-docs-' || p_user
    from app.generated_documents d where d.user_id = p_user
    having count(*) > 0
    on conflict (idempotency_key) do nothing;

  delete from app.listing_media where listing_id in (select id from app.listings where owner_id = p_user);
  delete from app.generated_documents where user_id = p_user;
  update app.listings set status = 'archived', owner_id = null, location = null,
         public_location = null, description = null, title = null where owner_id = p_user;

  update app.reports set reporter_id = null, detail = null where reporter_id = p_user;
  update app.jobs set status = 'cancelled', finished_at = now()
    where requested_by = p_user and status = 'queued';
  update app.jobs set input = jsonb_build_object('erased', true), output = null
    where requested_by = p_user and status <> 'running';
  update app.jobs set requested_by = null where requested_by = p_user;
  update app.moderation_queue set assigned_to = null where assigned_to = p_user;
  update ai.executions set user_id = null where user_id = p_user;
  delete from app.idempotency_keys where user_id = p_user;

  update app.users set email = null, external_auth_id = null, display_name = null,
         telegram_chat_id = null, deleted_at = now() where id = p_user;
  insert into app.audit_log (actor_id, action, entity, entity_id)
    values (p_user, 'erase_user', 'user', p_user::text);
end $$;
revoke execute on function app.erase_user(uuid) from public, api_user;
grant execute on function app.erase_user(uuid) to n8n_worker;

-- migrate:down
-- Not reversible without reintroducing the defects. Restore from backup instead.
select 1;
