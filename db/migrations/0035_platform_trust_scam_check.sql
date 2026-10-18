-- migrate:up
-- Platform P12 (D-114): parts of Emna Safer's scam check (branch feat/scam-check, 2026-10-16) brought into the trust
-- check of P8 instead of a second, competing check: the contact reused by other owners, the rent written in the text
-- that does not match the stored rent, the single-call detector P8_scam_detector as a choice next to the Trust agent,
-- and the agent's or detector's note on the moderation page.

-- 1. Settings. The points are choices, not measurements: contact_reused takes Emna's weight (20 of her 100) on our
--    scale, price_mismatch sits between inconsistent_details (-15) and price_far_below (-25).
update app.settings set value = value || '{"contact_reused": -20, "price_mismatch": -20}'::jsonb where key = 'trust.points';
insert into app.settings (key, value, description) values
  ('trust.model', '"agent"', 'What reads the wording in the trust check, when trust.agent_enabled is on: agent (A4 Trust agent, '
     'P4_trust_assessor, tools) or detector (one P8_scam_detector call, D-114)')
on conflict (key) do nothing;

-- 2. A phone number or an e-mail address of the listing that also appears in another owner's listing, one that was
--    published or refused (drafts are left out: tests and abandoned attempts). Evidence: counts only, never the contact.
create or replace function app.trust_contact_reuse(p_listing uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  with l as (
    select id, owner_id, coalesce(title, '') || ' ' || coalesce(description, '') as t from app.listings where id = p_listing),
  c as (
    select distinct 'email' as k, lower(m[1]) as v
      from l, regexp_matches(l.t, '([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})', 'g') m
    union
    select distinct 'phone', right(regexp_replace(m[1], '\D', '', 'g'), 8)
      from l, regexp_matches(l.t, '(\+?[0-9][0-9 .-]{6,}[0-9])', 'g') m
     where length(regexp_replace(m[1], '\D', '', 'g')) >= 8),
  hits as (
    select c.k, o.id as other_id, o.owner_id
      from c cross join l join app.listings o on o.id <> l.id and o.owner_id is distinct from l.owner_id
     where (o.published_at is not null or o.status = 'rejected')
       and case when c.k = 'email'
                then position(c.v in lower(coalesce(o.title, '') || ' ' || coalesce(o.description, ''))) > 0
                else position(c.v in regexp_replace(coalesce(o.title, '') || ' ' || coalesce(o.description, ''), '\D', '', 'g')) > 0 end)
  select jsonb_build_object('contacts', (select count(*) from c), 'other_listings', count(distinct other_id),
                            'other_owners', count(distinct owner_id), 'kinds', coalesce(jsonb_agg(distinct k), '[]'))
    from hits
$$;

-- 3. trust_facts with the new database signal: the P8 function stays as app.trust_facts_base.
alter function app.trust_facts(uuid) rename to trust_facts_base;
create or replace function app.trust_facts(p_listing uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare f jsonb; r jsonb; pts jsonb;
begin
  f := app.trust_facts_base(p_listing);
  if f is null then return null; end if;
  r := app.trust_contact_reuse(p_listing);
  if (r->>'other_owners')::int > 0 then
    pts := coalesce((select value from app.settings where key = 'trust.points'), '{}');
    f := jsonb_set(f, '{signals}', (f->'signals') || jsonb_build_array(jsonb_build_object('signal', 'contact_reused',
      'points', pts->'contact_reused', 'source', 'database', 'evidence', r - 'contacts')));
  end if;
  return f || jsonb_build_object('contact_reuse', r);
end $$;

-- 4. The moderation item shows the note of the check (the agent's or the detector's summary, trust_reports.explanation).
create or replace function app._moderation_item(m app.moderation_queue) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('item_id', m.id, 'entity_type', m.entity_type, 'entity_id', m.entity_id, 'message_id', m.message_id,
    'reason', m.reason, 'priority', m.priority, 'status', m.status, 'decision', m.decision, 'reports', m.reports,
    'created_at', m.created_at, 'decided_at', m.decided_at,
    'evidence', m.evidence - 'report_ids',
    'note', (select t.explanation from app.trust_reports t
              where m.evidence ? 'trust_report_id' and t.id = app.try_uuid(m.evidence->>'trust_report_id')),
    'listing', case when m.entity_type = 'listing' then (select jsonb_build_object('listing_id', l.id, 'title', l.title, 'status', l.status,
        'description', l.description, 'rent_minor', l.rent_minor, 'currency', l.currency, 'city', l.city, 'trust_score', l.trust_score,
        'trust_verdict', l.trust_verdict, 'owner', jsonb_build_object('user_id', l.owner_id,
          'display_name', (select display_name from app.users where id = l.owner_id)))
       from app.listings l where l.id = m.entity_id) end,
    'message', case when m.message_id is not null then (select jsonb_build_object('id', x.id, 'body', x.body, 'hidden', x.hidden_by_moderation,
        'flags', x.flags, 'created_at', x.created_at) from social.messages x where x.id = m.message_id) end,
    'user', case when m.entity_type in ('user', 'message') then (select jsonb_build_object('user_id', u.id, 'display_name', u.display_name,
        'created_at', u.created_at) from app.users u where u.id = m.entity_id) end,
    'report_reasons', (select coalesce(jsonb_agg(jsonb_build_object('reason', r.reason, 'detail', r.detail, 'created_at', r.created_at)
        order by r.created_at), '[]') from app.reports r where r.queue_id = m.id),
    'actions', case when m.status not in ('open', 'in_review') then '[]'::jsonb
      when m.entity_type = 'listing' then '["approve", "reject", "dismiss"]'::jsonb
      when m.message_id is not null then '["hide_message", "dismiss"]'::jsonb
      else '["dismiss", "warn"]'::jsonb end)
$$;

revoke execute on function app.trust_contact_reuse(uuid), app.trust_facts(uuid), app.trust_facts_base(uuid) from public;
grant execute on function app.trust_contact_reuse(uuid), app.trust_facts(uuid), app.trust_facts_base(uuid) to n8n_worker;

-- migrate:down
drop function app.trust_facts(uuid);
alter function app.trust_facts_base(uuid) rename to trust_facts;
drop function if exists app.trust_contact_reuse(uuid);
create or replace function app._moderation_item(m app.moderation_queue) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('item_id', m.id, 'entity_type', m.entity_type, 'entity_id', m.entity_id, 'message_id', m.message_id,
    'reason', m.reason, 'priority', m.priority, 'status', m.status, 'decision', m.decision, 'reports', m.reports,
    'created_at', m.created_at, 'decided_at', m.decided_at,
    'evidence', m.evidence - 'report_ids',
    'listing', case when m.entity_type = 'listing' then (select jsonb_build_object('listing_id', l.id, 'title', l.title, 'status', l.status,
        'description', l.description, 'rent_minor', l.rent_minor, 'currency', l.currency, 'city', l.city, 'trust_score', l.trust_score,
        'trust_verdict', l.trust_verdict, 'owner', jsonb_build_object('user_id', l.owner_id,
          'display_name', (select display_name from app.users where id = l.owner_id)))
       from app.listings l where l.id = m.entity_id) end,
    'message', case when m.message_id is not null then (select jsonb_build_object('id', x.id, 'body', x.body, 'hidden', x.hidden_by_moderation,
        'flags', x.flags, 'created_at', x.created_at) from social.messages x where x.id = m.message_id) end,
    'user', case when m.entity_type in ('user', 'message') then (select jsonb_build_object('user_id', u.id, 'display_name', u.display_name,
        'created_at', u.created_at) from app.users u where u.id = m.entity_id) end,
    'report_reasons', (select coalesce(jsonb_agg(jsonb_build_object('reason', r.reason, 'detail', r.detail, 'created_at', r.created_at)
        order by r.created_at), '[]') from app.reports r where r.queue_id = m.id),
    'actions', case when m.status not in ('open', 'in_review') then '[]'::jsonb
      when m.entity_type = 'listing' then '["approve", "reject", "dismiss"]'::jsonb
      when m.message_id is not null then '["hide_message", "dismiss"]'::jsonb
      else '["dismiss", "warn"]'::jsonb end)
$$;
delete from app.settings where key = 'trust.model';
update app.settings set value = value - 'contact_reused' - 'price_mismatch' where key = 'trust.points';
