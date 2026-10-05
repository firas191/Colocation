#!/usr/bin/env python3
"""Downloads the Text service models into MODELS_DIR (a Docker volume) and records what was downloaded.

  GlotLID v3   cis-lmu/glotlid, file model_v3.bin (Apache-2.0 plus notices), about 1.7 GB  -> glotlid/model_v3.bin
  NER          Davlan/xlm-roberta-base-ner-hrl (AFL-3.0; ar, fr, en among 10 languages), about 1.1 GB -> ner/

The exact revision (commit) of each download is written to MODELS_DIR/manifest.json and printed, so the report
can name it (docs/research/PHASE4_COMPONENTS.md lists the candidates and licences). Idempotent.
Run: docker compose run --rm text python fetch_models.py
"""
import json
import os
import sys
import time
from pathlib import Path

from huggingface_hub import HfApi, hf_hub_download, snapshot_download

DIR = Path(os.environ.get("MODELS_DIR", "/models"))
MODELS = {
    "glotlid": {"repo": os.environ.get("GLOTLID_REPO", "cis-lmu/glotlid"), "file": "model_v3.bin"},
    "ner": {"repo": os.environ.get("NER_REPO", "Davlan/xlm-roberta-base-ner-hrl"),
            "allow": ["config.json", "*.safetensors", "tokenizer*", "sentencepiece.bpe.model", "special_tokens_map.json"]},
}


def main():
    DIR.mkdir(parents=True, exist_ok=True)
    manifest_path = DIR / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    api = HfApi()
    wanted = sys.argv[1:] or list(MODELS)          # e.g. "python fetch_models.py ner" fetches only the NER model
    for name, m in MODELS.items():
        if name not in wanted:
            continue
        t0 = time.time()
        info = api.model_info(m["repo"])
        sha = info.sha
        if "file" in m:
            path = hf_hub_download(m["repo"], m["file"], revision=sha, local_dir=DIR / name)
        else:
            path = snapshot_download(m["repo"], revision=sha, local_dir=DIR / name, allow_patterns=m["allow"])
        size = sum(f.stat().st_size for f in Path(DIR / name).rglob("*") if f.is_file())
        manifest[name] = {"repo": m["repo"], "revision": sha, "license": getattr(info.card_data, "license", None) if info.card_data else None,
                          "path": str(path), "bytes": size, "downloaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                          "seconds": round(time.time() - t0)}
        print(json.dumps({name: manifest[name]}))
    manifest_path.write_text(json.dumps(manifest, indent=1))


if __name__ == "__main__":
    main()
