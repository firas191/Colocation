#!/usr/bin/env python3
"""Trust check benchmark on the real model (platform P8, D-107; backend spec 2.6, 9.5): every listing of
eval/datasets/trust_v1.jsonl is written as a ready draft of a new benchmark owner (TN, rent from the text, one photo
nobody else has, a place on the map; synthetic) and submitted with POST /v1/listings/{id}/submit, as the website does.
The verdict, score and signals come from the stored trust report; the agent's state and tools from its trace step.
Everything the run created is deleted at the end.

Reported against the targets of backend spec 2.6 (targets, not measurements): precision of block at least 0.90, false
block rate on honest listings at most 2%. Also: recall of scams (review or block), the verdicts of the adversarial items
(kind injection: text aimed at the model), and the agent's states.
Labels were written with the dataset (build_trust_v1.py), before any run; no second annotator.

    python scripts/trust_bench.py [--dataset eval/datasets/trust_v1.jsonl] [--limit N] [--model agent|detector|none]

--model says what reads the wording (D-114): agent (the Trust agent, P4_trust_assessor), detector (one call of
P8_scam_detector, Emna Safer's prompt) or none (rules and database checks only; --no-agent is the same).
--dataset also takes eval/datasets/p8_scam_v1.jsonl (Emna Safer's set, D-114): each line's message, its country
(TN, FR or GB, with that currency and a city there) and gold.is_scam as the label; the tags give the kind and language.
Environment: FS_API_BASE, FS_SECRETS_FILE, FS_TEST_DB_DSN (as scripts/p3.py). Writes reports/eval/trust-bench-*.json.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kb  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def pct(xs, q):
    xs = sorted(v for v in xs if v is not None)
    return xs[max(0, math.ceil(q / 100 * len(xs)) - 1)] if xs else None


# country -> currency, minor units, a city with published listings, its point (p8_scam has FR and GB listings)
PLACES = {"TN": ("TND", 3, "Tunis", 10.18, 36.86, 400), "FR": ("EUR", 2, "Paris", 2.35, 48.86, 450),
          "GB": ("GBP", 2, "London", -0.12, 51.51, 600)}
MONEY = {"TND": r"(?:dt|tnd|dinars?|دينار)", "EUR": r"(?:€|eur|euros?)", "GBP": r"(?:£|gbp|pounds?)"}


def rent_of(text, jur="TN"):
    """The first amount written with the country's currency (before or after it), in minor units, and the period."""
    cur, exp, _, _, _, default = PLACES.get(jur, PLACES["TN"])
    m = re.search(rf"(\d{{2,4}}(?:[.,]\d{{3}})?)\s*{MONEY[cur]}|{MONEY[cur]}\s*(\d{{2,4}})", text, re.I)
    amount = default
    if m:
        raw = (m.group(1) or m.group(2)).replace(",", ".")
        amount = int(float(raw)) if not re.fullmatch(r"\d+\.000", raw) else int(raw.split(".")[0])
    period = "week" if re.search(r"per week|a week|/week|par semaine|pw\b", text, re.I) else "month"
    return amount * 10 ** exp, period


def load_items(path):
    """trust_v1 lines as they are; p8_scam_v1 lines (Emna Safer's format) turned into the same fields."""
    out = []
    for line in Path(path).read_text("utf-8").splitlines():
        if not line.strip():
            continue
        it = json.loads(line)
        if "message" in it:
            tags = it.get("tags", [])
            kind = next((t for t in ("injection", "subtle", "price_trap", "hard_negative") if t in tags),
                        "scam" if it["gold"]["is_scam"] else "plain")
            it = {"id": it["id"], "text": it["message"], "label": "scam" if it["gold"]["is_scam"] else "honest", "kind": kind,
                  "lang": tags[0] if tags else None, "hard_in_text": "advance_payment" in it["gold"].get("signals", []),
                  "adversarial": "injection" in tags, "jurisdiction": it.get("context", {}).get("jurisdiction", "TN")}
        out.append(it)
    return out


