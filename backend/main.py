"""LOOP: сервер каталога музыкальных альбомов (FastAPI + SQLite)."""
import json
import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Cookie, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationInfo, field_validator

from .auth import (
    COOKIE_NAME, end_session, ensure_default_users, get_admin, get_current_user, get_optional_user,
    hash_password, is_admin, start_session, verify_password,
)
from .db import get_db, init_db

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    ensure_default_users()
    yield


app = FastAPI(title="LOOP", lifespan=lifespan)


@app.middleware("http")
async def revalidate_pages(request: Request, call_next):
    """Браузер проверяет страницы, стили и скрипты при каждой загрузке, поэтому не показывает устаревшие версии."""
    response = await call_next(request)
    if not request.url.path.startswith("/api"):
        response.headers["Cache-Control"] = "no-cache"
    return response

Db = Annotated[sqlite3.Connection, Depends(get_db)]
CurrentUser = Annotated[sqlite3.Row, Depends(get_current_user)]
OptionalUser = Annotated[sqlite3.Row | None, Depends(get_optional_user)]
Admin = Annotated[sqlite3.Row, Depends(get_admin)]

DEFAULT_COVER = "img/placeholder.svg"


# ---------- Ошибки валидации: понятные сообщения по полям ----------

@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    fields = {}
    for error in exc.errors():
        name = str(error["loc"][-1])
        message = error["msg"]
        fields.setdefault(name, message.removeprefix("Value error, ") if message.startswith("Value error, ") else "Некорректное значение")
    return JSONResponse(status_code=422, content={"detail": "Проверьте заполненные поля", "fields": fields})


# ---------- Модели запросов ----------

def clean_name(value: str) -> str:
    value = value.strip()
    if not 2 <= len(value) <= 50:
        raise ValueError("Имя должно быть от 2 до 50 символов.")
    return value


def clean_email(value: str) -> str:
    value = value.strip().lower()
    if len(value) > 254 or not EMAIL_PATTERN.match(value):
        raise ValueError("Проверьте адрес: он должен выглядеть как name@example.com.")
    return value


def check_password(value: str) -> str:
    if not 8 <= len(value) <= 128:
        raise ValueError("Пароль — от 8 до 128 символов.")
    return value


class RegisterIn(BaseModel):
    name: str
    email: str
    password: str

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        return clean_name(value)

    @field_validator("email")
    @classmethod
    def check_email(cls, value: str) -> str:
        return clean_email(value)

    @field_validator("password")
    @classmethod
    def check_password_length(cls, value: str) -> str:
        return check_password(value)


class ContactIn(BaseModel):
    name: str
    email: str
    message: str

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        return clean_name(value)

    @field_validator("email")
    @classmethod
    def check_email(cls, value: str) -> str:
        return clean_email(value)

    @field_validator("message")
    @classmethod
    def check_message(cls, value: str) -> str:
        value = value.strip()
        if not 10 <= len(value) <= 1000:
            raise ValueError("Сообщение — от 10 до 1000 символов.")
        return value


