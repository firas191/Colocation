# Telegram long-polling relay (D-079). Build context: ./services
FROM python:3.12.14-slim
WORKDIR /app
COPY telegram/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY telegram/poller.py /app/poller.py
COPY telegram/tests /app/tests
RUN useradd --system --uid 10001 app
USER app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
CMD ["python", "poller.py"]
