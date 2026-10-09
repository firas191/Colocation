"""A3 Match agent (D-084): POST /v1/assistant/message with the n8n AI Agent node, its Postgres chat memory and two
workflow tools, in the sandbox.

Sandbox only: the model is the Ollama mock (tests/mocks/deps_mock.py agent_answer). It cannot reason; it calls the
search tool with the user's text (plus the previous message for "moins cher"), the details tool for "numéro N", and
answers from the tool result. These tests check the wiring, the memory, the checks and the fallback, not the model.
Listings and places are those of test_profile_search (jurisdiction QX, "Testville centre").
"""
import json

import pytest

from conftest import assert_ok, sandbox_only
from test_profile_search import L_CHEAP, make_user, qx  # noqa: F401  (module fixture reused)

pytestmark = sandbox_only

# "[mock:nocurrency]": the mock P2 reads a budget of 450 in the account's currency; no "dt" in the text, so the mock
# P1 gives no TN hint and the search stays in QX
SEARCH = "[mock:nocurrency] je cherche une chambre près de Testville centre"


def say(client, uid, text):
    j = assert_ok(client.call("POST", "/v1/assistant/message", user_id=uid, body={"text": text}), 200, "AssistantResponse")
    return j


def steps_of(db, request_id):
    return db.execute("""select s.agent, s.prompt_version_id is not null, s.input, s.output, s.tool_calls, s.error
                         from ai.agent_steps s join ai.executions e on e.id = s.execution_id
                         where e.request_id = %s order by s.step_index""", (request_id,)).fetchall()


@pytest.fixture
def user(db, qx):  # noqa: F811
    return make_user(db, "user")


@pytest.fixture
def agent_setting(db):
    yield
    db.execute("update app.settings set value = 'true' where key = 'match.agent_enabled'")


def test_agent_answers_a_search_from_the_tool_result(client, db, user):
    j = say(client, user, SEARCH)
    d = j["data"]
    assert d["intent"] == "search_listings" and d["status"] == "results", d
    assert [x["id"] for x in d["results"]] == [L_CHEAP] and d["count"] == 1
    assert d["answer"] == "J'ai trouvé 1 annonces. La 1 est à 400 TND."      # the mock's sentence, numbers from the tool
    assert d["agent"]["tool_calls"] == ["search_listings"] and d["agent"]["memory_messages"] == 0
    assert d["profile"]["budget_max_minor"] == 450000 and d["anchor"]["status"] == "found"
    st = steps_of(db, j["request_id"])
    assert [s[0] for s in st] == ["A0_text", "A0_orchestrator", "A2_profile", "A2_profile", "A3_match", "A3_match_agent"]
    agent = st[-1]
    assert agent[1] is True and agent[5] is None                              # P6_match_agent version recorded
    assert agent[4] == [{"tool": "search_listings", "input_chars": len(SEARCH), "found": 1}]
    assert "Testville" not in json.dumps(agent[2:5])                         # no message text in the agent's trace step
    rows = db.execute("select message from agent_memory.chat_histories where session_id = %s order by id",
                      (f"user:{user}",)).fetchall()
    # n8n's agent stores the whole turn: message, tool call, tool result (fields only), answer
    assert [r[0]["type"] for r in rows] == ["human", "ai", "tool", "ai"]
    assert SEARCH in rows[0][0]["content"] and rows[3][0]["content"] == d["answer"]
    assert rows[1][0]["tool_calls"][0]["name"] == "search_listings" and "Chambre simple" not in rows[2][0]["content"]


def test_memory_masks_phone_numbers(client, db, user):
    say(client, user, SEARCH + ", appelez-moi au 22 345 678")
    rows = db.execute("select message::text from agent_memory.chat_histories where session_id = %s", (f"user:{user}",)).fetchall()
    assert rows and not any("22 345 678" in r[0] for r in rows)