class ProfileIn(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        return clean_name(value)


class PasswordIn(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def check_new_password(cls, value: str) -> str:
        return check_password(value)


class LoginIn(BaseModel):
    email: str
    password: str

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return value.strip().lower()


FIELD_LIMITS = {"title": 120, "artist": 120, "genre": 40, "style": 60}


class AlbumIn(BaseModel):
    title: str
    artist: str
    year: int
    genre: str
    style: str
    label: str | None = None
    rating: float = 4.0
    cover: str | None = None
    description: str
    mb_title: str | None = None

    @field_validator("title", "artist", "genre", "style")
    @classmethod
    def check_required_text(cls, value: str, info: ValidationInfo) -> str:
        value = value.strip()
        limit = FIELD_LIMITS[info.field_name]
        if not 1 <= len(value) <= limit:
            raise ValueError(f"Заполните поле (до {limit} символов).")
        return value

    @field_validator("year")
    @classmethod
    def check_year(cls, value: int) -> int:
        if not 1900 <= value <= 2100:
            raise ValueError("Укажите год от 1900 до 2100.")
        return value

    @field_validator("rating")
    @classmethod
    def check_rating(cls, value: float) -> float:
        if not 1 <= value <= 5:
            raise ValueError("Оценка — число от 1 до 5.")
        return round(value, 1)

    @field_validator("label", "mb_title")
    @classmethod
    def check_optional_text(cls, value: str | None) -> str | None:
        value = (value or "").strip()
        if len(value) > 120:
            raise ValueError("Слишком длинное значение.")
        return value or None

    @field_validator("cover")
    @classmethod
    def check_cover(cls, value: str | None) -> str | None:
        value = (value or "").strip()
        if not value:
            return None
        if len(value) > 300 or not value.startswith(("img/", "http://", "https://")):
            raise ValueError("Укажите путь вида img/файл.jpg или ссылку на изображение.")
        return value

    @field_validator("description")
    @classmethod
    def check_description(cls, value: str) -> str:
        value = value.strip()
        if not 10 <= len(value) <= 1000:
            raise ValueError("Описание — от 10 до 1000 символов.")
        return value


class ReviewIn(BaseModel):
    text: str

    @field_validator("text")
    @classmethod
    def check_text(cls, value: str) -> str:
        value = value.strip()
        if not 10 <= len(value) <= 1000:
            raise ValueError("Рецензия — от 10 до 1000 символов.")
        return value


class LibraryIn(BaseModel):
    status: Literal["want", "listening", "listened"] | None = None
    rating: int | None = Field(default=None, ge=1, le=5)
    note: str | None = Field(default=None, max_length=500)
    favorite: bool | None = None


def album_json(row) -> dict:
    """Альбом для ответа API: треклист из базы (строка JSON) превращается в список."""
    album = dict(row)
    album["tracks"] = json.loads(album["tracks"]) if album["tracks"] else None
    return album


def user_json(row) -> dict:
    return {
        "id": row["id"], "name": row["name"], "email": row["email"],
        "created_at": row["created_at"], "is_admin": is_admin(row["email"]),
    }


@app.get("/api/health")
def health(db: Db):
    """Проверка для хостинга: сервер запущен и база отвечает."""
    db.execute("SELECT 1")
    return {"status": "ok"}


# ---------- Регистрация и вход ----------

@app.post("/api/auth/register", status_code=201)
def register(data: RegisterIn, response: Response, db: Db):
    if is_admin(data.email):  # почта администратора занята: его аккаунт создаётся при запуске из настроек
        raise HTTPException(status_code=409, detail="Аккаунт с такой почтой уже существует")
    try:
        cursor = db.execute(
            "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
            (data.name, data.email, hash_password(data.password)),
        )
        db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="Аккаунт с такой почтой уже существует")
    user = db.execute("SELECT id, name, email, created_at FROM users WHERE id = ?", (cursor.lastrowid,)).fetchone()
    start_session(response, db, user["id"])
    return user_json(user)


@app.post("/api/auth/login")
def login(data: LoginIn, response: Response, db: Db):
    user = db.execute(
        "SELECT id, name, email, created_at, password_hash FROM users WHERE email = ?", (data.email,)
    ).fetchone()
    if user is None or not verify_password(user["password_hash"], data.password):
        raise HTTPException(status_code=401, detail="Неверная почта или пароль")
    start_session(response, db, user["id"])
    return user_json(user)


@app.post("/api/auth/logout")
def logout(response: Response, db: Db, token: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None):
    end_session(response, db, token)
    return {"ok": True}


@app.get("/api/me")
def me(user: CurrentUser):
    return user_json(user)


@app.put("/api/me")
def update_me(data: ProfileIn, user: CurrentUser, db: Db):
    db.execute("UPDATE users SET name = ? WHERE id = ?", (data.name, user["id"]))
    db.commit()
    row = db.execute("SELECT id, name, email, created_at FROM users WHERE id = ?", (user["id"],)).fetchone()
    return user_json(row)


@app.post("/api/me/password")
def change_password(data: PasswordIn, response: Response, user: CurrentUser, db: Db):
    row = db.execute("SELECT password_hash FROM users WHERE id = ?", (user["id"],)).fetchone()
    if not verify_password(row["password_hash"], data.current_password):
        return JSONResponse(
            status_code=400,
            content={"detail": "Проверьте заполненные поля", "fields": {"current_password": "Текущий пароль указан неверно."}},
        )
    db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(data.new_password), user["id"]))
    db.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))  # прежние входы закрываются
    db.commit()
    start_session(response, db, user["id"])
    return {"ok": True}


