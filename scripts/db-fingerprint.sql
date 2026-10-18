-- What a backup is checked against (scripts/db-backup.sh, db-restore.sh; D-111): one line per table with its row
-- count, and one line per object that decides who can see what: tables with owner, row-level security and grants,
-- columns with type, constraints, functions with owner, security definer and grants, policies with roles,
-- triggers and extensions. Read from the catalog, not from deparsed SQL, which PostgreSQL does not always print the
-- same way twice (array casts in CHECK constraints of the n8n database, T-77).
with rel as (
  select c.oid, n.nspname, c.relname, c.relkind, c.relowner, c.relrowsecurity, c.relforcerowsecurity, c.relacl
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and n.nspname not like 'pg_temp%'
    and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
)
select line from (
  select 'rows ' || format('%I.%I', nspname, relname) || ' '
         || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', nspname, relname), false, true, '')))[1]::text as line
  from rel where relkind in ('r', 'p')
  union all
  select format('rel %I.%I %s owner=%s rls=%s force=%s acl=%s', nspname, relname, relkind, pg_get_userbyid(relowner),
                relrowsecurity, relforcerowsecurity, coalesce(relacl::text, '-'))
  from rel
  union all
  select format('col %I.%I.%I %s notnull=%s acl=%s', r.nspname, r.relname, a.attname, format_type(a.atttypid, a.atttypmod),
                a.attnotnull, coalesce(a.attacl::text, '-'))
  from rel r join pg_attribute a on a.attrelid = r.oid where a.attnum > 0 and not a.attisdropped
  union all
  select format('con %I.%I %I %s', r.nspname, r.relname, k.conname, k.contype)
  from rel r join pg_constraint k on k.conrelid = r.oid
  union all
  select format('fn %I.%I(%s) owner=%s definer=%s acl=%s', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
                pg_get_userbyid(p.proowner), p.prosecdef, coalesce(p.proacl::text, '-'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_temp%'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  union all
  select format('pol %I.%I %I cmd=%s permissive=%s roles=%s', r.nspname, r.relname, po.polname, po.polcmd, po.polpermissive,
                (select string_agg(case when x = 0 then 'public' else pg_get_userbyid(x) end, ',' order by 1) from unnest(po.polroles) x))
  from rel r join pg_policy po on po.polrelid = r.oid
  union all
  select format('trg %I.%I %I enabled=%s', r.nspname, r.relname, t.tgname, t.tgenabled)
  from rel r join pg_trigger t on t.tgrelid = r.oid where not t.tgisinternal
  union all
  select format('ext %s %s', extname, extversion) from pg_extension
) s order by line;
