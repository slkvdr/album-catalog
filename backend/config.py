"""Настройки приложения. Всё, что зависит от места запуска, берётся из переменных окружения."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

# Где лежит файл базы. В контейнере это /data/loop.db (задаётся в Dockerfile)
DB_PATH = Path(os.environ.get("LOOP_DB_PATH", BASE_DIR / "loop.db"))

# Cookie входа передаётся только по HTTPS: на хостинге ставим LOOP_COOKIE_SECURE=1
COOKIE_SECURE = os.environ.get("LOOP_COOKIE_SECURE") == "1"

# Администратор может добавлять и удалять альбомы. Его аккаунт создаётся при запуске, если заданы обе переменные;
# зарегистрироваться с этой почтой через форму нельзя
ADMIN_EMAIL = os.environ.get("LOOP_ADMIN_EMAIL", "").strip().lower()
ADMIN_PASSWORD = os.environ.get("LOOP_ADMIN_PASSWORD", "")

# Тестовая учётная запись для проверки. Создаётся при запуске, если обе переменные заданы
DEMO_EMAIL = os.environ.get("LOOP_DEMO_EMAIL", "").strip().lower()
DEMO_PASSWORD = os.environ.get("LOOP_DEMO_PASSWORD", "")