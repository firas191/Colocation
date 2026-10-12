-- migrate:up
-- Telegram (D-090): after telegram.job_wait_s the bot says the analysis is slow and keeps waiting, then sends the
-- result; it stops waiting after telegram.job_wait_max_s. Before, it stopped at job_wait_s and never sent the result
-- (owner's PC, 2026-10-12: an /annonce with 3 photos still running after 300 s).
insert into app.settings (key, value, description) values
  ('telegram.job_wait_max_s', '1800', 'Longest wait for a listing analysis before the bot stops and gives the listing id; the result is sent whenever it comes before that')
on conflict (key) do nothing;

-- migrate:down
delete from app.settings where key = 'telegram.job_wait_max_s';
