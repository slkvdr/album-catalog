"""Пароли и сессии: хеширование через argon2, сессия в HttpOnly-cookie."""
import hashlib
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Annotated

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import Cookie, Depends, HTTPException, Response

from .config import ADMIN_EMAIL, ADMIN_PASSWORD, COOKIE_SECURE, DB_PATH, DEMO_EMAIL, DEMO_PASSWORD
from .db import get_db

COOKIE_NAME = "loop_session"
SESSION_DAYS = 7

hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def _create_user_if_missing(name: str, email: str, password: str) -> None:
    connection = sqlite3.connect(DB_PATH)
    try:
        exists = connection.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone()
        if not exists:
            connection.execute(
                "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
                (name, email, hash_password(password)),
            )
            connection.commit()
    finally:
        connection.close()


def ensure_default_users() -> None:
    """Создаёт тестовую учётную запись и администратора, если они заданы в настройках и ещё не существуют."""
    if DEMO_EMAIL and DEMO_PASSWORD:
        _create_user_if_missing("Тест", DEMO_EMAIL, DEMO_PASSWORD)
    if ADMIN_EMAIL and ADMIN_PASSWORD:
        _create_user_if_missing("Администратор", ADMIN_EMAIL, ADMIN_PASSWORD)


def _token_hash(token: str) -> str:
    # В базе лежит только хеш токена: утечка базы не даёт готовых сессий
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def start_session(response: Response, db, user_id: int) -> None:
    now = datetime.now(timezone.utc)
    db.execute("DELETE FROM sessions WHERE expires_at < ?", (now.isoformat(),))
    token = secrets.token_urlsafe(32)
    expires = now + timedelta(days=SESSION_DAYS)
    db.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
        (_token_hash(token), user_id, expires.isoformat()),
    )
    db.commit()
    response.set_cookie(
        COOKIE_NAME, token,
        max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax", secure=COOKIE_SECURE,
    )


def end_session(response: Response, db, token: str | None) -> None:
    if token:
        db.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))
        db.commit()
    response.delete_cookie(COOKIE_NAME)


def is_admin(email: str) -> bool:
    return bool(ADMIN_EMAIL) and email == ADMIN_EMAIL


def get_optional_user(
    db=Depends(get_db),
    token: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
):
    """Пользователь по cookie или None, если он не вошёл."""
    if not token:
        return None
    row = db.execute(
        "SELECT u.id, u.name, u.email, u.created_at, s.expires_at"
        " FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
        (_token_hash(token),),
    ).fetchone()
    if row is None or datetime.fromisoformat(row["expires_at"]) <= datetime.now(timezone.utc):
        return None
    return row


def get_current_user(user=Depends(get_optional_user)):
    """Пользователь или ответ 401. Права проверяются здесь, на сервере."""
    if user is None:
        raise HTTPException(status_code=401, detail="Нужно войти в аккаунт")
    return user


def get_admin(user=Depends(get_current_user)):
    """Только администратор: остальным ответ 403, даже если они обошли интерфейс."""
    if not is_admin(user["email"]):
        raise HTTPException(status_code=403, detail="Недостаточно прав")
    return user