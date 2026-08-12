from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class AppConfig(Base):
    """Server-wide defaults (not per-user Immich credentials)."""

    __tablename__ = "app_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    default_immich_url: Mapped[str] = mapped_column(String(1024), default="")
    immich_server_name: Mapped[str] = mapped_column(String(255), default="Immich")
    weather_api_key: Mapped[str] = mapped_column(Text, default="")
    weather_units: Mapped[str] = mapped_column(String(16), default="imperial")


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    immich_user_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Compatibility mirror of the single server-wide Immich URL. Runtime
    # configuration is owned by AppConfig; users do not choose their own URL.
    immich_url: Mapped[str] = mapped_column(String(1024), default="")
    immich_api_key: Mapped[str] = mapped_column(Text, default="")
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    frames: Mapped[list["Frame"]] = relationship(back_populates="owner")
    sessions: Mapped[list["UserSession"]] = relationship(back_populates="user")


class UserSession(Base):
    __tablename__ = "user_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    token: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    user: Mapped[User] = relationship(back_populates="sessions")


class Frame(Base):
    __tablename__ = "frames"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    owner_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id"),
        nullable=True,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(255))
    token: Mapped[str] = mapped_column(String(128), unique=True, index=True)

    # Photo source: "library" (entire Immich-visible library) or "album"
    source_type: Mapped[str] = mapped_column(String(32), default="library")
    album_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    interval_seconds: Mapped[int] = mapped_column(Integer, default=15)
    image_fit: Mapped[str] = mapped_column(String(16), default="contain")

    show_clock: Mapped[bool] = mapped_column(Boolean, default=True)
    show_photo_date: Mapped[bool] = mapped_column(Boolean, default=True)
    show_photo_location: Mapped[bool] = mapped_column(Boolean, default=True)
    show_weather: Mapped[bool] = mapped_column(Boolean, default=False)
    weather_location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Opt-in Immich write-backs from the kiosk (rotate / archive).
    allow_photo_actions: Mapped[bool] = mapped_column(Boolean, default=False)
    # Legacy on/off flag; prefer seasonal_strength (kept for older DBs).
    seasonal_weighting: Mapped[bool] = mapped_column(Boolean, default=True)
    # 0 = off … 5 = mostly seasonal. Strength 3 ≈ former default on.
    seasonal_strength: Mapped[int] = mapped_column(Integer, default=3)
    # JSON blob for kiosk overlay placement / formatting / typography
    overlay_json: Mapped[str] = mapped_column(Text, default="{}")
    # JSON blob for people exclude/prefer (and later tags)
    context_json: Mapped[str] = mapped_column(Text, default="{}")
    # JSON blob for transitions / pan / backdrop presentation
    slideshow_json: Mapped[str] = mapped_column(Text, default="{}")
    # False until the owner saves settings for the first time (setup waiting room).
    configured: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    owner: Mapped[User | None] = relationship(back_populates="frames")
    devices: Mapped[list["Device"]] = relationship(back_populates="frame")


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    device_key: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255), default="Photo Frame")
    frame_id: Mapped[int | None] = mapped_column(
        ForeignKey("frames.id"),
        nullable=True,
        index=True,
    )
    setup_code: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)
    setup_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    frame: Mapped[Frame | None] = relationship(back_populates="devices")


# Legacy table name kept so existing DBs can be migrated once.
class Settings(Base):
    __tablename__ = "settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    immich_url: Mapped[str] = mapped_column(String(1024), default="")
    immich_api_key: Mapped[str] = mapped_column(Text, default="")
