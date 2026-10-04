-- migrate:up
-- F-048: granite4.2 thinks by default (Ollama library page, read 2026-10-03: "enable_thinking true (default)");
-- with num_predict 200 its thinking used the whole budget and every P1 answer came back empty.
-- Every candidate that can think is told not to; the setting is merged so local changes stay.
update app.settings
   set value = value || '{"qwen3.5:4b": {"think": false}, "granite4.2:3b": {"think": false}}'::jsonb,
       description = 'Per-model request fields; Qwen3.5 and Granite 4.2 think by default and must be told not to (D-053, F-048)'
 where key = 'llm.model_overrides';

-- migrate:down
update app.settings set value = value - 'granite4.2:3b' where key = 'llm.model_overrides';