# ---------- Каталог (открыт всем) ----------

@app.get("/api/albums")
def list_albums(db: Db):
    rows = db.execute(
        "SELECT id, title, artist, year, genre, style, label, rating, base_rating, votes, review_count,"
        " cover, description, mb_title, tracks FROM album_view ORDER BY id"
    ).fetchall()
    return [album_json(row) for row in rows]


def fetch_album(db, album_id: int):
    return db.execute(
        "SELECT id, title, artist, year, genre, style, label, rating, base_rating, votes, review_count,"
        " cover, description, mb_title, tracks FROM album_view WHERE id = ?",
        (album_id,),
    ).fetchone()


@app.get("/api/albums/{album_id}")
def get_album(album_id: int, db: Db):
    row = fetch_album(db, album_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Альбом не найден")
    return album_json(row)


@app.post("/api/albums", status_code=201)
def create_album(data: AlbumIn, admin: Admin, db: Db):
    cursor = db.execute(
        "INSERT INTO albums (title, artist, year, genre, style, label, rating, cover, description, mb_title)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (data.title, data.artist, data.year, data.genre, data.style, data.label,
         data.rating, data.cover or DEFAULT_COVER, data.description, data.mb_title),
    )
    db.commit()
    return album_json(fetch_album(db, cursor.lastrowid))


@app.put("/api/albums/{album_id}")
def update_album(album_id: int, data: AlbumIn, admin: Admin, db: Db):
    cursor = db.execute(
        "UPDATE albums SET title = ?, artist = ?, year = ?, genre = ?, style = ?, label = ?,"
        " rating = ?, cover = ?, description = ?, mb_title = ? WHERE id = ?",
        (data.title, data.artist, data.year, data.genre, data.style, data.label,
         data.rating, data.cover or DEFAULT_COVER, data.description, data.mb_title, album_id),
    )
    db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Альбом не найден")
    return album_json(fetch_album(db, album_id))


@app.delete("/api/albums/{album_id}", status_code=204)
def delete_album(album_id: int, admin: Admin, db: Db):
    cursor = db.execute("DELETE FROM albums WHERE id = ?", (album_id,))  # списки и рецензии удаляются каскадом
    db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Альбом не найден")
    return Response(status_code=204)


@app.get("/api/albums/{album_id}/ratings")
def album_ratings(album_id: int, db: Db):
    """Из чего складывается оценка альбома: итог, число оценок и их распределение."""
    album = db.execute("SELECT rating, votes, base_rating FROM album_view WHERE id = ?", (album_id,)).fetchone()
    if album is None:
        raise HTTPException(status_code=404, detail="Альбом не найден")
    rows = db.execute(
        "SELECT rating, COUNT(*) AS n FROM library WHERE album_id = ? AND rating IS NOT NULL GROUP BY rating",
        (album_id,),
    ).fetchall()
    distribution = {str(stars): 0 for stars in range(1, 6)}
    for row in rows:
        distribution[str(row["rating"])] = row["n"]
    return {
        "rating": album["rating"],
        "votes": album["votes"],
        "starting_rating": album["base_rating"],
        "distribution": distribution,
    }


# ---------- Рецензии: читают все, пишут вошедшие ----------

@app.get("/api/albums/{album_id}/reviews")
def list_reviews(album_id: int, db: Db, user: OptionalUser):
    rows = db.execute(
        "SELECT r.user_id, u.name AS author, r.text, r.updated_at, l.rating"
        " FROM reviews r JOIN users u ON u.id = r.user_id"
        " LEFT JOIN library l ON l.user_id = r.user_id AND l.album_id = r.album_id"
        " WHERE r.album_id = ? ORDER BY r.updated_at DESC, r.rowid DESC LIMIT 50",
        (album_id,),
    ).fetchall()
    return [
        {
            "author": row["author"],
            "text": row["text"],
            "rating": row["rating"],
            "updated_at": row["updated_at"],
            "mine": user is not None and row["user_id"] == user["id"],
        }
        for row in rows
    ]


