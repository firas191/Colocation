#!/usr/bin/env python3
"""Asks the running Text service which backends it uses (run inside the container: python selfcheck.py).
Prints the language-ID backend and whether the NER model is active; exits 1 if GlotLID or NER is expected
(model files present in MODELS_DIR) but not in use."""
import json
import os
import sys
import urllib.request

req = urllib.request.Request("http://127.0.0.1:8000/v1/analyze", method="POST",
                             data=json.dumps({"text": "Bonjour, je suis Karim Ben Salah, chambre libre à Sousse."}).encode(),
                             headers={"Content-Type": "application/json", "X-Internal-Token": os.environ.get("INTERNAL_SERVICE_TOKEN", "")})
d = json.load(urllib.request.urlopen(req, timeout=120))
pii = d.get("pii") or {}
print(json.dumps({"langid_backend": d.get("backend"), "language": d["language"], "ner": pii.get("ner"),
                  "ner_error": pii.get("ner_error"), "counts": pii.get("counts"), "ms": d.get("ms")}, ensure_ascii=False))
want_glotlid = os.path.isfile(os.environ.get("GLOTLID_MODEL", "/nonexistent"))
want_ner = os.path.isdir(os.environ.get("NER_MODEL", "/nonexistent"))
problems = ([] if not want_glotlid or d.get("backend") == "glotlid-v3" else ["GlotLID model present but not used"]) + \
           ([] if not want_ner or pii.get("ner") else [f"NER model present but not active: {pii.get('ner_error')}"])
for p in problems:
    print(p)
sys.exit(1 if problems else 0)
