"""A5 Legal agent (D-087): POST /v1/assistant/message for a legal question, with the n8n AI Agent node, its own chat
memory and the search_law tool over the knowledge base, in the sandbox.

Sandbox only: the model is the Ollama mock (tests/mocks/deps_mock.py legal_answer). It cannot reason; it searches with
the user's text and answers with the first sentence of the first excerpt, citing [1] (and [2]). The knowledge base
here is a synthetic one in the test jurisdiction "QL" (a "law" with three articles and a "blog"), embedded with the
mock's embeddings. These tests check the wiring, the numbering, the checks and the abstentions, not the model.
"""
import hashlib
import os

import httpx
import pytest

from conftest import assert_ok, sandbox_only
from test_profile_search import make_user

pytestmark = sandbox_only

OLLAMA_MOCK = os.environ.get("FS_OLLAMA_MOCK_URL", "http://127.0.0.1:11434")
LAW = """# CODE DE TEST DU LOUAGE (synthétique)

Article 1

Le bail d'une chambre est conclu par écrit lorsque sa durée dépasse une année.

Article 2

Le dépôt de garantie est rendu au preneur dans un délai de 30 jours après la remise des clés, déduction faite des sommes dues.

Article 3

Le preneur qui veut quitter le logement donne un préavis d'un mois au bailleur.
"""
BLOG = "Sur ce blog de test, nous pensons que la caution est rendue en 60 jours, et parfois jamais."
# the mock P1 reads "caution" as a legal question; no "dt" or "tunis", so it gives no country hint and the user's QL stays
QUESTION = "Le dépôt de garantie (caution) est rendu au preneur dans quel délai ?"


def embed(texts):
    r = httpx.post(f"{OLLAMA_MOCK}/api/embed", json={"model": "bge-m3", "input": texts}, timeout=30)
    r.raise_for_status()
    return r.json()["embeddings"]


def add_source(conn, key, jur, title, stype, rel, text, articles):
    """One source, its current document, one fixed_500_50 chunk per paragraph block and structure-aware chunks
    (with an article reference) over the same spans."""
    sid = conn.execute("""insert into kb.sources (jurisdiction_code, title, url, publisher, source_type, reliability, language,
                                                  source_key, retrieved_at)
                          values (%s, %s, %s, 'tests', %s, %s, 'fr', %s, '2026-10-01T09:00:00Z') returning id""",
                       (jur, title, f"https://example.org/{key}", stype, rel, key)).fetchone()[0]
    did = conn.execute("""insert into kb.documents (source_id, content, content_hash, char_count)
                          values (%s, %s, %s, %s) returning id""",
                       (sid, text, hashlib.sha256(text.encode()).hexdigest(), len(text))).fetchone()[0]
    spans = []
    if articles:
        for i in (1, 2, 3):
            s = text.index(f"Article {i}")
            e = text.index(f"Article {i + 1}") if i < 3 else len(text)
            spans.append((s, e, f"TST-L art. {i}"))
    else:
        spans.append((0, len(text), None))
    vecs = embed([text[s:e] for s, e, _ in spans])
    for i, ((s, e, art), v) in enumerate(zip(spans, vecs)):
        for strategy, ref in (("fixed_500_50", None), ("structure_aware_v1", art)):
            cid = conn.execute("""insert into kb.chunks (document_id, strategy, chunk_index, content, article_ref, start_char, end_char)
                                  values (%s, %s, %s, %s, %s, %s, %s) returning id""",
                               (did, strategy, i, text[s:e], ref, s, e)).fetchone()[0]
            conn.execute("insert into kb.chunk_embeddings (chunk_id, model, embedding) values (%s, 'bge-m3', %s::vector)",
                         (cid, "[" + ",".join(map(str, v)) + "]"))
    return str(sid)


