-- migrate:up
-- Automatic publication after the analysis, for testing and demonstrations (D-083). Off by default: the real path is
-- owner confirmation and the trust check (spec 2.4 journey B, phase 5), which do not exist yet. A listing published
-- this way is marked extraction.publication = {mode: auto, checked: false}.

insert into app.settings (key, value, description) values
  ('listing.auto_publish', 'false', 'Publish a listing as soon as its analysis has a rent and a place found on the map (testing only: skips owner confirmation and the trust check)')
on conflict (key) do nothing;

create or replace function app.listing_auto_publish(p_listing uuid) returns jsonb
language plpgsql as $$
declare
  l app.listings; v_on boolean; g jsonb; v_missing text[] := '{}'; v_pub jsonb; v_title text; v_first text;
begin
  v_on := coalesce((select value::text from app.settings where key = 'listing.auto_publish'), 'false') = 'true';
  select * into l from app.listings where id = p_listing for update;
  if l.id is null then return jsonb_build_object('published', false, 'reason', 'not_found'); end if;
  if not v_on then return jsonb_build_object('published', false, 'reason', 'auto_publish_off'); end if;
  if l.status <> 'draft' then return jsonb_build_object('published', l.status = 'published', 'reason', 'not_a_draft'); end if;

  if l.rent_minor is null or l.currency is null then v_missing := v_missing || 'rent'::text; end if;
  -- the place: the neighbourhood first, then the city, in the listing's jurisdiction (local gazetteer, D-058)
  if l.neighbourhood is not null then g := app.geocode(l.neighbourhood, l.jurisdiction_code); end if;
  if (g is null or g->>'status' <> 'found') and l.city is not null then g := app.geocode(l.city, l.jurisdiction_code); end if;
  if g is null or g->>'status' <> 'found' then v_missing := v_missing || 'place'::text; end if;

  if array_length(v_missing, 1) > 0 then
    v_pub := jsonb_build_object('mode', 'auto', 'published', false, 'missing', to_jsonb(v_missing), 'at', now());
    update app.listings set extraction = coalesce(extraction, '{}'::jsonb) || jsonb_build_object('publication', v_pub)
     where id = l.id;
    return jsonb_build_object('published', false, 'reason', 'missing', 'missing', to_jsonb(v_missing));
  end if;

  v_first := btrim(split_part(coalesce(l.description, ''), E'\n', 1));
  v_title := coalesce(l.title, case when char_length(v_first) <= 80 then v_first
                                    else regexp_replace(left(v_first, 80), '\s+\S*$', '') || '…' end);
  v_pub := jsonb_build_object('mode', 'auto', 'published', true, 'checked', false, 'at', now(),
                              'place', g#>'{place,name}', 'place_key', g#>'{place,place_key}');
  update app.listings
     set status = 'published', published_at = now(), title = v_title,
         location = public.st_setsrid(public.st_makepoint((g#>>'{place,lng}')::float, (g#>>'{place,lat}')::float), 4326)::geography,
         extraction = coalesce(extraction, '{}'::jsonb) || jsonb_build_object('publication', v_pub)
   where id = l.id;
  insert into app.audit_log (actor_id, action, entity, entity_id) values (l.owner_id, 'listing_auto_published', 'listing', l.id::text);
  return jsonb_build_object('published', true, 'place', g->'place',
    'embed_text', concat_ws(E'\n', v_title, l.description, nullif(concat_ws(', ', l.neighbourhood, l.city), '')),
    'embed', (select jsonb_object_agg(key, value #>> '{}') from app.settings where key in ('ollama.base_url', 'ollama.embed_model')));
end $$;

revoke execute on function app.listing_auto_publish(uuid) from public;
grant execute on function app.listing_auto_publish(uuid) to n8n_worker;

-- migrate:down
drop function if exists app.listing_auto_publish(uuid);
delete from app.settings where key = 'listing.auto_publish';
