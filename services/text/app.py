"""Text service (spec 5.1): language identification and PII masking. Compute only."""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).parent))
from fs_common import create_app  # noqa: E402
import langid  # noqa: E402
import pii  # noqa: E402

VERSION = "0.1.0"


def _warm():
    if os.environ.get("TEXT_WARM", "1") == "1":
        langid.default_backend()
        pii.ner()


app = create_app("text", VERSION, max_body_bytes=256 * 1024, on_startup=_warm)


class TextIn(BaseModel):
    text: str = Field(min_length=1, max_length=20000)
    model_config = {"extra": "forbid"}


class AnalyzeIn(TextIn):
    mask: bool = True
    use_ner: bool = True


@app.post("/v1/lang")
def lang(body: TextIn):
    t0 = time.perf_counter()
    r = langid.identify(body.text)
    return {**r, "backend": langid.default_backend().name, "ms": round((time.perf_counter() - t0) * 1000, 1)}


@app.post("/v1/pii/mask")
def mask(body: AnalyzeIn):
    t0 = time.perf_counter()
    r = pii.mask(body.text, use_ner=body.use_ner)
    return {**r, "ms": round((time.perf_counter() - t0) * 1000, 1)}


@app.post("/v1/analyze")
def analyze(body: AnalyzeIn):
    """Both in one call, for the orchestrator (spec 8.2 A0: language identification, then a masked copy)."""
    t0 = time.perf_counter()
    lang_r = langid.identify(body.text)
    out = {"language": lang_r, "backend": langid.default_backend().name}
    if body.mask:
        out["pii"] = pii.mask(body.text, use_ner=body.use_ner)
    out["ms"] = round((time.perf_counter() - t0) * 1000, 1)
    return out
