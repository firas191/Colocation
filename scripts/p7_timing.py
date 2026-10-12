#!/usr/bin/env python3
"""Timing of the model calls of a listing analysis on the owner's PC (D-091): why a 3-photo listing took 14 minutes.

On 2026-10-12 every P7 photo call of listing d3cae0fc hit the 120 s timeout (llm.timeout_ms) and P3 timed out twice
before passing in 32 s. This script makes the same calls one at a time, without the 120 s limit, and reports what
Ollama says each one cost: model load, prompt tokens and their evaluation time, output tokens and their time.

Calls, in order: P3 on a short listing text; P7 on the listing's first photo at 512, 768 and 1024 px (the vision copy
of the Media service; 1024 is vision.max_side); P3 again. Same request body as wf.llm.call (active prompt version,
JSON Schema as format, temperature 0, seed, num_ctx, thinking off).

    python scripts/p7_timing.py [--listing <id>] [--sizes 512,768,1024] [--timeout 900]

Environment: FS_TEST_DB_DSN, INTERNAL_SERVICE_TOKEN (tests container). Writes reports/eval/p7-timing-*.json.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kb  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = "Chambre meublée dans un S+2 à Ariana, 350 DT par mois, charges comprises, wifi, libre le 1er novembre."


def prompt(conn, name):
    row = conn.execute("""select v.version, v.template, v.output_schema, v.params, v.model from ai.prompt_versions v
                          join ai.prompts p on p.id = v.prompt_id where p.name = %s and v.status = 'active'""", (name,)).fetchone()
    if not row:
        sys.exit(f"{name} has no active version: run scripts/prompts.py sync")
    return {"version": row[0], "template": row[1], "schema": row[2], "params": row[3] or {}, "model": row[4]}


def body(p, cfg, vars_, images=None):
    m = re.match(r"^\s*##\s*system\s*\n(.*?)\n##\s*user\s*\n(.*)$", p["template"], re.S | re.I)
    fill = lambda t: re.sub(r"\{\{\s*([a-z_]+)\s*\}\}", lambda x: str(vars_.get(x.group(1), x.group(0))), t)
    model = p["model"] or cfg["llm.default_model"]
    b = {"model": model, "stream": False, "keep_alive": cfg.get("llm.keep_alive") or "10m",
         "options": {"temperature": p["params"].get("temperature", 0), "seed": p["params"].get("seed", int(cfg.get("llm.seed") or 42)),
                     "num_ctx": p["params"].get("num_ctx", int(cfg.get("llm.num_ctx") or 4096))},
         "messages": [{"role": "system", "content": fill(m.group(1).strip())}, {"role": "user", "content": fill(m.group(2).strip())}],
         "format": p["schema"]}
    if p["params"].get("num_predict"):
        b["options"]["num_predict"] = p["params"]["num_predict"]
    over = (cfg.get("llm.model_overrides") or {}).get(model) or {}
    if "think" in over:
        b["think"] = over["think"]
    if images:
        b["messages"][1]["images"] = images
    return b


def call(c, url, b, timeout):
    t0 = time.perf_counter()
    try:
        r = c.post(f"{url}/api/chat", json=b, timeout=timeout)
        d = r.json()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {str(e)[:200]}", "wall_s": round(time.perf_counter() - t0, 1)}
    s = lambda k: round((d.get(k) or 0) / 1e9, 1)
    content = (d.get("message") or {}).get("content") or ""
    try:
        json.loads(content)
        valid = True
    except ValueError:
        valid = False
    return {"ok": r.status_code == 200, "http": r.status_code, "wall_s": round(time.perf_counter() - t0, 1),
            "load_s": s("load_duration"), "prompt_tokens": d.get("prompt_eval_count"), "prompt_s": s("prompt_eval_duration"),
            "output_tokens": d.get("eval_count"), "output_s": s("eval_duration"), "total_s": s("total_duration"),
            "done_reason": d.get("done_reason"), "valid_json": valid, "error": d.get("error")}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--listing")
    ap.add_argument("--sizes", default="512,768,1024")
    ap.add_argument("--timeout", type=float, default=900)
    a = ap.parse_args()
    token = os.environ.get("INTERNAL_SERVICE_TOKEN", "")
    with psycopg.connect(kb.dsn()) as conn:
        cfg = {k: v for k, v in conn.execute("select key, value from app.settings where key like 'llm.%' or key in"
                                             " ('ollama.base_url', 'services.media_url', 'vision.max_side')").fetchall()}
        lid = a.listing or conn.execute("""select l.id::text from app.listings l where exists (select 1 from app.listing_media m
                                            where m.listing_id = l.id and m.kind = 'photo') order by l.created_at desc limit 1""").fetchone()[0]
        keys = [k for (k,) in conn.execute("""select storage_key from app.listing_media where listing_id = %s and kind = 'photo'
                                              and moderation <> 'rejected' order by created_at, id""", (lid,)).fetchall()]
        p3, p7 = prompt(conn, "P3_listing_extractor"), prompt(conn, "P7_photo_analyzer")
    if not keys:
        sys.exit(f"listing {lid} has no photo")
    ollama = str(cfg["ollama.base_url"]).rstrip("/")
    media = str(cfg["services.media_url"]).rstrip("/")
    print(f"listing {lid}: {len(keys)} photos; model {cfg['llm.default_model']}; P3 v{p3['version']}, P7 v{p7['version']}; "
          f"num_ctx {cfg.get('llm.num_ctx')}; timeout here {a.timeout:.0f} s (workflows: {cfg.get('llm.timeout_ms')} ms)", flush=True)
    p3_vars = {"message": SAMPLE, "jurisdiction": "TN", "today": datetime.now().date().isoformat(), "default_currency": "TND"}
    rows = []
    with httpx.Client() as c:
        def run(label, b, extra=None):
            r = {"call": label, **(extra or {}), **call(c, ollama, b, a.timeout)}
            rows.append(r)
            print(json.dumps(r, ensure_ascii=False), flush=True)

        run("P3 text (first call)", body(p3, cfg, p3_vars))
        for size in [int(x) for x in a.sizes.split(",")]:
            v = c.post(f"{media}/v1/images/vision", json={"key": keys[0], "max_side": size}, headers={"X-Internal-Token": token}, timeout=60)
            if v.status_code != 200:
                rows.append({"call": f"P7 {size}px", "ok": False, "error": f"media service {v.status_code}"})
                print(rows[-1], flush=True)
                continue
            img = v.json()
            run(f"P7 photo {size}px", body(p7, cfg, {}, [img["image_b64"]]),
                {"width": img["width"], "height": img["height"], "jpeg_bytes": img["bytes"]})
        run("P3 text (again)", body(p3, cfg, p3_vars))
    out = ROOT / "reports" / "eval" / f"p7-timing-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"listing": lid, "model": cfg["llm.default_model"], "calls": rows}, ensure_ascii=False, indent=1), "utf-8")
    print(f"wrote {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
