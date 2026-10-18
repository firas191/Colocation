"""Platform P11 (docs/PLATFORM_SPEC.md 3.11, 3.12, 9 P11; D-110): notification preferences, delivery by e-mail through
wf.notify.dispatch (Mailpit; the sandbox's mail sink answers the same calls), Telegram linking by code, and the admin
endpoints (settings allowlist, staff roles, prompts, evaluation runs, sources). The dispatcher runs every minute, so
the e-mail test waits up to two and a half minutes.
"""
import os
import time
import uuid

import httpx
import psycopg
import pytest

from conftest import assert_error, assert_ok
from test_profile_search import make_user

MAIL = os.environ.get("FS_MAIL_API", "http://mailpit:8025")


def idem():
    return "t-" + uuid.uuid4().hex


def c(client, method, path, uid, body=None, params=None):
    return client.call(method, path, user_id=uid, body=body, params=params, idem=idem() if method != "GET" else None)


@pytest.fixture(scope="module")
def p11(client):
    db = psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True)
    u = {k: make_user(db, "user", ("terms", "privacy"), jurisdiction="TN") for k in ("a", "b", "admin")}
    tag = uuid.uuid4().hex[:8]
    for k in u:
        db.execute("update app.users set email = %s, display_name = %s where id = %s", (f"p11-{k}-{tag}@example.test", k.title(), u[k]))
    db.execute("update app.users set role = 'admin' where id = %s", (u["admin"],))
    keep = db.execute("select value from app.settings where key = 'reports.per_hour'").fetchone()[0]
    yield {"db": db, "tag": tag, **u}
    db.execute("update app.settings set value = %s where key = 'reports.per_hour'", (psycopg.types.json.Jsonb(keep),))
    db.close()


def test_preferences_and_email_delivery(client, p11):
    a, db, tag = p11["a"], p11["db"], p11["tag"]
    prefs = assert_ok(c(client, "GET", "/v1/me/notification-preferences", a), 200, "NotificationPreferencesResponse")["data"]
    assert prefs["email"] is True and prefs["email_address"] is True and prefs["telegram_linked"] is False
    assert_ok(c(client, "PUT", "/v1/me/notification-preferences", a, {"email": True, "telegram": True, "muted": ["message_received"]}), 200)
    db.execute("select api.notify_emit(%s, 'listing_published', '{\"title\": \"Chambre P11\"}'::jsonb, 'listing', %s)", (a, str(uuid.uuid4())))
    db.execute("select api.notify_emit(%s, 'message_received', '{\"from\": \"X\"}'::jsonb)", (a,))
    addr = f"p11-a-{tag}@example.test"
    found = None
    deadline = time.time() + 150
    while time.time() < deadline and not found:
        lst = httpx.get(f"{MAIL}/api/v1/messages", timeout=10).json()
        mine = [m for m in lst.get("messages", []) if any(t.get("Address") == addr for t in m.get("To", []))]
        if mine:
            found = mine
            break
        time.sleep(5)
    assert found, "no e-mail within 150 s (wf.notify.dispatch runs every minute)"
    time.sleep(3)
    lst = httpx.get(f"{MAIL}/api/v1/messages", timeout=10).json()
    mine = [m for m in lst.get("messages", []) if any(t.get("Address") == addr for t in m.get("To", []))]
    assert len(mine) == 1, "the muted type was not sent"
    msg = httpx.get(f"{MAIL}/api/v1/message/{mine[0]['ID']}", timeout=10).json()
    assert "Chambre P11" in msg["Text"] and "/owner/listings/" in msg["Text"]
    recent = assert_ok(c(client, "GET", "/v1/me/notification-preferences", a), 200)["data"]["recent"]
    assert any(r["channel"] == "email" and r["status"] == "sent" for r in recent)


def test_telegram_link_code(client, p11):
    b, db = p11["b"], p11["db"]
    code = assert_ok(c(client, "POST", "/v1/me/telegram-link", b, {}), 201, "TelegramLinkResponse")["data"]
    assert len(code["code"]) == 8 and code["command"] == f"/lier {code['code']}"
    r = db.execute("select app.telegram_link_redeem(%s, 990011)", (code["code"],)).fetchone()[0]
    assert r["ok"] is True
    assert assert_ok(c(client, "GET", "/v1/me", b), 200)["data"]["flags"]["telegram_linked"] is True
    assert db.execute("select app.telegram_link_redeem(%s, 990011)", (code["code"],)).fetchone()[0]["error_code"] == "used"
    assert assert_ok(c(client, "DELETE", "/v1/me/telegram-link", b), 200)["data"]["telegram_linked"] is False


def test_admin_endpoints(client, p11):
    adm, a = p11["admin"], p11["a"]
    for path in ("/v1/admin/settings", "/v1/admin/users", "/v1/admin/prompts", "/v1/admin/eval/runs", "/v1/admin/kb/sources"):
        assert_error(c(client, "GET", path, a), 403, "FORBIDDEN")
    s = assert_ok(c(client, "GET", "/v1/admin/settings", adm), 200, "AdminSettingsResponse")["data"]["items"]
    assert any(x["key"] == "trust.enabled" and x["type"] == "bool" for x in s)
    assert_error(c(client, "PUT", "/v1/admin/settings/llm.default_model", adm, {"value": "x"}), 422, "VALIDATION_FAILED")
    assert_error(c(client, "PUT", "/v1/admin/settings/reports.per_hour", adm, {"value": "lots"}), 422, "VALIDATION_FAILED")
    d = assert_ok(c(client, "PUT", "/v1/admin/settings/reports.per_hour", adm, {"value": 12}), 200, "AdminSettingResponse")["data"]
    assert d["value"] == 12
    log = p11["db"].execute("""select detail->>'to' from app.audit_log where action = 'setting_changed' and actor_id = %s
                               order by id desc limit 1""", (adm,)).fetchone()
    assert log == ("12",)
    assert_ok(c(client, "PUT", f"/v1/admin/users/{a}/role", adm, {"role": "moderator"}), 200, "AdminUserRoleResponse")
    assert assert_ok(c(client, "GET", "/v1/me", a), 200)["data"]["flags"]["is_staff"] is True
    assert_error(c(client, "PUT", f"/v1/admin/users/{adm}/role", adm, {"role": "user"}), 409, "CONFLICT")
    assert_error(c(client, "PUT", f"/v1/admin/users/{adm}/role", a, {"role": "user"}), 403, "FORBIDDEN")
    found = assert_ok(c(client, "GET", "/v1/admin/users", adm, params={"q": f"p11-a-{p11['tag']}"}), 200)["data"]["items"]
    assert [x["user_id"] for x in found] == [a]
    pr = assert_ok(c(client, "GET", "/v1/admin/prompts", a), 200, "AdminPromptsResponse")["data"]["items"]   # a moderator now
    assert any(x["name"] == "P1_router" for x in pr)
    assert_ok(c(client, "GET", "/v1/admin/eval/runs", a), 200, "AdminEvalRunsResponse")
    assert_ok(c(client, "GET", "/v1/admin/kb/sources", a), 200, "AdminKbSourcesResponse")