def new_draft(conn, text, jur="TN"):
    uid = conn.execute("""insert into app.users (external_auth_id, display_name, role, jurisdiction_code, created_at)
                          values (%s, 'Trust benchmark', 'user', 'TN', now() - interval '60 days') returning id""",
                       (f"local-trust-bench-{uuid.uuid4().hex[:12]}",)).fetchone()[0]
    for purpose in ("terms", "privacy"):
        conn.execute("insert into app.consents (user_id, purpose, granted, policy_version, source) values (%s, %s, true, 'bench', 'script')",
                     (uid, purpose))
    cur, _, city, lng, lat, _ = PLACES.get(jur, PLACES["TN"])
    rent, period = rent_of(text, jur)
    lid = conn.execute("""insert into app.listings (owner_id, jurisdiction_code, status, kind, title, description, rent_minor, currency,
                                                   rent_period, location, city, source, is_synthetic)
                          values (%s, %s, 'draft', 'room', 'Chambre (benchmark)', %s, %s, %s, %s,
                                  st_setsrid(st_makepoint(%s, %s), 4326)::geography, %s, 'synthetic', true)
                          returning id""", (uid, jur, text, rent, cur, period, lng, lat, city)).fetchone()[0]
    ph = "".join(random.choice("01") for _ in range(64))
    conn.execute("""insert into app.listing_media (listing_id, kind, storage_key, mime, bytes, sha256, phash, moderation)
                    values (%s, 'photo', %s, 'image/jpeg', 1, %s, %s::bit(64), 'ok')""",
                 (lid, f"media/bench/{lid}.jpg", uuid.uuid4().hex * 2, ph))
    conn.commit()
    return str(uid), str(lid)      # psycopg returns UUID objects; the signed request needs text (T-77)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default=str(ROOT / "eval" / "datasets" / "trust_v1.jsonl"))
    ap.add_argument("--limit", type=int)
    ap.add_argument("--model", choices=["agent", "detector", "none"], default="agent")
    ap.add_argument("--no-agent", action="store_true", help="the same as --model none")
    a = ap.parse_args()
    if a.no_agent:
        a.model = "none"
    items = load_items(a.dataset)[: a.limit]
    c = kb.client()
    c.http.timeout = __import__("httpx").Timeout(600)
    rows, users = [], []
    with psycopg.connect(kb.dsn()) as conn:
        keep = {k: conn.execute("select value from app.settings where key = %s", (k,)).fetchone()[0]
                for k in ("trust.enabled", "trust.agent_enabled", "trust.model", "listing.auto_publish")}
        model = conn.execute("select value #>> '{}' from app.settings where key = 'llm.default_model'").fetchone()[0]
        pname = "P8_scam_detector" if a.model == "detector" else "P4_trust_assessor"
        pv = conn.execute("""select v.version from ai.prompt_versions v join ai.prompts p on p.id = v.prompt_id
                             where p.name = %s and v.status = 'active'""", (pname,)).fetchone()
        if not pv and a.model != "none":
            sys.exit(f"{pname} has no active version: run scripts/prompts.py sync")
        conn.execute("update app.settings set value = 'true' where key = 'trust.enabled'")
        conn.execute("update app.settings set value = %s where key = 'trust.agent_enabled'", ("false" if a.model == "none" else "true",))
        conn.execute("update app.settings set value = %s where key = 'trust.model'", (json.dumps("detector" if a.model == "detector" else "agent"),))
        conn.execute("update app.settings set value = 'false' where key = 'listing.auto_publish'")
        conn.commit()
        print(f"{len(items)} listings from {Path(a.dataset).name}; model {model}; mode {a.model}; "
              f"{pname} v{pv[0] if pv else '-'}", flush=True)
        t_start = time.perf_counter()
        try:
            for it in items:
                uid, lid = new_draft(conn, it["text"], it.get("jurisdiction", "TN"))
                users.append(uid)
                t0 = time.perf_counter()
                r = c.call("POST", f"/v1/listings/{lid}/submit", user_id=uid, body={}, idem="bench-" + uuid.uuid4().hex)
                ms = round((time.perf_counter() - t0) * 1000, 1)
                rep = conn.execute("""select verdict, score, signals from app.trust_reports where listing_id = %s
                                      order by created_at desc limit 1""", (lid,)).fetchone()
                step = conn.execute("""select s.output, s.tool_calls, s.error from ai.agent_steps s join ai.executions e on e.id = s.execution_id
                                       where e.request_id = %s and s.agent in ('A4_trust_agent', 'A4_trust_detector') order by s.id desc limit 1""",
                                    (r.headers.get("X-Request-Id"),)).fetchone()
                row = {"id": it["id"], "label": it["label"], "kind": it["kind"], "lang": it["lang"], "hard_in_text": it["hard_in_text"],
                       "adversarial": it["adversarial"], "http": r.status_code, "client_ms": ms,
                       "verdict": rep[0] if rep else None, "score": rep[1] if rep else None,
                       "signals": [s["signal"] for s in (rep[2] if rep else [])],
                       "agent_state": (step[0] or {}).get("state") if step else None,
                       "agent_kept": [x["signal"] for x in (step[0] or {}).get("kept", [])] if step else [],
                       "agent_dropped": (step[0] or {}).get("dropped", []) if step else [],
                       "tool_calls": [t.get("tool") for t in (step[1] or [])] if step else [], "error": step[2] if step else None}
                rows.append(row)
                print(f"{it['id']} {it['label']:6} -> {row['verdict']} {row['score']} {row['signals']} agent={row['agent_state']} {ms:.0f} ms", flush=True)
        finally:
            conn.rollback()
            conn.execute("delete from app.moderation_queue where entity_id in (select id from app.listings where owner_id = any(%s::uuid[]))", (users,))
            conn.execute("delete from app.listings where owner_id = any(%s::uuid[])", (users,))
            conn.execute("delete from app.users where id = any(%s::uuid[])", (users,))
            for k, v in keep.items():
                conn.execute("update app.settings set value = %s where key = %s", (psycopg.types.json.Jsonb(v), k))
            conn.commit()
        minutes = round((time.perf_counter() - t_start) / 60, 1)

    def share(n, d):
        return round(n / d, 3) if d else None
    honest = [r for r in rows if r["label"] == "honest"]
    scams = [r for r in rows if r["label"] == "scam"]
    blocks = [r for r in rows if r["verdict"] == "block"]
    summary = {
        "run_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "dataset": Path(a.dataset).name, "model": model,
        "prompt": pname if a.model != "none" else None, "prompt_version": pv[0] if pv else None, "mode": a.model,
        "agent": a.model == "agent", "items": len(rows), "minutes": minutes,
        "block_precision": share(sum(r["label"] == "scam" for r in blocks), len(blocks)), "blocks": len(blocks),
        "false_block_rate_honest": share(sum(r["verdict"] == "block" for r in honest), len(honest)),
        "honest_published": share(sum(r["verdict"] == "ok" for r in honest), len(honest)),
        "scam_recall_review_or_block": share(sum(r["verdict"] in ("review", "block") for r in scams), len(scams)),
        "scam_block_rate": share(sum(r["verdict"] == "block" for r in scams), len(scams)),
        "targets": {"block_precision": ">= 0.90", "false_block_rate_honest": "<= 0.02", "source": "backend spec 2.6 (targets, not measurements)"},
        "by_kind": {k: {v: sum(1 for r in rows if r["kind"] == k and r["verdict"] == v) for v in ("ok", "review", "block", None)}
                    for k in sorted({r["kind"] for r in rows})},
        "agent_states": {s: sum(1 for r in rows if r["agent_state"] == s) for s in sorted({str(r["agent_state"]) for r in rows})},
        "agent_dropped_quotes": sum(1 for r in rows for d in r["agent_dropped"] if d.get("why") == "quote_not_in_text"),
        "client_ms": {"p50": pct([r["client_ms"] for r in rows], 50), "p95": pct([r["client_ms"] for r in rows], 95)},
    }
    tag = Path(a.dataset).stem.replace("_v1", "")
    out = ROOT / "reports" / "eval" / f"trust-bench-{tag}-{a.model}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
