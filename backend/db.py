"""Подключение к SQLite, схема базы и начальное наполнение."""
import json
import sqlite3

from .config import BASE_DIR, DB_PATH

SEED_PATH = BASE_DIR / "albums_seed.json"

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS albums (
    id          INTEGER PRIMARY KEY,
    title       TEXT NOT NULL,
    artist      TEXT NOT NULL,
    year        INTEGER NOT NULL,
    genre       TEXT NOT NULL,
    style       TEXT NOT NULL,
    label       TEXT,
    rating      REAL NOT NULL,
    cover       TEXT NOT NULL,
    description TEXT NOT NULL,
    mb_title    TEXT,
    tracks      TEXT  -- треклист вручную: JSON [[название, "м:сс"], ...]; NULL — берётся из iTunes
);

CREATE TABLE IF NOT EXISTS library (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    status   TEXT CHECK (status IN ('want', 'listening', 'listened')),
    rating   INTEGER CHECK (rating BETWEEN 1 AND 5),
    note     TEXT NOT NULL DEFAULT '',
    favorite INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, album_id)
);

CREATE TABLE IF NOT EXISTS reviews (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    album_id   INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, album_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Кэш ответов iTunes: треклисты запрашивает наш сервер, а не браузер посетителя
CREATE TABLE IF NOT EXISTS itunes_cache (
    url_key    TEXT PRIMARY KEY,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
);

-- Альбом вместе с оценкой слушателей: пока никто не оценил, показывается стартовая оценка из albums.rating
DROP VIEW IF EXISTS album_view;
CREATE VIEW album_view AS
SELECT a.id, a.title, a.artist, a.year, a.genre, a.style, a.label, a.cover, a.description, a.mb_title, a.tracks,
       a.rating AS base_rating,
       (SELECT COUNT(l.rating) FROM library l WHERE l.album_id = a.id) AS votes,
       ROUND(COALESCE((SELECT AVG(l.rating) FROM library l WHERE l.album_id = a.id), a.rating), 1) AS rating,
       (SELECT COUNT(*) FROM reviews r WHERE r.album_id = a.id) AS review_count
FROM albums a;
"""


def get_db():
    """Зависимость FastAPI: своё подключение на каждый запрос."""
    connection = sqlite3.connect(DB_PATH, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    # LIKE в SQLite не различает регистр только у латиницы, поэтому для поиска по-русски нужна своя функция
    connection.create_function("fold", 1, lambda value: value.casefold() if value else value)
    try:
        yield connection
    finally:
        connection.close()


def _upgrade(connection) -> int:
    """Создаёт схему; базу старой версии переносит без потери данных (до версии 2 статус был обязательным).
    Возвращает версию, в которой была база до запуска."""
    (version,) = connection.execute("PRAGMA user_version").fetchone()
    albums_exist = connection.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'albums'").fetchone()
    if albums_exist and "tracks" not in [row[1] for row in connection.execute("PRAGMA table_info(albums)")]:
        connection.execute("ALTER TABLE albums ADD COLUMN tracks TEXT")  # база до появления ручных треклистов
    has_old_library = version < 2 and connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'library'"
    ).fetchone()
    if has_old_library:
        connection.execute("ALTER TABLE library RENAME TO library_old")
    connection.executescript(SCHEMA)
    if has_old_library:
        connection.execute(
            "INSERT INTO library (user_id, album_id, status, rating, note, added_at)"
            " SELECT user_id, album_id, status, rating, note, added_at FROM library_old"
        )
        connection.execute("DROP TABLE library_old")
    if "favorite" not in [row[1] for row in connection.execute("PRAGMA table_info(library)")]:
        connection.execute("ALTER TABLE library ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0")  # база до появления «Любимого»
    connection.execute("PRAGMA user_version = 4")
    return version


def init_db():
    """Создаёт таблицы и один раз при переходе на новую версию схемы загружает каталог из albums_seed.json.
    Дальше каталогом управляет администратор, поэтому удалённые альбомы не возвращаются."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        previous = _upgrade(connection)
        if previous >= 4:
            connection.commit()
            return
        albums = json.loads(SEED_PATH.read_text(encoding="utf-8"))
        if previous < 3:
            connection.executemany(
                "INSERT INTO albums (id, title, artist, year, genre, style, label, rating, cover, description, mb_title, tracks)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                " ON CONFLICT (id) DO UPDATE SET title = excluded.title, artist = excluded.artist,"
                " year = excluded.year, genre = excluded.genre, style = excluded.style, label = excluded.label,"
                " rating = excluded.rating, cover = excluded.cover, description = excluded.description,"
                " mb_title = excluded.mb_title, tracks = excluded.tracks",
                [
                    (a["id"], a["title"], a["artist"], a["year"], a["genre"], a["style"], a.get("label"),
                     a["rating"], a["cover"], a["description"], a.get("mbTitle"),
                     json.dumps(a["tracks"], ensure_ascii=False) if a.get("tracks") else None)
                    for a in albums
                ],
            )
        else:
            # база версии 3: каталог уже в рабочем состоянии, заполняем только пустые треклисты
            connection.executemany(
                "UPDATE albums SET tracks = ? WHERE id = ? AND tracks IS NULL",
                [(json.dumps(a["tracks"], ensure_ascii=False), a["id"]) for a in albums if a.get("tracks")],
            )
        connection.commit()
    finally:
        connection.close()