@app.put("/api/albums/{album_id}/review")
def save_review(album_id: int, data: ReviewIn, user: CurrentUser, db: Db):
    if fetch_album(db, album_id) is None:
        raise HTTPException(status_code=404, detail="Альбом не найден")
    db.execute(
        "INSERT INTO reviews (user_id, album_id, text) VALUES (?, ?, ?)"
        " ON CONFLICT (user_id, album_id) DO UPDATE SET text = excluded.text, updated_at = datetime('now')",
        (user["id"], album_id, data.text),
    )
    db.commit()
    return {"ok": True}


@app.delete("/api/albums/{album_id}/review", status_code=204)
def delete_review(album_id: int, user: CurrentUser, db: Db):
    db.execute("DELETE FROM reviews WHERE user_id = ? AND album_id = ?", (user["id"], album_id))
    db.commit()
    return Response(status_code=204)


@app.get("/api/genres")
def list_genres(db: Db, q: str = "", limit: int = Query(default=20, ge=1, le=50)):
    """Жанры с числом альбомов: самые частые первыми, поиск по части названия. Страница берёт их по мере надобности."""
    escaped = q.strip().casefold().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    pattern = "%" + escaped + "%"
    rows = db.execute(
        "SELECT genre, COUNT(*) AS n FROM albums WHERE fold(genre) LIKE ? ESCAPE '\\'"
        " GROUP BY genre ORDER BY n DESC, genre LIMIT ?",
        (pattern, limit),
    ).fetchall()
    (total,) = db.execute(
        "SELECT COUNT(DISTINCT genre) FROM albums WHERE fold(genre) LIKE ? ESCAPE '\\'", (pattern,)
    ).fetchone()
    return {"total": total, "items": [{"genre": row["genre"], "count": row["n"]} for row in rows]}


# ---------- Треклисты: сервер запрашивает iTunes и кэширует ответы ----------
# Браузер посетителя обращается только к нашему сайту, поэтому его сеть или VPN на треклисты не влияют.
# Пропускаются только два метода iTunes и только известные параметры.

ITUNES_PARAMS = {
    "search": {"term", "entity", "limit", "country", "media"},
    "lookup": {"id", "entity", "country"},
}
ITUNES_CACHE_DAYS = 30


@app.get("/api/itunes/{endpoint}")
def itunes_proxy(endpoint: Literal["search", "lookup"], request: Request, db: Db):
    params = sorted((k, v) for k, v in request.query_params.items() if k in ITUNES_PARAMS[endpoint])
    if not params or any(len(value) > 200 for _, value in params):
        raise HTTPException(status_code=400, detail="Некорректный запрос")
    query = urllib.parse.urlencode(params)
    key = f"{endpoint}?{query}"

    cached = db.execute(
        "SELECT body FROM itunes_cache WHERE url_key = ? AND created_at > datetime('now', ?)",
        (key, f"-{ITUNES_CACHE_DAYS} days"),
    ).fetchone()
    if cached:
        return Response(cached["body"], media_type="application/json")

    try:
        with urllib.request.urlopen(f"https://itunes.apple.com/{key}", timeout=10) as source:
            body = source.read().decode("utf-8")
        json.loads(body)  # убеждаемся, что пришёл JSON
    except urllib.error.HTTPError as error:
        status = 429 if error.code in (403, 429) else 502
        raise HTTPException(status_code=status, detail="Источник данных ограничил запросы или недоступен")
    except (urllib.error.URLError, TimeoutError, ValueError):
        raise HTTPException(status_code=502, detail="Источник данных недоступен")

    db.execute(
        "INSERT INTO itunes_cache (url_key, body) VALUES (?, ?)"
        " ON CONFLICT (url_key) DO UPDATE SET body = excluded.body, created_at = datetime('now')",
        (key, body),
    )
    db.commit()
    return Response(body, media_type="application/json")


# ---------- Обратная связь: пишут все, читает и удаляет администратор ----------

