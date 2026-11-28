FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    LOOP_DB_PATH=/data/loop.db

WORKDIR /app

# Сначала зависимости: этот слой пересобирается, только если изменился requirements.txt
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend ./backend
COPY frontend ./frontend

# Приложение работает не от root; /data — папка для базы (в compose к ней подключён том)
RUN useradd --create-home app && mkdir /data && chown app:app /data
USER app

EXPOSE 8000

# Порт задаёт платформа (Render) через переменную PORT; локально и в compose — 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('PORT', '8000'))"

CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
