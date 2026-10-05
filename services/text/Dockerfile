# Text service (spec 5.1). Build context: ./services
FROM python:3.12.14-slim
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# CPU-only PyTorch for the NER model (the default PyPI wheel pulls the CUDA libraries, several GB)
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.14.1
COPY text/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY common/fs_common.py /app/fs_common.py
COPY text/*.py /app/
COPY text/tests /app/tests
RUN useradd --system --uid 10001 app && mkdir -p /models && chown app /models
USER app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MODELS_DIR=/models HF_HOME=/models/.hf \
    GLOTLID_MODEL=/models/glotlid/model_v3.bin NER_MODEL=/models/ner
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --retries=30 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