@app.post("/api/contact", status_code=201)
def send_message(data: ContactIn, db: Db):
    (recent,) = db.execute(
        "SELECT COUNT(*) FROM messages WHERE email = ? AND created_at > datetime('now', '-1 hour')", (data.email,)
    ).fetchone()
    if recent >= 5:
        raise HTTPException(status_code=429, detail="Слишком много сообщений. Попробуйте позже")
    db.execute("INSERT INTO messages (name, email, text) VALUES (?, ?, ?)", (data.name, data.email, data.message))
    db.commit()
    return {"ok": True}


@app.get("/api/messages")
def list_messages(admin: Admin, db: Db):
    rows = db.execute("SELECT id, name, email, text, created_at FROM messages ORDER BY id DESC LIMIT 200").fetchall()
    return [dict(row) for row in rows]


@app.delete("/api/messages/{message_id}", status_code=204)
def delete_message(message_id: int, admin: Admin, db: Db):
    cursor = db.execute("DELETE FROM messages WHERE id = ?", (message_id,))
    db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Сообщение не найдено")
    return Response(status_code=204)


# ---------- Личный список, оценки и заметки (только для вошедших) ----------
# Строка в library появляется, когда у альбома есть статус, оценка, заметка или отметка «любимое».
# Статус пустой, если альбом только оценён и в список не добавлен.

@app.get("/api/library")
def get_library(user: CurrentUser, db: Db):
    rows = db.execute(
        "SELECT album_id, status, rating, note, favorite, added_at FROM library"
        " WHERE user_id = ? ORDER BY added_at DESC, rowid DESC",
        (user["id"],),
    ).fetchall()
    return [dict(row) for row in rows]


@app.put("/api/library/{album_id}")
def save_library_item(album_id: int, data: LibraryIn, user: CurrentUser, db: Db):
    if db.execute("SELECT 1 FROM albums WHERE id = ?", (album_id,)).fetchone() is None:
        raise HTTPException(status_code=404, detail="Альбом не найден")

    current = db.execute(
        "SELECT status, rating, note, favorite FROM library WHERE user_id = ? AND album_id = ?",
        (user["id"], album_id),
    ).fetchone()
    values = {"status": None, "rating": None, "note": "", "favorite": 0} if current is None else dict(current)
    values.update(data.model_dump(exclude_unset=True))  # меняются только переданные поля
    values["note"] = (values["note"] or "").strip()
    values["favorite"] = int(bool(values["favorite"]))

    if values["status"] is None and values["rating"] is None and not values["note"] and not values["favorite"]:
        db.execute("DELETE FROM library WHERE user_id = ? AND album_id = ?", (user["id"], album_id))
    else:
        db.execute(
            "INSERT INTO library (user_id, album_id, status, rating, note, favorite) VALUES (?, ?, ?, ?, ?, ?)"
            " ON CONFLICT (user_id, album_id) DO UPDATE SET"
            " status = excluded.status, rating = excluded.rating, note = excluded.note, favorite = excluded.favorite",
            (user["id"], album_id, values["status"], values["rating"], values["note"], values["favorite"]),
        )
    db.commit()
    return {"album_id": album_id, **values}


@app.get("/api/stats")
def get_stats(user: CurrentUser, db: Db):
    totals = db.execute(
        "SELECT COALESCE(SUM(status IS NOT NULL), 0) AS total,"
        " COALESCE(SUM(status = 'listened'), 0) AS listened,"
        " AVG(rating) AS average_rating"
        " FROM library WHERE user_id = ?",
        (user["id"],),
    ).fetchone()
    favorite = db.execute(
        "SELECT a.genre FROM library l JOIN albums a ON a.id = l.album_id"
        " WHERE l.user_id = ? GROUP BY a.genre ORDER BY COUNT(*) DESC, a.genre LIMIT 1",
        (user["id"],),
    ).fetchone()
    average = totals["average_rating"]
    return {
        "total": totals["total"],
        "listened": totals["listened"],
        "average_rating": None if average is None else round(average, 1),
        "favorite_genre": favorite["genre"] if favorite else None,
    }


# Статические страницы подключаются последними, чтобы не перекрывать /api
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")