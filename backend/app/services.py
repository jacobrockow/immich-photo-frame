import os
import secrets
from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .immich import ImmichClient, ImmichError
from .models import AppConfig, Device, Frame, Settings, User

DEFAULT_IMMICH_URL = os.getenv("DEFAULT_IMMICH_URL", "https://immich.example.com")
OPENWEATHER_API_KEY = os.getenv("OPENWEATHER_API_KEY", "")
SETUP_CODE_TTL_MINUTES = 30


def get_app_config(db: Session) -> AppConfig:
    config = db.get(AppConfig, 1)
    if config is None:
        config = AppConfig(
            id=1,
            default_immich_url=DEFAULT_IMMICH_URL,
            weather_api_key=OPENWEATHER_API_KEY,
            weather_units="imperial",
        )
        # Migrate server default from legacy global settings when present.
        legacy = db.get(Settings, 1)
        if legacy and legacy.immich_url:
            config.default_immich_url = legacy.immich_url
        db.add(config)
        db.commit()
        db.refresh(config)
    else:
        changed = False
        if not config.default_immich_url:
            config.default_immich_url = DEFAULT_IMMICH_URL
            changed = True
        if not getattr(config, "weather_api_key", None) and OPENWEATHER_API_KEY:
            config.weather_api_key = OPENWEATHER_API_KEY
            changed = True
        if not getattr(config, "weather_units", None):
            config.weather_units = "imperial"
            changed = True
        if changed:
            db.commit()
            db.refresh(config)
    return config


def weather_api_key(config: AppConfig) -> str:
    return (config.weather_api_key or OPENWEATHER_API_KEY or "").strip()


def migrate_legacy_immich_credentials(db: Session) -> None:
    """
    One-time helper: if legacy global Immich credentials exist and no users do,
    create a migrated user and assign orphan frames to them.
    """
    if db.query(User).count() > 0:
        return

    legacy = db.get(Settings, 1)
    if not legacy or not legacy.immich_url or not legacy.immich_api_key:
        return

    user = User(
        email="migrated@local",
        name="Migrated user",
        immich_url=legacy.immich_url.rstrip("/"),
        immich_api_key=legacy.immich_api_key,
        is_admin=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    for frame in db.query(Frame).filter(Frame.owner_user_id.is_(None)).all():
        frame.owner_user_id = user.id
    db.commit()


def user_to_out(user: User):
    from .schemas import UserOut

    return UserOut(
        id=user.id,
        email=user.email,
        name=user.name or user.email,
        immich_url=user.immich_url,
        api_key_configured=bool(user.immich_api_key),
        is_admin=bool(getattr(user, "is_admin", False)),
    )


def immich_for_user(user: User) -> ImmichClient:
    if not user.immich_url or not user.immich_api_key:
        raise HTTPException(status_code=409, detail="Immich is not configured for this user")
    return ImmichClient(user.immich_url, api_key=user.immich_api_key)


async def connect_with_password(
    db: Session,
    *,
    immich_url: str,
    email: str,
    password: str,
) -> User:
    try:
        client, login_data = await ImmichClient.login(immich_url, email, password)
        me = await client.get_my_user()
        try:
            api_key = await client.create_api_key()
        except ImmichError:
            # Some Immich permission sets block API key creation; fall back is not
            # possible without a key. Surface a clear error.
            raise HTTPException(
                status_code=502,
                detail=(
                    "Logged into Immich, but could not create an API key. "
                    "Create an API key in Immich and connect with the API key option."
                ),
            ) from None
    except ImmichError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc

    return upsert_user(
        db,
        email=me.get("email") or email,
        name=me.get("name") or me.get("email") or email,
        immich_user_id=str(me.get("id")) if me.get("id") else login_data.get("userId"),
        immich_url=immich_url.rstrip("/"),
        immich_api_key=api_key,
    )


async def connect_with_api_key(
    db: Session,
    *,
    immich_url: str,
    immich_api_key: str,
    email_hint: str | None = None,
) -> User:
    client = ImmichClient(immich_url, api_key=immich_api_key.strip())
    try:
        me = await client.get_my_user()
        await client.ping()
    except ImmichError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc

    email = me.get("email") or email_hint or f"{me.get('id')}@immich.local"
    return upsert_user(
        db,
        email=email,
        name=me.get("name") or email,
        immich_user_id=str(me.get("id")) if me.get("id") else None,
        immich_url=immich_url.rstrip("/"),
        immich_api_key=immich_api_key.strip(),
    )


def upsert_user(
    db: Session,
    *,
    email: str,
    name: str,
    immich_user_id: str | None,
    immich_url: str,
    immich_api_key: str,
) -> User:
    user = db.query(User).filter(User.email == email.lower()).first()
    if user is None and immich_user_id:
        user = db.query(User).filter(User.immich_user_id == immich_user_id).first()

    if user is None:
        # First account on the server becomes the server admin.
        user = User(email=email.lower(), is_admin=db.query(User).count() == 0)
        db.add(user)

    user.email = email.lower()
    user.name = name
    user.immich_user_id = immich_user_id
    user.immich_url = immich_url
    user.immich_api_key = immich_api_key
    db.commit()
    db.refresh(user)
    return user


def default_frame_name_for_user(user: User) -> str:
    raw = (user.name or "").strip() or (user.email or "").split("@")[0].strip()
    first = raw.split()[0] if raw else "My"
    return f"{first}'s Frame"


def create_frame_for_user(db: Session, user: User, name: str | None = None) -> Frame:
    cleaned = (name or "").strip()
    frame = Frame(
        owner_user_id=user.id,
        name=cleaned or default_frame_name_for_user(user),
        token=secrets.token_urlsafe(24),
        source_type="library",
        configured=False,
    )
    db.add(frame)
    db.commit()
    db.refresh(frame)
    return frame


def get_or_create_device(db: Session, device_key: str, name: str = "Photo Frame") -> Device:
    device = db.query(Device).filter(Device.device_key == device_key).first()
    if device is None:
        device = Device(device_key=device_key, name=name)
        db.add(device)
        db.commit()
        db.refresh(device)
    elif name and device.name != name and device.frame_id is None:
        device.name = name
        db.commit()
        db.refresh(device)
    return device


def refresh_setup_code(db: Session, device: Device) -> Device:
    device.setup_code = secrets.token_hex(3).upper()  # 6 hex chars
    device.setup_expires_at = datetime.utcnow() + timedelta(minutes=SETUP_CODE_TTL_MINUTES)
    device.last_seen_at = datetime.utcnow()
    db.commit()
    db.refresh(device)
    return device


def get_device_by_setup_code(db: Session, setup_code: str) -> Device:
    code = setup_code.strip().upper()
    device = db.query(Device).filter(Device.setup_code == code).first()
    if device is None:
        raise HTTPException(status_code=404, detail="Setup code not found")
    if device.setup_expires_at is None or device.setup_expires_at < datetime.utcnow():
        raise HTTPException(status_code=410, detail="Setup code expired")
    return device


def bind_device_to_frame(db: Session, device: Device, frame: Frame) -> Device:
    device.frame_id = frame.id
    device.setup_code = None
    device.setup_expires_at = None
    device.last_seen_at = datetime.utcnow()
    db.commit()
    db.refresh(device)
    return device
