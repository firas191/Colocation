-- Migration 0016: longest Match agent answer shown (D-085).
\ir helpers.psql
begin;
select plan(2);
select is(app.match_agent_context(gen_random_uuid())->>'answer_max_chars', '400', '400 characters by default');
update app.settings set value = '250' where key = 'match.agent_answer_max_chars';
select is(app.match_agent_context(gen_random_uuid())->>'answer_max_chars', '250', 'read from the setting');
select * from finish();
rollback;
