"""Every route a workflow serves is documented in docs/openapi.yaml, and every documented route has a workflow
(PLATFORM_SPEC 2.3: new endpoints are documented; nothing undocumented reaches the website)."""
import json
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
SPEC = yaml.safe_load((ROOT / "docs" / "openapi.yaml").read_text(encoding="utf-8"))
INTERNAL = {("POST", "/telegram/update")}           # the relay's internal webhook, never mapped by the proxy


def served():
    out = set()
    for f in (ROOT / "n8n" / "workflows").glob("*.json"):
        wf = json.loads(f.read_text(encoding="utf-8"))
        for n in wf["nodes"]:
            if n["type"] == "n8n-nodes-base.webhook":
                path = "/" + re.sub(r":([A-Za-z_]+)", r"{\1}", n["parameters"]["path"])
                out.add((n["parameters"].get("httpMethod", "GET"), path))
    return out - INTERNAL


def documented():
    return {(m.upper(), re.sub(r"\{[^}]+\}", lambda x: x.group(0), p)) for p, item in SPEC["paths"].items()
            for m in item if m in ("get", "post", "put", "patch", "delete")}


def norm(routes):
    return {(m, re.sub(r"\{[^}]+\}", "{}", p)) for m, p in routes}


def test_every_served_route_is_documented():
    missing = norm(served()) - norm(documented())
    assert not missing, f"served but not in openapi.yaml: {sorted(missing)}"


def test_every_documented_route_is_served():
    missing = norm(documented()) - norm(served())
    assert not missing, f"in openapi.yaml but no workflow: {sorted(missing)}"
