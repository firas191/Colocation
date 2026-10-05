"""scripts/secret-scan.sh, exact-match step (FAILURES F-019).

- configuration values that appear in the repository (bucket name, Ollama URL)
  must not be treated as secrets;
- a real secret value found in the export directory must still fail the scan;
- every variable in .env.example is classified, so a new variable cannot be
  left out of the scan by accident.
"""
import os
import re
import secrets
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "secret-scan.sh"
SECRET_NAME_RE = re.compile(r"^[A-Z0-9_]*(PASSWORD|SECRET|SECRET_KEY|SECRET_ACCESS_KEY|TOKEN|API_KEY|ENCRYPTION_KEY)$")
# Variables in .env.example that are configuration, not secrets.
NOT_SECRET = {
    "FLATSHARE_DB", "N8N_DB", "N8N_DB_USER", "N8N_IMPORT_TEST_WORKFLOWS", "S3_BUCKET",
    "S3_ACCESS_KEY_ID", "OLLAMA_BASE_URL", "EMBED_MODEL", "PROXY_BIND", "PROXY_PORT",
    "ADMIN_ALERT_CHAT_ID", "S3_PUBLIC_ENDPOINT",
}


def _run(tmp_path, env_lines, export_files=None):
    env_file = tmp_path / "test.env"
    env_file.write_bytes(("\r\n".join(env_lines)).encode())   # CRLF and no final newline, as Windows editors write it
    export = tmp_path / "export"
    export.mkdir()
    for name, text in (export_files or {}).items():
        (export / name).write_text(text)
    return subprocess.run(
        ["bash", str(SCRIPT), str(export), str(env_file)],
        capture_output=True, text=True, env={**os.environ, "FS_SCAN_EXACT_ONLY": "1"}, timeout=120,
    )


def test_script_regex_matches_this_test():
    assert SECRET_NAME_RE.pattern in SCRIPT.read_text()


def test_every_env_example_variable_is_classified():
    names = [l.split("=", 1)[0] for l in (ROOT / ".env.example").read_text().splitlines()
             if re.match(r"^[A-Z0-9_]+=", l)]
    unclassified = [n for n in names if not SECRET_NAME_RE.match(n) and n not in NOT_SECRET]
    assert unclassified == [], f"classify these in SECRET_NAME_RE or NOT_SECRET: {unclassified}"
    wrongly_secret = [n for n in NOT_SECRET if SECRET_NAME_RE.match(n)]
    assert wrongly_secret == []


def test_config_values_in_repo_are_not_secrets(tmp_path):
    r = _run(tmp_path, ["S3_BUCKET=flatshare-media", "OLLAMA_BASE_URL=http://ollama:11434",
                        f"POSTGRES_PASSWORD={secrets.token_hex(24)}"])
    assert r.returncode == 0, r.stdout + r.stderr
    assert "secret variables checked: POSTGRES_PASSWORD" in r.stdout
    assert "none found" in r.stdout


def test_secret_in_export_fails(tmp_path):
    value = "fss_" + secrets.token_hex(32)
    r = _run(tmp_path, ["S3_BUCKET=flatshare-media", f"FLATSHARE_TESTS_SECRET={value}"],
             {"wf.json": f'{{"x": "{value}"}}'})
    assert r.returncode == 1, r.stdout + r.stderr
    assert "wf.json" in r.stdout and "FAIL" in r.stdout


def test_last_line_without_newline_is_read(tmp_path):
    value = secrets.token_hex(20)
    r = _run(tmp_path, ["FLATSHARE_DB=flatshare", f"TELEGRAM_BOT_TOKEN={value}"], {"a.txt": value})
    assert r.returncode == 1, r.stdout + r.stderr
