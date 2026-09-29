"""POST /v1/users/sync: create, update, idempotency, validation, conflicts."""
import concurrent.futures
import uuid

from conftest import assert_error, assert_ok


def ext():
    return "auth0|" + uuid.uuid4().hex


def test_create_then_update(client, idem, db):
    e = ext()
    email = f"{uuid.uuid4().hex[:8]}@example.com"
    r = client.call("POST", "/v1/users/sync", body={"external_auth_id": e, "email": email.upper(), "locale": "fr-TN",
                                                    "jurisdiction_code": "TN", "display_name": "Test User"}, idem=idem())
    j = assert_ok(r, 201, "UserSyncResponse")
    d = j["data"]
    assert d["created"] is True and d["role"] == "user" and d["locale"] == "fr-TN" and d["jurisdiction_code"] == "TN"
    assert d["consents"] == {} and d["consent_required"] == ["terms", "privacy"]
    uid = d["user_id"]
    with db.cursor() as cur:
        cur.execute("select email::text from app.users where id = %s", (uid,))
        assert cur.fetchone()[0] == email  # stored lower-case
        cur.execute("select count(*) from ai.executions where request_id = %s and status = 'succeeded'", (j["request_id"],))
        assert cur.fetchone()[0] == 1
        cur.execute("select action from app.audit_log where entity_id = %s", (uid,))
        assert [x[0] for x in cur.fetchall()] == ["user_created"]

    r2 = client.call("POST", "/v1/users/sync", body={"external_auth_id": e, "locale": "en-GB"}, idem=idem())
    d2 = assert_ok(r2, 200, "UserSyncResponse")["data"]
    assert d2["user_id"] == uid and d2["created"] is False and d2["locale"] == "en-GB"
    assert d2["jurisdiction_code"] == "TN"  # omitted field keeps its value


def test_consent_status_reported(client, idem, db):
    e = ext()
    uid = assert_ok(client.call("POST", "/v1/users/sync", body={"external_auth_id": e}, idem=idem()), 201, "UserSyncResponse")["data"]["user_id"]
    with db.cursor() as cur:
        cur.execute("insert into app.consents(user_id,purpose,granted,policy_version) values (%s,'terms',true,'terms-v1'),"
                    " (%s,'privacy',true,'privacy-v1')", (uid, uid))
    d = assert_ok(client.call("POST", "/v1/users/sync", body={"external_auth_id": e}, idem=idem()))["data"]
    assert d["consent_required"] == []
    assert d["consents"]["terms"]["granted"] is True and d["consents"]["terms"]["policy_version"] == "terms-v1"


def test_idempotent_replay_returns_stored_response(client, idem):
    k = idem()
    body = {"external_auth_id": ext()}
    first = client.call("POST", "/v1/users/sync", body=body, idem=k)
    j1 = assert_ok(first, 201, "UserSyncResponse")
    second = client.call("POST", "/v1/users/sync", body=body, idem=k)
    assert second.status_code == 201
    assert second.json() == j1  # byte-for-byte the stored body, including the first request_id


def test_same_key_different_body_conflicts(client, idem):
    k = idem()
    assert_ok(client.call("POST", "/v1/users/sync", body={"external_auth_id": ext()}, idem=k), 201, "UserSyncResponse")
    assert_error(client.call("POST", "/v1/users/sync", body={"external_auth_id": ext()}, idem=k), 409, "CONFLICT")


def test_concurrent_duplicates_create_one_user(client, idem, db):
    k = idem()
    e = ext()
    with concurrent.futures.ThreadPoolExecutor(4) as ex:
        rs = list(ex.map(lambda _: client.call("POST", "/v1/users/sync", body={"external_auth_id": e}, idem=k), range(4)))
    codes = sorted(r.status_code for r in rs)
    assert codes.count(201) >= 1 and set(codes) <= {201, 409}, codes
    with db.cursor() as cur:
        cur.execute("select count(*) from app.users where external_auth_id = %s", (e,))
        assert cur.fetchone()[0] == 1


def test_missing_idempotency_key(client):
    assert_error(client.call("POST", "/v1/users/sync", body={"external_auth_id": ext()}), 422, "VALIDATION_FAILED")


def test_bad_idempotency_key(client):
    assert_error(client.call("POST", "/v1/users/sync", body={"external_auth_id": ext()}, idem="short"), 422, "VALIDATION_FAILED")


