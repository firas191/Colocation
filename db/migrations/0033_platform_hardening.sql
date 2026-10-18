-- migrate:up
-- Platform P12 (D-111): hosts the knowledge-base fetcher may reach although they are inside the stack. Empty in
-- production: every source URL inside the stack or the local network is refused (n8n/src/lib/url_guard.js). The
-- contract tests add the fixtures server here for their run and remove it afterwards.
insert into app.settings (key, value, description) values
  ('kb.fetch_allow_hosts', '[]', 'host:port pairs the knowledge-base fetcher may reach inside the stack (tests only; empty in production)')
on conflict (key) do nothing;

-- migrate:down
delete from app.settings where key = 'kb.fetch_allow_hosts';
