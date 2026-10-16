"""Response fixtures for the website (spec 17.1): every file in tests/fixtures/api/<operationId>/<status>.json is a real
response recorded by the contract tests (FS_RECORD_FIXTURES=1) and must still match docs/openapi.yaml."""
import json
from pathlib import Path

import pytest
import yaml
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parents[2]
SPEC = yaml.safe_load((ROOT / "docs" / "openapi.yaml").read_text(encoding="utf-8"))
REGISTRY = Registry().with_resource("urn:openapi", Resource.from_contents(SPEC, default_specification=DRAFT202012))
FIXTURES = sorted((ROOT / "tests" / "fixtures" / "api").glob("*/*.json"))
OPS = {op["operationId"]: op for item in SPEC["paths"].values() for op in item.values() if isinstance(op, dict) and "operationId" in op}


def response_schema(op, status):
    resp = op["responses"].get(str(status))
    assert resp is not None, f"status {status} is not documented"
    if "$ref" in resp:
        resp = SPEC["components"]["responses"][resp["$ref"].rsplit("/", 1)[1]]
    return resp["content"]["application/json"]["schema"]


def test_there_are_fixtures():
    assert len(FIXTURES) >= 20


@pytest.mark.parametrize("path", FIXTURES, ids=lambda p: f"{p.parent.name}/{p.name}")
def test_fixture_matches_the_contract(path):
    op = OPS.get(path.parent.name)
    assert op is not None, f"{path.parent.name} is not an operationId of docs/openapi.yaml"
    schema = response_schema(op, int(path.stem))
    body = json.loads(path.read_text(encoding="utf-8"))
    Draft202012Validator(_resolve(schema), registry=REGISTRY).validate(body)


def _resolve(schema):
    """Schemas in openapi.yaml use #/components/... refs; point them at the registry's urn."""
    text = json.dumps(schema).replace('"#/components/', '"urn:openapi#/components/')
    return json.loads(text)
