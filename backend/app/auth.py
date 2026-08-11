import os
import secrets
from datetime import datetime, timedelta

from fastapi import Cookie, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from .database import get_db
from .models import User, UserSession

SESSION_COOKIE = "photoframe_session"
SESSION_DAYS = int(os.getenv("SESSION_DAYS", "30"))


def create_session(db: Session, user: User) -> str:
    token = secrets.token_urlsafe(32)
    session = UserSession(
        token=token,
        user_id=user.id,
        expires_at=datetime.utcnow() + timedelta(days=SESSION_DAYS),
    )
    db.add(session)
    db.commit()
    return token


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        samesite="lax",
        max_age=SESSION_DAYS * 24 * 60 * 60,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")


def get_optional_user(
    db: Session = Depends(get_db),
    photoframe_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> User | None:
    if not photoframe_session:
        return None

    session = (
        db.query(UserSession)
        .filter(UserSession.token == photoframe_session)
        .first()
    )
    if session is None or session.expires_at < datetime.utcnow():
        if session is not None:
            db.delete(session)
            db.commit()
        return None

    return db.get(User, session.user_id)


def require_user(user: User | None = Depends(get_optional_user)) -> User:
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


def require_admin(user: User = Depends(require_user)) -> User:
    if not bool(getattr(user, "is_admin", False)):
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def destroy_session(
    db: Session,
    token: str | None,
) -> None:
    if not token:
        return
    session = db.query(UserSession).filter(UserSession.token == token).first()
    if session is not None:
        db.delete(session)
        db.commit()
