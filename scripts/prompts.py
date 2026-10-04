#!/usr/bin/env python3
"""Prompt registry (spec 9.1): the files under prompts/ are the source, the database holds
what workflows run.

  check      validate the files (no database): front matter, sections, variables, schemas
  sync       write prompts and versions to ai.prompts / ai.prompt_versions and set the active
             version from prompts/<name>/prompt.json; a stored version whose template changed is
             refused (a change is a new version)
  activate   set the active version of one prompt (and record it in prompt.json)

Layout:
  prompts/<name>/prompt.json   name, agent, role, schema, variables, golden_set, active_version
  prompts/<name>/v<N>.md       front matter (version, techniques, params, changelog, optional
                               schema: a version-specific schema file), then
                               "## system" and "## user" sections with {{variable}} slots
  prompts/schemas/<name>.schema.json

Environment: FS_TEST_DB_DSN (the n8n_worker role), as for scripts/kb.py.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
PROMPTS = ROOT / "prompts"
VAR_RE = re.compile(r"\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}", re.I)
SECTIONS_RE = re.compile(r"^##\s*system\s*$.*?^##\s*user\s*$", re.M | re.S)


def load_prompt(d: Path) -> dict:
    meta = json.loads((d / "prompt.json").read_text(encoding="utf-8"))
    schema = json.loads((PROMPTS / meta["schema"]).read_text(encoding="utf-8"))
    versions = []
    for f in sorted(d.glob("v*.md"), key=lambda p: int(p.stem[1:])):
        text = f.read_text(encoding="utf-8")
        m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
        if not m:
            raise ValueError(f"{f}: missing front matter")
        fm = yaml.safe_load(m.group(1))
        body = m.group(2).strip() + "\n"
        vschema = schema
        if fm.get("schema"):                      # a version may change the output shape (P2 v3, D-066)
            vschema = json.loads((PROMPTS / fm["schema"]).read_text(encoding="utf-8"))
        versions.append({"file": str(f.relative_to(ROOT)).replace("\\", "/"), "version": fm["version"],
                         "output_schema": vschema, "schema_file": fm.get("schema") or meta["schema"],
                         "techniques": fm.get("techniques", []), "params": fm.get("params", {}),
                         "changelog": fm.get("changelog", ""), "model": fm.get("model"), "template": body,
                         "sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(), "stem": int(f.stem[1:])})
    return {**meta, "dir": d, "output_schema": schema, "versions": versions}


def all_prompts() -> list[dict]:
    return [load_prompt(d) for d in sorted(PROMPTS.iterdir()) if (d / "prompt.json").is_file()]


def check() -> list[str]:
    from jsonschema import Draft202012Validator
    errors = []
    for p in all_prompts():
        Draft202012Validator.check_schema(p["output_schema"])
        for v in p["versions"]:
            Draft202012Validator.check_schema(v["output_schema"])
        allowed = set(p["variables"])
        seen = set()
        for v in p["versions"]:
            where = v["file"]
            if v["version"] != v["stem"]:
                errors.append(f"{where}: front matter version {v['version']} does not match the file name")
            if v["version"] in seen:
                errors.append(f"{where}: duplicate version")
            seen.add(v["version"])
            if not SECTIONS_RE.search(v["template"]):
                errors.append(f"{where}: needs a '## system' section followed by a '## user' section")
            used = set(VAR_RE.findall(v["template"]))
            if used - allowed:
                errors.append(f"{where}: unknown variables {sorted(used - allowed)}")
            if "message" in allowed and "<message>\n{{message}}\n</message>" not in v["template"]:
                errors.append(f"{where}: the message must sit alone between <message> and </message>")
            if not v["changelog"]:
                errors.append(f"{where}: changelog is empty")
            if (v["params"] or {}).get("temperature", 0) != 0:
                errors.append(f"{where}: extraction and classification prompts run at temperature 0 (spec 9.1)")
        if p["active_version"] not in seen:
            errors.append(f"{p['name']}: active_version {p['active_version']} has no file")
    return errors


def sync(conn) -> list[str]:
    out = []
    for p in all_prompts():
        pid = conn.execute(
            """insert into ai.prompts (name, agent, role) values (%s, %s, %s)
               on conflict (name) do update set agent = excluded.agent, role = excluded.role returning id""",
            (p["name"], p["agent"], p["role"])).fetchone()[0]
        for v in p["versions"]:
            row = conn.execute("""select template_sha256, output_schema = %s::jsonb from ai.prompt_versions
                                  where prompt_id = %s and version = %s""",
                               (json.dumps(v["output_schema"]), pid, v["version"])).fetchone()
            if row:
                if not row[1]:
                    raise SystemExit(f"{v['file']}: version {v['version']} is stored with another output schema; "
                                     "a new output shape needs a new version with its own schema file")
                if row[0] != v["sha256"]:
                    raise SystemExit(f"{v['file']}: version {v['version']} is stored with another template; "
                                     "write a new version instead of editing a stored one")
                conn.execute("update ai.prompt_versions set changelog = %s, source_path = %s where prompt_id = %s and version = %s",
                             (v["changelog"], v["file"], pid, v["version"]))
                continue
            conn.execute(
                """insert into ai.prompt_versions (prompt_id, version, techniques, template, output_schema, model, params,
                                                    status, changelog, template_sha256, source_path)
                   values (%s, %s, %s, %s, %s, %s, %s, 'draft', %s, %s, %s)""",
                (pid, v["version"], v["techniques"], v["template"], json.dumps(v["output_schema"]), v["model"],
                 json.dumps(v["params"]), v["changelog"], v["sha256"], v["file"]))
            out.append(f"{p['name']} v{v['version']}: stored")
        cur = conn.execute("select version from ai.prompt_versions where prompt_id = %s and status = 'active'", (pid,)).fetchone()
        if not cur or cur[0] != p["active_version"]:
            conn.execute("update ai.prompt_versions set status = 'retired' where prompt_id = %s and status = 'active'", (pid,))
            conn.execute("update ai.prompt_versions set status = 'active' where prompt_id = %s and version = %s",
                         (pid, p["active_version"]))
            out.append(f"{p['name']}: active version {p['active_version']}" + (f" (was {cur[0]})" if cur else ""))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check")
    sub.add_parser("sync")
    a = sub.add_parser("activate"); a.add_argument("name"); a.add_argument("version", type=int)
    args = ap.parse_args()
    errs = check()
    if errs:
        print("\n".join(errs))
        sys.exit(1)
    if args.cmd == "check":
        print(f"{sum(len(p['versions']) for p in all_prompts())} prompt versions OK")
        return
    if args.cmd == "activate":
        f = PROMPTS / args.name / "prompt.json"
        meta = json.loads(f.read_text(encoding="utf-8"))
        if not (PROMPTS / args.name / f"v{args.version}.md").is_file():
            sys.exit(f"no file for {args.name} v{args.version}")
        meta["active_version"] = args.version
        f.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    import psycopg
    dsn = os.environ.get("FS_TEST_DB_DSN") or sys.exit("FS_TEST_DB_DSN is not set")
    with psycopg.connect(dsn, autocommit=False) as conn:
        lines = sync(conn)
        conn.commit()
    print("\n".join(lines) if lines else "prompt registry up to date")


if __name__ == "__main__":
    main()
