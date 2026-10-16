-- migrate:up
-- D-093: whether the user created or changed a listing within match.followup_minutes, whatever conversation came
-- after. On the PC, "le loyer est 350 DT" (the example the bot itself gives under a listing without a rent) was read
-- by P1 as a search; the router now sends such a message to the owner assistant when this is true.
create or replace function app.owner_recent(p_user uuid) returns boolean
language sql stable as $$
  select exists (select 1 from app.listings
                  where owner_id = p_user and status <> 'rejected'
                    and updated_at > now() - make_interval(mins => coalesce(
                          (select (value #>> '{}')::int from app.settings where key = 'match.followup_minutes'), 30)))
$$;
revoke execute on function app.owner_recent(uuid) from public;
grant execute on function app.owner_recent(uuid) to n8n_worker;

-- migrate:down
drop function if exists app.owner_recent(uuid);
