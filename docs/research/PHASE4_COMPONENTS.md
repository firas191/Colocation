# Phase 4 components: what exists, under which licence (read 2026-10-04)

Pages were read on 2026-10-04 from the primary source (model card, repository, PyPI JSON, official docs), mostly
through a web-reading tool that summarises pages; figures that decide a choice are checked again when the component
is installed (versions are pinned in `docs/VERSIONS.md` at that point). "Not verified" means exactly that. Nothing
here is a measurement on this project's data; measurements are in `docs/TEST_REPORT.md`.

## 1. Speech recognition

| Model | Licence | Size | Arabic / Tunisian evidence (as published, test set named) | Runtime |
|---|---|---|---|---|
| openai/whisper-large-v3-turbo | MIT | 809M params; CT2 fp16 1.62 GB (mobiuslabsgmbh/faster-whisper-large-v3-turbo, MIT) | none for Arabic on the card; card warns of uneven accents/dialects | faster-whisper, whisper.cpp |
| openai/whisper-small | Apache-2.0 | 242M; CT2 484 MB | none | faster-whisper |
| openai/whisper-medium | Apache-2.0 | 764M; CT2 1.53 GB | none | faster-whisper |
| linagora/linto-asr-ar-tn-0.1 | Apache-2.0 | Kaldi TDNN + LM (size not verified) | WER/CER: TunSwitchCS 20.51/17.72, TunSwitchTO 22.54/11.13, TARIC 16.06/10.60, OneStory 4.47/1.53 | Vosk, CPU |
| TuniSpeech-AI/whisper-tunisian-dialect | **CC-BY-NC-4.0** | 1.54B (large-v2 + merged LoRA) | card: none; cited paper: large-v2 WER 24.74 / CER 8.32 on an unreleased test split | transformers; CT2 conversion possible |
| oddadmix/Whisperv3-tunisian-codeswitch | **no licence stated** | 1.54B F32 | NADI 2026 blind test WER 15.22 | not usable without a licence |
| SalahZa/Code_Switched_Tunisian_Speech_Recognition | Apache-2.0 | 3 wav2vec2 + mixer | TunSwitch CS WER 29.47 / CER 12.44 | SpeechBrain |
| facebookresearch/omnilingual-asr | Apache-2.0 | CTC 300M (~2 GiB VRAM) / 1B (~3 GiB) | `aeb_Arab` supported; 7B LLM variant aeb CER 20.1 (test set not named) | fairseq2 |
| facebook/mms-1b-all, seamless-m4t-v2 | CC-BY-NC-4.0 | 1B / 2.3B | no `aeb` | — |
| nvidia/stt_ar_fastconformer_hybrid_large_pcd_v1.0 | CC-BY-4.0 | ~115M | MSA only: FLEURS WER 12.94 | NeMo |

- faster-whisper 1.2.1 (MIT), ctranslate2 4.8.2 (MIT): GPU needs CUDA 12 + cuDNN 9; documented VRAM for large-v2 int8 is 2,926 MB (RTX 3070 Ti); int8 VRAM for large-v3-turbo is **not documented**. GTX 1650 compute capability is **not verified** from NVIDIA's page (only the 1650 Ti is listed, at 7.5).
- jiwer 4.0.0 (Apache-2.0) for WER/CER.
- No ASR model found that outputs Latin-script arabizi.

Sources: huggingface.co pages and `/api/models/<id>` for every repo above; github.com/SYSTRAN/faster-whisper README;
github.com/OpenNMT/CTranslate2 docs/quantization.md; github.com/facebookresearch/omnilingual-asr README;
scitepress.org/Papers/2026/144577/144577.pdf; pypi.org JSON for faster-whisper, ctranslate2, jiwer.

### Speech datasets

| Dataset | Licence | Access | Tunisian / code-switched |
|---|---|---|---|
| google/fleurs (fr_fr, en_us, ar_eg) | CC-BY-4.0 | open (HF parquet) | no; whether ar_eg is MSA is not verified |
| linagora/linto-dataset-audio-ar-tn | CC-BY-4.0 | open (HF parquet), test split 799 | yes: subsets TunSwitchCS, TunSwitchTO, OneStory, ApprendreLeTunisien, YouTube... |
| TunSwitch (zenodo.org/records/8370566) | CC-BY-4.0 | open | yes |
| Mozilla Common Voice | CC0 | since Oct 2025 only through Mozilla Data Collective (account, terms, API key) | no |
| FARUKxAUTO/tunisian-asr-cleaned, deepdml/Tunisian_MSA | **no licence stated** | — | not used |

## 2. Language identification and PII (Text service)

| Component | Version | Licence | Notes |
|---|---|---|---|
| GlotLID v3 (cis-lmu/glotlid, fastText) | model_v3, 1.69 GB | Apache-2.0 plus notices | labels include `aeb_Arab` (F1 0.912 as published), `arb_Arab`, `arb_Latn`, `fra_Latn`, `eng_Latn`; **no `aeb_Latn` (arabizi)** |
| fastText lid.176 | 126 MB | CC BY-SA 3.0 | one `ar` label, no dialects |
| lingua-language-detector | 2.2.0 | Apache-2.0 | 75 languages, Arabic one label, no arabizi |
| camel-tools dialect ID | 1.6.0, data 282 MB | MIT | 25 cities + MSA incl. Tunis and Sfax; Arabic script only |
| OpenLID v1/v2 | — | GPL-3.0 | `aeb_Arab` F1 0.34 / 0.49 |
| NLLB LID | — | CC-BY-NC-4.0 | — |
| Arabizi detectors | — | — | none found with a licence |
| phonenumbers | 9.0.40 | Apache-2.0 | `PhoneNumberMatcher` on free text |
| schwifty | 2026.7.3 | MIT | IBAN TN (24), FR (27), GB (22) |
| python-stdnum | 2.2 | LGPL-2.1+ | `fr.nir`, `luhn`, IBAN; no Tunisian CIN, no UK NINO |
| Presidio analyzer | 2.2.364 | MIT | English default; `UK_NINO` is a pattern without checksum |
| knowledgator/gliner-x-base | v0.5 | Apache-2.0 | 21 languages incl. ar, fr, en; ONNX quantised 303 MB; general NER; no ar/fr numbers on the card |
| urchade/gliner_multi_pii-v1 | — | Apache-2.0 | no Arabic |
| Davlan/xlm-roberta-base-ner-hrl | — | AFL-3.0 | ar, fr, en; 1.11 GB |
| CAMeL-Lab/bert-base-arabic-camelbert-msa-ner | — | Apache-2.0 | Arabic, 436 MB |