@pytest.fixture(scope="module")
def ql():
    import psycopg
    with psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True) as conn:
        conn.execute("""insert into app.jurisdictions (code, country_code, name, default_currency, default_locale, languages, timezone)
                        values ('QL', 'QL', 'Test jurisdiction, legal agent (tests only)', 'TND', 'fr-TN', '{fr}', 'Africa/Tunis')
                        on conflict (code) do nothing""")
        conn.execute("delete from kb.sources where jurisdiction_code = 'QL'")
        add_source(conn, "test-ql-law", "QL", "Code de test du louage", "primary_law", 5, LAW, True)
        add_source(conn, "test-ql-blog", "QL", "Blog de test", "blog", 1, BLOG, False)
        conn.execute("update app.settings set value = 'true' where key = 'legal.agent_enabled'")
    yield
    with psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True) as conn:
        conn.execute("delete from kb.sources where jurisdiction_code = 'QL'")
        conn.execute("update app.settings set value = 'true' where key = 'legal.agent_enabled'")


@pytest.fixture
def user(db, ql):
    return make_user(db, "user", jurisdiction="QL")


def ask(client, uid, text, status=200):
    r = client.call("POST", "/v1/assistant/message", user_id=uid, body={"text": text})
    if status != 200:
        assert r.status_code == status, (r.status_code, r.text)
        return r.json()
    return assert_ok(r, 200, "AssistantResponse")


def steps_of(db, request_id):
    return db.execute("""select s.agent, s.prompt_version_id is not null, s.input, s.output, s.tool_calls, s.error
                         from ai.agent_steps s join ai.executions e on e.id = s.execution_id
                         where e.request_id = %s order by s.step_index""", (request_id,)).fetchall()


def test_answer_cites_the_excerpts_it_used(client, db, user):
    j = ask(client, user, QUESTION)
    d = j["data"]
    assert d["intent"] == "legal_question" and d["status"] == "answered" and d["abstained"] is False, d
    assert d["answer"].startswith("Selon Code de test du louage, Article 2 Le dépôt de garantie est rendu") and "[1]" in d["answer"]
    assert [c["n"] for c in d["citations"]] == [1, 2] and d["conflict"] is False
    law = d["citations"][0]
    assert law["source_type"] == "primary_law" and law["article"] == "TST-L art. 2" and law["reliability"] == 5
    assert law["url"] == "https://example.org/test-ql-law" and law["retrieved_at"].startswith("2026-10-01") and law["chunk_id"]
    assert d["notice_version"] == "legal-notice-v1" and d["jurisdiction"] == "QL" and d["agent"]["tool_calls"] == ["search_law"]
    st = steps_of(db, j["request_id"])
    assert [s[0] for s in st] == ["A0_text", "A0_orchestrator", "A5_legal_agent"]
    agent = st[-1]
    assert agent[1] is True and agent[5] is None                                # P5 version recorded, no error
    assert agent[4] == [{"tool": "search_law", "input_chars": len(QUESTION), "found": 4}]
    assert agent[3]["citations"] == 2 and len(agent[3]["retrieved"]) == 4 and agent[3]["searches"] == 1
    assert "dépôt" not in str(agent[2:5])                                       # no text of the message or the excerpts
    rows = db.execute("select message from agent_memory.chat_histories where session_id = %s order by id",
                      (f"legal:user:{user}",)).fetchall()
    assert [r[0]["type"] for r in rows] == ["human", "ai", "tool", "ai"]
    assert not db.execute("select 1 from agent_memory.chat_histories where session_id = %s", (f"user:{user}",)).fetchone()


def test_not_found_is_an_abstention(client, user):
    d = ask(client, user, "[mock:notfound] " + QUESTION)["data"]
    assert d["status"] == "abstained" and d["abstained"] is True and d["abstain_reason"] == "not_found", d
    assert d["answer"] is None and d["citations"] == [] and d["missing_information"] == "Les extraits ne parlent pas de cette question."


def test_a_citation_of_nothing_retrieved_is_removed_and_the_answer_dropped(client, user):
    d = ask(client, user, "[mock:badcite] " + QUESTION)["data"]
    assert d["status"] == "abstained" and d["abstain_reason"] == "no_citation" and "legal_invalid_citation" in d["warnings"], d


def test_a_number_no_excerpt_gives_drops_the_answer(client, user):
    d = ask(client, user, "[mock:badnumber] " + QUESTION)["data"]
    assert d["status"] == "abstained" and d["abstain_reason"] == "unsupported_numbers" and d["answer"] is None, d


def test_an_answer_without_a_search_is_not_shown(client, user):
    d = ask(client, user, "[mock:notool] " + QUESTION)["data"]
    assert d["status"] == "abstained" and d["abstain_reason"] == "no_search", d


