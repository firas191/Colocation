"""D-118: GET /v1/places, the cities of a country for the website's city filter (migration 0038)."""
import os
import uuid

import psycopg
import pytest

from conftest import assert_error, assert_ok
from test_profile_search import make_user


@pytest.fixture(scope="module")
def who():
    db = psycopg.connect(os.environ["FS_TEST_DB_DSN"], autocommit=True)
    u = make_user(db, "user", ("terms", "privacy"), jurisdiction="TN")
    yield u
    db.close()


def test_places_of_a_country(client, who):
    r = assert_ok(client.call("GET", "/v1/places", user_id=who, params={"jurisdiction": "TN", "kind": "city", "lang": "fr"}), 200, "PlacesResponse")["data"]
    assert r["jurisdiction"] == "TN"
    assert all(x["kind"] == "city" for x in r["items"])
    assert [x["name"] for x in r["items"]] == sorted((x["name"] for x in r["items"]), key=lambda n: n.encode())


def test_unknown_country_and_bad_kind(client, who):
    assert_error(client.call("GET", "/v1/places", user_id=who, params={"jurisdiction": "QQ"}), 422, "VALIDATION_FAILED")
    assert_error(client.call("GET", "/v1/places", user_id=who, params={"jurisdiction": "TN", "kind": "street"}), 422, "VALIDATION_FAILED")
