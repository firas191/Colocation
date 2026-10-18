-- migrate:up
-- D-118: the country chosen in the website's header scopes the site; the search filter offers that country's cities.
-- GET /v1/places?jurisdiction=TN&kind=city&lang=fr lists the active places of the gazetteer (geo/places.csv, D-058),
-- with the name in the reader's language when the gazetteer has one. Reference data, the same for everyone.

-- the gazetteer is read by a function of the database owner (app_rls has no rights on app.places)
create or replace function app.places_for(p_jurisdiction text, p_kind text, p_lang text) returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('place_key', x.place_key, 'kind', x.kind, 'name', x.label, 'city', x.city)
                            order by x.label collate "C"), '[]')
    from (select p.place_key, p.kind, p.city,
                 coalesce((select n.name from app.place_names n where n.place_id = p.id and n.lang = p_lang order by n.name limit 1), p.name) as label
            from app.places p
           where p.active and p.jurisdiction_code = p_jurisdiction and p.kind = p_kind) x
$$;
revoke execute on function app.places_for(text, text, text) from public;
grant execute on function app.places_for(text, text, text) to app_rls;

create or replace function api.places_list(p_user uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare q jsonb := coalesce(p->'query', '{}'); v_j text := q->>'jurisdiction';
begin
  perform api._as(p_user);
  if v_j is null or not exists (select 1 from app.jurisdictions where code = v_j) then
    return api._err(422, 'VALIDATION_FAILED', 'Unknown country',
      jsonb_build_array(jsonb_build_object('field', 'jurisdiction', 'issue', 'unknown_jurisdiction')));
  end if;
  return api._ok(jsonb_build_object('jurisdiction', v_j,
    'items', app.places_for(v_j, coalesce(q->>'kind', 'city'), coalesce(q->>'lang', 'fr'))));
end $$;
alter function api.places_list(uuid, jsonb) owner to app_rls;
revoke execute on function api.places_list(uuid, jsonb) from public;
grant execute on function api.places_list(uuid, jsonb) to app_rls, n8n_worker;

-- migrate:down
drop function if exists api.places_list(uuid, jsonb);
drop function if exists app.places_for(text, text, text);
