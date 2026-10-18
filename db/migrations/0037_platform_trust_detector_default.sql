-- migrate:up
-- D-117: the detector (one P8_scam_detector call) becomes what reads a listing's wording, after the PC comparison of
-- 2026-10-18 (T-84): on both sets it found more scams than the Trust agent with no false block, and answered every
-- listing in a fraction of the time. Only a database still on the old default changes; a value set by hand stays.
update app.settings set value = '"detector"' where key = 'trust.model' and value = '"agent"'::jsonb;

-- migrate:down
update app.settings set value = '"agent"' where key = 'trust.model' and value = '"detector"'::jsonb;
