-- migrate:up
-- Telegram photos (D-086): several photos sent together with /annonce become one listing's photos, and search results
-- show the first photo with the others blurred and a button that sends all of them.

insert into app.settings (key, value, description) values
  ('telegram.album_wait_s', '3', 'Seconds the bot waits after an /annonce photo for the other photos of the same Telegram album'),
  ('telegram.search_photo_cards', '3', 'Search results (from the top) that get a photo card in Telegram'),
  ('services.telegram_relay_url', '"http://telegram:8099"', 'Telegram relay: sends a listing''s photos as one album (D-086)')
on conflict (key) do nothing;

-- 1. Photos of a Telegram album, one row per message. Telegram sends each photo of an album as its own message;
--    only the first carries the caption. Rows are kept one day.
create table app.telegram_album_items (
  bot             text not null,
  chat_id         bigint not null,
  media_group_id  text not null,
  message_id      bigint not null,
  file_id         text not null,
  has_command     boolean not null default false,
  listing_id      uuid references app.listings(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (bot, chat_id, media_group_id, message_id)
);
create index on app.telegram_album_items (created_at);
grant select, insert, update, delete on app.telegram_album_items to n8n_worker;

create or replace function app.telegram_album_add(p_bot text, p_chat bigint, p_group text, p_message bigint, p_file text,
                                                  p_command boolean) returns jsonb
language sql as $$
  with gone as (delete from app.telegram_album_items where created_at < now() - interval '1 day'),
  ins as (insert into app.telegram_album_items (bot, chat_id, media_group_id, message_id, file_id, has_command)
          values (p_bot, p_chat, p_group, p_message, p_file, p_command) on conflict do nothing returning 1)
  select jsonb_build_object('added', exists (select 1 from ins))
$$;

-- The /annonce message takes the photos of its album that no listing took yet, in message order, up to the limit of
-- photos per listing (media.max_files_per_listing).
create or replace function app.telegram_album_claim(p_bot text, p_chat bigint, p_group text, p_listing uuid) returns jsonb
language sql as $$
  with lim as (select coalesce((select (value #>> '{}')::int from app.settings where key = 'media.max_files_per_listing'), 20) as n),
  pick as (select message_id from app.telegram_album_items, lim
            where bot = p_bot and chat_id = p_chat and media_group_id = p_group and listing_id is null
            order by message_id limit (select n from lim)),
  upd as (update app.telegram_album_items a set listing_id = p_listing from pick
           where a.bot = p_bot and a.chat_id = p_chat and a.media_group_id = p_group and a.message_id = pick.message_id
          returning a.message_id, a.file_id)
  select coalesce(jsonb_agg(jsonb_build_object('message_id', message_id, 'file_id', file_id) order by message_id), '[]'::jsonb)
    from upd
$$;

-- For a photo of an album sent without the command: was it taken by a listing; did one come too late; should the bot
-- say how to post a listing (once per album, from its first photo, when no message of the album had the command)?
create or replace function app.telegram_album_status(p_bot text, p_chat bigint, p_group text, p_message bigint) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'taken', exists (select 1 from app.telegram_album_items where bot = p_bot and chat_id = p_chat and media_group_id = p_group
                       and message_id = p_message and listing_id is not null),
    'album_has_listing', exists (select 1 from app.telegram_album_items where bot = p_bot and chat_id = p_chat
                                   and media_group_id = p_group and listing_id is not null),
    'album_has_command', exists (select 1 from app.telegram_album_items where bot = p_bot and chat_id = p_chat
                                   and media_group_id = p_group and has_command),
    'first', p_message = (select min(message_id) from app.telegram_album_items where bot = p_bot and chat_id = p_chat
                            and media_group_id = p_group))
$$;

-- 2. Public photos of published listings: the processed copies (EXIF removed, faces and text blurred, D-070).
create or replace function app.listing_public_photos(p_listing uuid, p_limit int default 10) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('media_id', x.id, 'key', x.storage_key) order by x.created_at, x.id), '[]'::jsonb)
    from (select m.id, m.storage_key, m.created_at from app.listing_media m join app.listings l on l.id = m.listing_id
           where m.listing_id = p_listing and l.status = 'published' and m.kind = 'photo' and m.moderation in ('ok', 'blurred')
           order by m.created_at, m.id limit greatest(1, least(coalesce(p_limit, 10), 20))) x
$$;

-- Photo count and first keys of several listings (search results), in the order given.
create or replace function app.listing_photo_summary(p_ids uuid[], p_keys int default 4) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('listing_id', i.id, 'position', i.ord,
           'count', (select count(*) from app.listing_media m where m.listing_id = i.id and m.kind = 'photo'
                       and m.moderation in ('ok', 'blurred')),
           'keys', (app.listing_public_photos(i.id, p_keys))) order by i.ord), '[]'::jsonb)
    from unnest(p_ids) with ordinality i(id, ord)
    join app.listings l on l.id = i.id and l.status = 'published'
$$;

revoke execute on function app.telegram_album_add(text, bigint, text, bigint, text, boolean),
  app.telegram_album_claim(text, bigint, text, uuid), app.telegram_album_status(text, bigint, text, bigint),
  app.listing_public_photos(uuid, int), app.listing_photo_summary(uuid[], int) from public;
grant execute on function app.telegram_album_add(text, bigint, text, bigint, text, boolean),
  app.telegram_album_claim(text, bigint, text, uuid), app.telegram_album_status(text, bigint, text, bigint),
  app.listing_public_photos(uuid, int), app.listing_photo_summary(uuid[], int) to n8n_worker;

-- migrate:down
drop function if exists app.listing_photo_summary(uuid[], int);
drop function if exists app.listing_public_photos(uuid, int);
drop function if exists app.telegram_album_status(text, bigint, text, bigint);
drop function if exists app.telegram_album_claim(text, bigint, text, uuid);
drop function if exists app.telegram_album_add(text, bigint, text, bigint, text, boolean);
drop table if exists app.telegram_album_items;
delete from app.settings where key in ('telegram.album_wait_s', 'telegram.search_photo_cards', 'services.telegram_relay_url');