No published PII evaluation on Tunisian or Arabic/French code-switched text was found. Tunisian CIN validator, address
recognisers for TN/FR, and arabizi name NER: not found.

Sources: huggingface.co/cis-lmu/glotlid and raw.githubusercontent.com/cisnlp/GlotLID/main/languages-v3.md;
fasttext.cc/docs/en/language-identification.html; pypi.org JSON for each package; raw GitHub READMEs of lingua-py,
camel_tools, presidio (supported_entities.md, languages.md); huggingface.co cards of each NER model.

## 3. Media (Media service)

| Component | Version | Licence | Notes |
|---|---|---|---|
| Pillow | 12.3.0 | MIT-CMU | `MAX_IMAGE_PIXELS` 89,478,485: above it a warning, above 2x an error; make the warning an error. JPEG save carries `info["comment"]` over by default, so strip by rebuilding from pixels |
| ImageHash | 4.3.2 | BSD-2-Clause | `phash(hash_size=8)` = 64 bits |
| opencv-python-headless | 4.14.0.94 / 5.0.0.93 | Apache-2.0 (wheels bundle FFmpeg LGPL) | `cv2.FaceDetectorYN`, `cv2.dnn.TextDetectionModel_DB` |
| YuNet face detector (opencv_zoo) | 2023mar ONNX | MIT | faces ~10–300 px; downscale or tile |
| PP-OCRv3 DB text detector (opencv_zoo) | — | Apache-2.0 | Arabic not documented |
| YOLOX-S / NanoDet (opencv_zoo) | — | Apache-2.0 | COCO `tv`, `laptop`, `cell phone`, `book` |
| Ultralytics YOLO, EAST, PyMuPDF, InsightFace weights | — | AGPL / GPL / AGPL / non-commercial | **not used** |
| pdfplumber | 0.11.10 | MIT | machine-generated PDFs; tables; RTL options |
| pypdfium2 | 5.13.0 | BSD-3 / Apache-2.0 | rasterising pages for OCR |
| Tesseract | 5.5.3 | Apache-2.0 | `ara`, `fra`, `eng` traineddata Apache-2.0 |
| OCRmyPDF | 17.13.0 | MPL-2.0 | Ghostscript (AGPL) avoidable on recent versions, not verified for 17.13 |
| Docling | 2.133.0 | MIT (models Apache-2.0 / CDLA-P-2.0) | layout + tables + OCR on CPU; heavy (torch); Arabic quality not verified |
| ffmpeg | Debian build | GPL v2+ binaries | run as a separate process; `select='gt(scene,0.4)'` and interval selection documented in filters.texi |
| filetype | 1.2.0 | MIT | magic-byte sniffing, 261 bytes |

Sources: pypi.org JSON per package; pillow.readthedocs.io; raw GitHub sources of Pillow, imagehash, opencv_zoo
model READMEs and LICENSE files, Tesseract, tessdata_best, OCRmyPDF, Docling; ffmpeg.org/legal.html;
raw.githubusercontent.com/FFmpeg/FFmpeg/master/doc/filters.texi.

## 4. Vision models (Ollama)

Ollama: latest stable v0.35.1 (2026-09-29); the stack pins 0.34.4, whose notes say structured outputs on thinking
models apply in a single pass. The docs state vision models accept the same `format` (JSON schema) parameter.

| Tag | Download | Licence | Published numbers (model cards) |
|---|---|---|---|
| qwen3.5:2b | 2.7 GB (q4_K_M 1.9 GB) | Apache-2.0 | non-thinking by default; OCRBench 85.4; CountBench 86.8; RealWorldQA 71.2 (non-thinking) |
| qwen3.5:4b (already installed for P1/P2) | 3.4 GB | Apache-2.0 | OCRBench 85.0; CountBench 96.3; RealWorldQA 79.5; thinks by default (D-053) |
| qwen3-vl:4b-instruct | 3.3 GB | Apache-2.0 | OCRBench 80.8; CountBench 89.4; RealWorldQA 73.2; plain `:4b` is the thinking variant |
| gemma4:e2b-it-qat | 4.3 GB | Apache-2.0 | OCR documented; no counting or scene numbers |
| gemma3:4b | 3.3 GB | Gemma Terms of Use | CountBenchQA 26.1 |
| qwen2.5vl:3b | 3.2 GB | Qwen Research Licence (non-commercial) | — |

No published benchmark of these models on room-type classification of rental photos was found.

Sources: ollama.com/library/<model> and /tags pages; huggingface.co model cards (Qwen/Qwen3.5-2B, Qwen3.5-4B,
Qwen3-VL-4B-Instruct, google/gemma-4-E2B-it, google/gemma-3-4b-it); docs.ollama.com/capabilities/structured-outputs;
github.com/ollama/ollama/releases.
