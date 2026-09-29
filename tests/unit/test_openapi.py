"""docs/openapi.yaml is a valid OpenAPI 3.1 document."""
from pathlib import Path

import yaml
from openapi_spec_validator import validate

SPEC = Path(__file__).resolve().parents[2] / "docs" / "openapi.yaml"


def test_openapi_is_valid():
    validate(yaml.safe_load(SPEC.read_text(encoding="utf-8")))


def test_every_error_code_has_a_status():
    spec = yaml.safe_load(SPEC.read_text(encoding="utf-8"))
    codes = set(spec["components"]["schemas"]["ErrorCode"]["enum"])
    js = (SPEC.parents[1] / "n8n" / "src" / "lib" / "canonical.js").read_text(encoding="utf-8")
    for c in codes:
        assert f"{c}:" in js, f"{c} missing from ERROR_STATUS in canonical.js"
