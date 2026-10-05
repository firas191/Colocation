# Media service (spec 5.1). Build context: ./services
FROM python:3.12.14-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-fra tesseract-ocr-ara \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY media/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
# Detector models, checked against models.lock (a changed file fails the build)
COPY media/models.lock /app/models.lock
RUN mkdir -p /app/models && grep -v '^#' /app/models.lock | while read -r f sum url; do \
      curl -fsSL --retry 3 -o "/app/models/$f" "$url" && echo "$sum  /app/models/$f" | sha256sum -c -; done
COPY common/fs_common.py /app/fs_common.py
COPY media/*.py /app/
COPY media/tests /app/tests
COPY media/third_party /app/third_party
RUN useradd --system --uid 10001 app
USER app
ENV MEDIA_MODEL_DIR=/app/models PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --retries=12 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