def test_validation_errors_listed(client, idem):
    r = client.call("POST", "/v1/users/sync", body={"email": "not-an-email", "role": "admin", "locale": 5}, idem=idem())
    j = assert_error(r, 422, "VALIDATION_FAILED")
    issues = {(d["field"], d["issue"]) for d in j["error"]["details"]}
    assert ("role", "unknown_field") in issues          # cannot self-assign a role
    assert ("external_auth_id", "required") in issues
    assert ("email", "invalid_format") in issues
    assert ("locale", "must_be_string") in issues


def test_validation_failure_is_idempotent_too(client, idem):
    k = idem()
    body = {"external_auth_id": ""}
    r1 = client.call("POST", "/v1/users/sync", body=body, idem=k)
    r2 = client.call("POST", "/v1/users/sync", body=body, idem=k)
    assert r1.status_code == r2.status_code == 422 and r1.json() == r2.json()


def test_wrong_content_type(client, idem):
    url, h, b = client.build("POST", "/v1/users/sync", body={"external_auth_id": ext()}, idem=idem(),
                             headers={"Content-Type": "text/plain"})
    assert_error(client.send("POST", url, h, b), 422, "VALIDATION_FAILED")


def test_json_array_body(client, idem):
    url, h, b = client.build("POST", "/v1/users/sync", raw_body=b'[{"external_auth_id":"x"}]', idem=idem())
    assert_error(client.send("POST", url, h, b), 422, "VALIDATION_FAILED")


def test_email_taken_by_other_account(client, idem):
    email = f"{uuid.uuid4().hex[:8]}@example.com"
    assert_ok(client.call("POST", "/v1/users/sync", body={"external_auth_id": ext(), "email": email}, idem=idem()), 201, "UserSyncResponse")
    j = assert_error(client.call("POST", "/v1/users/sync", body={"external_auth_id": ext(), "email": email}, idem=idem()),
                     409, "CONFLICT")
    assert email not in str(j)  # the error never echoes the address


def test_unknown_jurisdiction(client, idem):
    j = assert_error(client.call("POST", "/v1/users/sync", body={"external_auth_id": ext(), "jurisdiction_code": "ZZ"},
                                 idem=idem()), 422, "VALIDATION_FAILED")
    assert j["error"]["details"] == [{"field": "jurisdiction_code", "issue": "unknown"}]


def test_sql_injection_strings_stored_literally(client, idem, db):
    evil = "Robert'); drop table app.users; --"
    d = assert_ok(client.call("POST", "/v1/users/sync", body={"external_auth_id": ext(), "display_name": evil}, idem=idem()), 201, "UserSyncResponse")["data"]
    with db.cursor() as cur:
        cur.execute("select display_name from app.users where id = %s", (d["user_id"],))
        assert cur.fetchone()[0] == evil
        cur.execute("select count(*) from app.users")
        assert cur.fetchone()[0] > 0


def test_unicode_and_rtl_display_name(client, idem, db):
    name = "فراس بن خليفة"
    d = assert_ok(client.call("POST", "/v1/users/sync", body={"external_auth_id": ext(), "display_name": name}, idem=idem()), 201, "UserSyncResponse")["data"]
    with db.cursor() as cur:
        cur.execute("select display_name from app.users where id = %s", (d["user_id"],))
        assert cur.fetchone()[0] == name


def test_unknown_and_malformed_user_header(client, idem):
    for uid in ("00000000-0000-0000-0000-0000000000ff", "not-a-uuid"):
        assert_error(client.call("POST", "/v1/users/sync", body={"external_auth_id": ext()}, idem=idem(), user_id=uid),
                     401, "UNAUTHENTICATED")


def test_erased_user_is_refused(client, idem, db):
    e = ext()
    uid = assert_ok(client.call("POST", "/v1/users/sync", body={"external_auth_id": e}, idem=idem()), 201, "UserSyncResponse")["data"]["user_id"]
    with db.cursor() as cur:
        cur.execute("select app.erase_user(%s)", (uid,))
    assert_error(client.call("POST", "/v1/users/sync", body={"external_auth_id": e}, idem=idem(), user_id=uid), 403, "FORBIDDEN")
    # the external id was removed by erasure, so signing in again creates a fresh account
    d = assert_ok(client.call("POST", "/v1/users/sync", body={"external_auth_id": e}, idem=idem()), 201, "UserSyncResponse")["data"]
    assert d["user_id"] != uid and d["created"] is True