def test_disagreeing_sources_are_flagged(client, user):
    d = ask(client, user, "[mock:conflict] " + QUESTION)["data"]
    assert d["status"] == "answered" and d["conflict"] is True and not d["answer"].startswith("["), d
    assert len(d["citations"]) == 2 and "CONFLICT" not in d["answer"]


def test_numbers_continue_across_two_searches_and_a_follow_up(client, db, user):
    d1 = ask(client, user, "[mock:twice] " + QUESTION)["data"]
    assert d1["agent"]["tool_calls"] == ["search_law", "search_law"] and d1["status"] == "answered", d1
    nums = db.execute("""select jsonb_path_query_array(sources, '$[*].n') from ai.legal_sessions where session_id = %s""",
                      (f"legal:user:{user}",)).fetchone()[0]
    assert nums == sorted(set(nums)) and len(nums) == 4             # same excerpts found twice keep their numbers
    j = ask(client, user, "et si le bailleur refuse ?")             # the mock P1 reads it as smalltalk: a follow-up
    d2 = j["data"]
    assert d2["intent"] == "legal_question" and "followup" in d2["warnings"] and d2["status"] == "answered", d2
    assert steps_of(db, j["request_id"])[-1][2]["memory_messages"] >= 4


def test_agent_failure_is_a_503(client, user):
    j = ask(client, user, "[mock:agentdown] " + QUESTION, status=503)
    assert j["error"]["code"] == "UPSTREAM_UNAVAILABLE"


def test_switched_off_says_not_available(client, db, user):
    db.execute("update app.settings set value = 'false' where key = 'legal.agent_enabled'")
    try:
        d = ask(client, user, QUESTION)["data"]
    finally:
        db.execute("update app.settings set value = 'true' where key = 'legal.agent_enabled'")
    assert d["intent"] == "legal_question" and d["status"] == "not_available_yet", d


def test_withdrawing_consent_forgets_the_legal_conversation(client, db, user):
    ask(client, user, QUESTION)
    assert db.execute("select count(*) from ai.legal_sessions where user_id = %s", (user,)).fetchone()[0] == 1
    db.execute("insert into app.consents (user_id, purpose, granted, policy_version) values (%s, 'privacy', false, 'test')", (user,))
    assert db.execute("select count(*) from ai.legal_sessions where user_id = %s", (user,)).fetchone()[0] == 0
    assert db.execute("select count(*) from agent_memory.chat_histories where session_id = %s",
                      (f"legal:user:{user}",)).fetchone()[0] == 0


# --- Telegram: the answer with its numbered sources and the notice ---------------------------------------------------

@pytest.fixture
def global_source(db, ql):
    """A global source (no country): searched for every country, so a Telegram user (TN by default) finds it."""
    add_source(db, "test-global-law", None, "Code de test global", "primary_law", 5, LAW, True)
    yield
    db.execute("delete from kb.sources where source_key = 'test-global-law'")


def test_telegram_shows_the_sources_and_the_notice(global_source):
    from test_telegram import consented_chat, push, sent, text_msg, wait_reply
    chat = consented_chat()
    n = len(sent())
    push(text_msg(chat, QUESTION))
    p = wait_reply(chat, n, lambda p: "Sources" in p.get("text", ""), timeout=90)
    t = p["text"]
    assert t.startswith("Selon Code de test global, Article 2 Le dépôt de garantie est rendu") and "[1]." in t, t
    assert '[1] <a href="https://example.org/test-global-law">Code de test global</a> · TST-L art. 2 · texte de loi · consulté le 2026-10-01' in t, t
    assert "pas un avis juridique" in t and p["parse_mode"] == "HTML" and p.get("disable_web_page_preview") in (True, "true")


def test_telegram_says_when_it_has_no_source(ql):
    from test_telegram import consented_chat, push, sent, text_msg, wait_reply
    chat = consented_chat()                                   # TN: no TN or global source in the sandbox
    n = len(sent())
    push(text_msg(chat, "[mock:notfound] " + QUESTION))
    p = wait_reply(chat, n, lambda p: "pas trouvé" in p.get("text", ""), timeout=90)
    assert "(TN)" in p["text"] and "pas un avis juridique" in p["text"]