def test_follow_up_uses_the_conversation(client, db, user):
    say(client, user, SEARCH)
    j = say(client, user, "moins cher")                  # P1 (mock) reads it as smalltalk; a search is open -> the agent
    d = j["data"]
    assert d["status"] == "results" and "followup" in d["warnings"], d
    # the agent wrote the request again from the conversation: the place comes from the first message
    assert d["profile"]["anchor_label"] == "Testville centre" and d["anchor"]["status"] == "found"
    assert d["agent"]["memory_messages"] == 4 and d["agent"]["tool_calls"] == ["search_listings"]


def test_details_of_one_result(client, db, user):
    say(client, user, SEARCH)
    d = say(client, user, "et le numéro 1 ?")["data"]
    assert d["status"] == "answered" and d["results"] == [] and d["agent"]["tool_calls"] == ["listing_details"], d
    assert d["answer"] == "Listing 1: 400 TND, Testville."
    d = say(client, user, "et le numéro 7 ?")["data"]
    assert d["answer"] == "Je ne trouve pas ce numéro."


def test_answer_with_a_number_no_tool_gave_is_dropped(client, db, user):
    j = say(client, user, "[mock:badnumber] " + SEARCH)
    d = j["data"]
    assert d["status"] == "results" and d["answer"] is None and "agent_answer_unsupported" in d["warnings"], d
    assert [x["id"] for x in d["results"]] == [L_CHEAP]                     # the cards still come from the database
    out = steps_of(db, j["request_id"])[-1][3]
    assert out["dropped"] == {"reason": "unsupported_numbers", "numbers": [999]}


def test_agent_failure_falls_back_to_the_fixed_path(client, db, user):
    j = say(client, user, "[mock:agentdown] " + SEARCH)
    d = j["data"]
    assert d["status"] == "results" and "agent_fallback" in d["warnings"] and "answer" not in d, d
    assert [x["id"] for x in d["results"]] == [L_CHEAP]
    st = steps_of(db, j["request_id"])
    assert "A3_match_agent" in [s[0] for s in st] and [s for s in st if s[0] == "A3_match_agent"][0][5]


def test_agent_that_never_stops_falls_back(client, db, user):
    d = say(client, user, "[mock:loop] " + SEARCH)["data"]
    assert d["status"] == "results" and "agent_fallback" in d["warnings"], d


def test_agent_off_uses_the_fixed_path(client, db, user, agent_setting):
    say(client, user, SEARCH)
    db.execute("update app.settings set value = 'false' where key = 'match.agent_enabled'")
    j = say(client, user, SEARCH)
    assert "answer" not in j["data"] and "A3_match_agent" not in [s[0] for s in steps_of(db, j["request_id"])]
    assert say(client, user, "moins cher")["data"]["status"] == "unsupported"   # no follow-up without the agent


def test_withdrawing_consent_deletes_the_conversation(client, db, user):
    say(client, user, SEARCH)
    sid = f"user:{user}"
    assert db.execute("select count(*) from agent_memory.chat_histories where session_id = %s", (sid,)).fetchone()[0] == 4
    db.execute("insert into app.consents (user_id, purpose, granted, policy_version, source) values (%s, 'privacy', false, 'test', 'test')",
               (user,))
    assert db.execute("select count(*) from agent_memory.chat_histories where session_id = %s", (sid,)).fetchone()[0] == 0
    assert db.execute("select count(*) from ai.match_sessions where session_id = %s", (sid,)).fetchone()[0] == 0


def test_markdown_is_removed_and_a_long_answer_cut(client, db, user):
    """D-085: the model's Markdown list becomes plain text, cut at the last sentence under match.agent_answer_max_chars."""
    j = say(client, user, "[mock:markdown] " + SEARCH)
    d = j["data"]
    assert d["status"] == "results" and d["answer"] and "agent_answer_cut" in d["warnings"], d
    assert "*" not in d["answer"] and "\n" not in d["answer"] and len(d["answer"]) <= 400
    assert d["answer"].startswith("Voici les résultats de votre recherche : Résultat 1 : une chambre à Testville, 400 TND")
    assert d["answer"].endswith(".")                                          # cut at a sentence end
    out = steps_of(db, j["request_id"])[-1][3]
    assert out["markdown_removed"] is True and out["cut"] is True and out["raw_chars"] > 400
