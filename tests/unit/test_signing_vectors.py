"""The Python reference client reproduces the shared signing vectors."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests" / "client"))
from fsclient import canonical_query, canonical_string, sign  # noqa: E402

V = json.loads((ROOT / "tests" / "vectors" / "signing.json").read_text(encoding="utf-8"))


def test_vectors():
    for v in V["vectors"]:
        q = canonical_query(v["query_params"])
        assert q == v["canonical_query"], v["name"]
        canon = canonical_string(v["timestamp"], v["method"], v["path"], q, v["request_id"], v["user_id"],
                                 v["idempotency_key"], v["client_ip"], v["body_utf8"].encode("utf-8"))
        assert canon == v["canonical_string"], v["name"]
        assert sign(V["secret"], canon) == v["signature"], v["name"]


def test_query_encoding_matches_encodeURIComponent():
    # characters encodeURIComponent keeps: A-Z a-z 0-9 - _ . ! ~ * ' ( )
    assert canonical_query({"k": "-_.!~*'()"}) == "k=-_.!~*'()"
    assert canonical_query({"k": " /?#[]@$&+,;="}) == "k=%20%2F%3F%23%5B%5D%40%24%26%2B%2C%3B%3D"
    assert canonical_query({"k": "é"}) == "k=%C3%A9"
