-- migrate:up
-- P7 photo analysis (spec 11.2 steps 5 and 6, 9.4 P7; docs/DECISIONS.md D-081).

-- 1. Settings ---------------------------------------------------------------------
insert into app.settings (key, value, description) values
  ('vision.enabled', 'true', 'Run the P7 photo analysis on listing photos (off on machines without a usable vision model)'),
  ('vision.max_side', '1024', 'Longest side in pixels of the copy of a photo sent to the vision model')
on conflict (key) do nothing;

-- 1b. Near-duplicate threshold (D-082): measured on the 50 labelled photos and 9 edits of each, distance 6 caught 49%
--     of the edited copies and 12 caught 70%, with no unrelated pair closer than 18. Only a default left unchanged moves.
update app.settings set value = '12'
 where key = 'media.phash_max_distance' and value::text = '6';

-- 2. Golden sets of photos ------------------------------------------------------------
alter table eval.datasets drop constraint if exists datasets_kind_check;
alter table eval.datasets add constraint datasets_kind_check
  check (kind in ('retrieval','asr','trust','extraction','legal_qa','matching','routing','vision'));

-- 3. Store the analysis of one photo (analysis.vision; the rest of analysis is the Media service report).
--    The model's answer is kept with the checked fields; nothing about people beyond a yes/no (spec 11.2 rules).
create or replace function app.store_photo_analysis(p_media uuid, p jsonb) returns jsonb
language plpgsql as $$
declare v_id uuid;
begin
  if jsonb_typeof(p) is distinct from 'object' or p->>'status' not in ('analyzed', 'failed') then
    raise exception 'store_photo_analysis: status must be analyzed or failed' using errcode = '22023';
  end if;
  update app.listing_media
     set analysis = analysis || jsonb_build_object('vision', p || jsonb_build_object('stored_at', now()))
   where id = p_media and kind = 'photo'
  returning id into v_id;
  if v_id is null then return jsonb_build_object('ok', false, 'error_code', 'NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'media_id', v_id);
end $$;

revoke execute on function app.store_photo_analysis(uuid, jsonb) from public;
grant execute on function app.store_photo_analysis(uuid, jsonb) to n8n_worker;

-- migrate:down
drop function if exists app.store_photo_analysis(uuid, jsonb);
delete from eval.runs where dataset_id in (select id from eval.datasets where kind = 'vision');   -- results, failures cascade
delete from eval.datasets where kind = 'vision';                                                  -- queries cascade
alter table eval.datasets drop constraint if exists datasets_kind_check;
alter table eval.datasets add constraint datasets_kind_check
  check (kind in ('retrieval','asr','trust','extraction','legal_qa','matching','routing'));
delete from app.settings where key in ('vision.enabled', 'vision.max_side');
update app.settings set value = '6' where key = 'media.phash_max_distance' and value::text = '12';
