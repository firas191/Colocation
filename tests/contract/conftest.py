"""Contract tests for the /v1 API.

Environment:
  FS_API_BASE        base URL that /v1/... is appended to.
                     Through the proxy: http://localhost:8080
                     Directly to n8n:   http://127.0.0.1:5678/webhook
  FS_SECRETS_FILE    file with FLATSHARE_TESTS_KEY_ID / FLATSHARE_TESTS_SECRET (written by db-bootstrap.sh)
  FS_TEST_DB_DSN     libpq DSN for the n8n_worker role (used to arrange and inspect state)
  FS_VIA_PROXY       "1" when FS_API_BASE is the reverse proxy (enables proxy-only tests)
  FS_SANDBOX_MOCKS   "1" only in the cloud sandbox, where Ollama and storage are mocks
                     controlled by tests/mocks/deps_mock.py (enables dependency-outage tests)
"""
import os
import sys
import time
import uuid
from pathlib import Path

import httpx
import psycopg
import pytest
import yaml
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "client"))
from fsclient import Client  # noqa: E402


_SPEC = yaml.safe_load((Path(__file__).resolve().parents[2] / "docs" / "openapi.yaml").read_text(encoding="utf-8"))
_REGISTRY = Registry().with_resource("urn:openapi", Resource.from_contents(_SPEC, default_specification=DRAFT202012))


def validate(obj, schema_name):
    """Validate a response body against a schema of docs/openapi.yaml."""
    Draft202012Validator({"$ref": f"urn:openapi#/components/schemas/{schema_name}"}, registry=_REGISTRY).validate(obj)


def _secrets():
    path = os.environ.get("FS_SECRETS_FILE", "secrets/api-clients.env")
    vals = {}
    for line in Path(path).read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            vals[k.strip()] = v.strip()
    return vals


@pytest.fixture(scope="session")
def base():
    return os.environ.get("FS_API_BASE", "http://localhost:8080").rstrip("/")


@pytest.fixture(scope="session")
def client(base):
    s = _secrets()
    c = Client(base, s["FLATSHARE_TESTS_KEY_ID"], s["FLATSHARE_TESTS_SECRET"])
    # Production webhooks register a few seconds after n8n reports ready
    # (docs/FAILURES.md F-006): wait until the route answers with our envelope.
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            r = httpx.get(base + "/v1/health", timeout=5)
            if r.status_code == 401:
                break
        except httpx.HTTPError:
            pass
        time.sleep(1)
    return c


@pytest.fixture
def db():
    """A fresh connection per test (outage tests restart the database)."""
    dsn = os.environ.get("FS_TEST_DB_DSN")
    if not dsn:
        pytest.skip("FS_TEST_DB_DSN not set")
    with psycopg.connect(dsn, autocommit=True) as conn:
        yield conn


def pytest_collection_modifyitems(items):
    """Outage tests stop dependencies: run them after everything else."""
    items.sort(key=lambda it: 1 if any(w in it.name for w in ("down", "outage", "unreachable")) else 0)


@pytest.fixture
def idem():
    return lambda: "t-" + uuid.uuid4().hex


def assert_error(r, status, code):
    assert r.status_code == status, (r.status_code, r.text)
    j = r.json()
    assert set(j) == {"request_id", "error"}, j
    validate(j, "ErrorEnvelope")
    assert j["error"]["code"] == code, j
    assert isinstance(j["error"]["message"], str) and j["error"]["message"]
    assert isinstance(j["error"]["details"], list)
    uuid.UUID(j["request_id"])
    assert r.headers.get("x-request-id") == j["request_id"]
    return j


def assert_ok(r, status=200, schema=None):
    assert r.status_code == status, (r.status_code, r.text)
    j = r.json()
    if schema:
        validate(j, schema)
    assert set(j) == {"request_id", "data", "meta"}, j
    assert isinstance(j["meta"]["latency_ms"], int)
    assert r.headers.get("x-request-id") == j["request_id"]
    assert r.headers.get("cache-control") == "no-store"
    return j


sandbox_only = pytest.mark.skipif(os.environ.get("FS_SANDBOX_MOCKS") != "1", reason="needs sandbox dependency mocks")
proxy_only = pytest.mark.skipif(os.environ.get("FS_VIA_PROXY") != "1", reason="needs the reverse proxy")
direct_only = pytest.mark.skipif(os.environ.get("FS_VIA_PROXY") == "1", reason="checks raw n8n behaviour without the proxy")
