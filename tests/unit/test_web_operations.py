"""web/lib/server/operations.json is generated from docs/openapi.yaml and up to date."""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_operations_json_is_up_to_date():
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "web_operations.py"), "--check"], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
