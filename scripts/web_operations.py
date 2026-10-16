#!/usr/bin/env python3
"""Write web/lib/server/operations.json from docs/openapi.yaml: method, path regex, operationId and success status of
every operation. The website's fixture mode uses it to pick a recorded response (spec 17.1).
    python3 scripts/web_operations.py           # write
    python3 scripts/web_operations.py --check   # exit 1 if out of date (tests/unit/test_web_operations.py)
"""
import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web" / "lib" / "server" / "operations.json"


def build():
    spec = yaml.safe_load((ROOT / "docs" / "openapi.yaml").read_text(encoding="utf-8"))
    ops = []
    for p, item in spec["paths"].items():
        for m, op in item.items():
            if not isinstance(op, dict) or "operationId" not in op:
                continue
            success = min(int(c) for c in op["responses"] if c.startswith("2"))
            ops.append({"method": m.upper(), "regex": "^" + re.sub(r"\{[^}]+\}", "[^/]+", p) + "$",
                        "id": op["operationId"], "success": success})
    return json.dumps(ops, indent=1) + "\n"


if __name__ == "__main__":
    text = build()
    if "--check" in sys.argv:
        ok = OUT.exists() and OUT.read_text(encoding="utf-8") == text
        print("operations.json is up to date" if ok else "operations.json is out of date: run scripts/web_operations.py")
        sys.exit(0 if ok else 1)
    OUT.write_text(text, encoding="utf-8")
    print("wrote", OUT.relative_to(ROOT))
