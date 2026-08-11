import json
import os
import secrets
from datetime import datetime

from typing import Annotated

from fastapi import Cookie, Depends, FastAPI, Header, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from .auth import (
    SESSION_COOKIE,
    clear_session_cookie,
    create_session,
    destroy_session,
    require_admin,
    require_user,
    set_session_cookie,
)
from .database import Base, engine, get_db, migrate_schema
from .immich import ImmichError
from .models import Device, Frame, User
from .schemas import (
    AdminUserOut,
    AdminUserUpdate,
    AlbumOut,
    AlbumSource,
    AssetRotateRequest,
    ContextFilters,
    DeviceStatusOut,
    FrameCreate,
    FrameOut,
    FrameUpdate,
    ImmichSettingsIn,
    ImmichSettingsOut,
    KioskConfig,
    LibrarySource,
    LoginApiKeyIn,
    LoginPasswordIn,
    OverlaySettings,
    PersonOut,
    PhotoSource,
    SlideshowSettings,
    SetupCompleteApiKeyIn,
    SetupCompleteOut,
    SetupCompletePasswordIn,
    SetupStartIn,
    SetupStartOut,
    ServerSettingsIn,
    ServerSettingsOut,
    SetupStatusOut,
    UserOut,
    WeatherOut,
    WeatherSettingsIn,
    WeatherSettingsOut,
)
from .services import (
    SETUP_CODE_TTL_MINUTES,
    bind_device_to_frame,
    connect_with_api_key,
    connect_with_password,
    create_frame_for_user,
    default_frame_name_for_user,
    get_app_config,
    get_device_by_setup_code,
    get_or_create_device,
    immich_for_user,
    migrate_legacy_immich_credentials,
    refresh_setup_code,
    user_to_out,
    weather_api_key,
)
from .weather import OpenWeatherClient, WeatherError, clear_weather_cache, fetch_weather_icon


Base.metadata.create_all(bind=engine)
migrate_schema()

app = FastAPI(title="Immich Photo Frame", version="0.2.0")

origins = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    db = next(get_db())
    try:
        get_app_config(db)
        migrate_legacy_immich_credentials(db)
    finally:
        db.close()


def source_from_frame(frame: Frame) -> PhotoSource:
    if frame.source_type == "album":
        if not frame.album_id:
            raise HTTPException(
                status_code=500,
                detail="Frame has album source type but no album_id",
            )
        return AlbumSource(album_id=frame.album_id)
    return LibrarySource()


def apply_source(frame: Frame, source: PhotoSource) -> None:
    frame.source_type = source.type
    if isinstance(source, AlbumSource):
        frame.album_id = source.album_id
    else:
        frame.album_id = None


def overlay_from_frame(frame: Frame) -> OverlaySettings:
    raw = getattr(frame, "overlay_json", None) or "{}"
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
        if not isinstance(data, dict):
            return OverlaySettings()
        return OverlaySettings.model_validate(data)
    except Exception:
        return OverlaySettings()


def apply_overlay(frame: Frame, overlay: OverlaySettings) -> None:
    frame.overlay_json = overlay.model_dump_json()


def context_from_frame(frame: Frame) -> ContextFilters:
    raw = getattr(frame, "context_json", None) or "{}"
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
        if not isinstance(data, dict):
            return ContextFilters()
        return ContextFilters.model_validate(data)
    except Exception:
        return ContextFilters()


def apply_context(frame: Frame, context: ContextFilters) -> None:
    # Deduplicate by id; prefer/exclude are mutually exclusive (exclude wins).
    exclude_ids: set[str] = set()
    exclude_people = []
    for person in context.exclude_people:
        if person.id in exclude_ids:
            continue
        exclude_ids.add(person.id)
        exclude_people.append(person)

    prefer_people = []
    prefer_ids: set[str] = set()
    for person in context.prefer_people:
        if person.id in exclude_ids or person.id in prefer_ids:
            continue
        prefer_ids.add(person.id)
        prefer_people.append(person)

    cleaned = ContextFilters(
        exclude_people=exclude_people,
        prefer_people=prefer_people,
        prefer_strength=context.prefer_strength,
    )
    frame.context_json = cleaned.model_dump_json()


def slideshow_from_frame(frame: Frame) -> SlideshowSettings:
    raw = getattr(frame, "slideshow_json", None) or "{}"
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
        if not isinstance(data, dict):
            return SlideshowSettings()
        return SlideshowSettings.model_validate(data)
    except Exception:
        return SlideshowSettings()


def apply_slideshow(frame: Frame, slideshow: SlideshowSettings) -> None:
    frame.slideshow_json = slideshow.model_dump_json()


def seasonal_strength_from_frame(frame: Frame) -> int:
    from .playlist import clamp_strength

    if getattr(frame, "seasonal_strength", None) is not None:
        return clamp_strength(frame.seasonal_strength)
    return 3 if bool(getattr(frame, "seasonal_weighting", True)) else 0


def sync_seasonal_fields(frame: Frame) -> None:
    """Keep strength + legacy boolean aligned after writes."""
    strength = seasonal_strength_from_frame(frame)
    frame.seasonal_strength = strength
    frame.seasonal_weighting = strength > 0


def frame_to_out(
    frame: Frame,
    db: Session | None = None,
    owner: User | None = None,
) -> FrameOut:
    owner_user = owner
    if owner_user is None and db is not None and frame.owner_user_id is not None:
        owner_user = db.get(User, frame.owner_user_id)
    return FrameOut(
        id=frame.id,
        token=frame.token,
        name=frame.name,
        source=source_from_frame(frame),
        interval_seconds=frame.interval_seconds,
        image_fit=frame.image_fit,
        show_clock=frame.show_clock,
        show_photo_date=frame.show_photo_date,
        show_photo_location=bool(getattr(frame, "show_photo_location", True)),
        show_weather=frame.show_weather,
        weather_location=frame.weather_location,
        allow_photo_actions=bool(getattr(frame, "allow_photo_actions", False)),
        seasonal_strength=seasonal_strength_from_frame(frame),
        overlay=overlay_from_frame(frame),
        context=context_from_frame(frame),
        slideshow=slideshow_from_frame(frame),
        configured=bool(getattr(frame, "configured", True)),
        owner_user_id=frame.owner_user_id,
        owner_email=owner_user.email if owner_user else None,
        owner_name=(owner_user.name or owner_user.email) if owner_user else None,
    )


def accessible_frame(db: Session, frame_id: int, user: User) -> Frame:
    """Owner or server admin may view/edit the frame."""
    frame = db.get(Frame, frame_id)
    if frame is None:
        raise HTTPException(status_code=404, detail="Frame not found")
    if frame.owner_user_id == user.id or bool(getattr(user, "is_admin", False)):
        return frame
    raise HTTPException(status_code=404, detail="Frame not found")


def frame_owner(db: Session, frame: Frame) -> User:
    if frame.owner_user_id is None:
        raise HTTPException(status_code=409, detail="Frame has no owner")
    user = db.get(User, frame.owner_user_id)
    if user is None:
        raise HTTPException(status_code=409, detail="Frame owner not found")
    return user


async def albums_for_immich_user(user: User) -> list[AlbumOut]:
    client = immich_for_user(user)
    albums = await client.list_albums()
    return [
        AlbumOut(
            id=album["id"],
            albumName=album.get("albumName", "Unnamed album"),
            assetCount=album.get("assetCount", 0),
        )
        for album in albums
    ]


KIOSK_MAX_ASSETS = int(os.getenv("KIOSK_MAX_ASSETS", "1000"))
KIOSK_PAGE_SIZE = int(os.getenv("KIOSK_PAGE_SIZE", "100"))


async def assets_for_source(
    client,
    source: PhotoSource,
    *,
    seasonal_strength: int = 3,
    context: ContextFilters | None = None,
) -> tuple[list[dict], bool]:
    from .people import exclude_people
    from .playlist import build_playlist

    context = context or ContextFilters()
    exclude_ids = [person.id for person in context.exclude_people]
    prefer_ids = [person.id for person in context.prefer_people]
    needs_people = bool(exclude_ids or prefer_ids)

    # Oversample when excluding people so the post-filter pool can still fill.
    fetch_cap = KIOSK_MAX_ASSETS
    if exclude_ids:
        fetch_cap = min(KIOSK_MAX_ASSETS * 3, int(os.getenv("KIOSK_FETCH_CAP", "3000")))

    kwargs: dict = {
        "page_size": KIOSK_PAGE_SIZE,
        "max_assets": fetch_cap,
        "with_people": needs_people,
    }
    if isinstance(source, AlbumSource):
        raw = await client.search_assets(album_ids=[source.album_id], **kwargs)
    else:
        raw = await client.search_assets(**kwargs)

    filtered = exclude_people(raw, exclude_ids) if exclude_ids else raw
    truncated = len(raw) >= fetch_cap or (
        bool(exclude_ids) and len(filtered) >= KIOSK_MAX_ASSETS and len(raw) >= fetch_cap
    )
    playlist = build_playlist(
        filtered[:KIOSK_MAX_ASSETS],
        seasonal_strength=seasonal_strength,
        prefer_person_ids=prefer_ids,
        prefer_strength=context.prefer_strength if prefer_ids else 0,
    )
    return playlist, truncated


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/weather/icon/{icon_code}")
async def weather_icon(icon_code: str):
    """
    Proxy OpenWeather icons so kiosk devices only need the frame server.
    Icon codes look like 01d / 10n (validated server-side).
    """
    try:
        body, content_type = await fetch_weather_icon(icon_code)
    except WeatherError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return Response(
        content=body,
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=604800"},
    )


@app.get("/api/config")
def public_config(db: Session = Depends(get_db)):
    config = get_app_config(db)
    return {
        "default_immich_url": config.default_immich_url,
        "weather_configured": bool(weather_api_key(config)),
        "weather_units": config.weather_units or "imperial",
    }


def server_settings_out(config) -> ServerSettingsOut:
    return ServerSettingsOut(
        default_immich_url=config.default_immich_url or "",
        weather_api_key_configured=bool(weather_api_key(config)),
        weather_units=config.weather_units or "imperial",
    )


@app.get("/api/server", response_model=ServerSettingsOut)
def read_server_settings(
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    del user
    return server_settings_out(get_app_config(db))


@app.put("/api/server", response_model=ServerSettingsOut)
def write_server_settings(
    payload: ServerSettingsIn,
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    del user
    config = get_app_config(db)
    if payload.default_immich_url is not None:
        config.default_immich_url = payload.default_immich_url.strip().rstrip("/")
    if payload.weather_api_key.strip():
        config.weather_api_key = payload.weather_api_key.strip()
    if payload.weather_units is not None:
        config.weather_units = payload.weather_units
    db.commit()
    clear_weather_cache()
    return server_settings_out(config)


@app.get("/api/server/weather", response_model=WeatherSettingsOut)
def read_weather_settings(
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    del user
    config = get_app_config(db)
    return WeatherSettingsOut(
        api_key_configured=bool(weather_api_key(config)),
        weather_units=config.weather_units or "imperial",
    )


@app.put("/api/server/weather", response_model=WeatherSettingsOut)
def write_weather_settings(
    payload: WeatherSettingsIn,
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    del user
    config = get_app_config(db)
    if payload.weather_api_key.strip():
        config.weather_api_key = payload.weather_api_key.strip()
    config.weather_units = payload.weather_units
    db.commit()
    clear_weather_cache()
    return WeatherSettingsOut(
        api_key_configured=bool(weather_api_key(config)),
        weather_units=config.weather_units or "imperial",
    )


@app.post("/api/server/weather/test")
async def test_weather_settings(
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    del user
    config = get_app_config(db)
    key = weather_api_key(config)
    if not key:
        raise HTTPException(status_code=409, detail="Weather API key is not configured")
    try:
        client = OpenWeatherClient(key, units=config.weather_units or "imperial")
        await client.ping()
        return {"ok": True}
    except WeatherError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/admin/users", response_model=list[AdminUserOut])
def admin_list_users(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    del admin
    users = db.query(User).order_by(User.created_at.asc(), User.id.asc()).all()
    out: list[AdminUserOut] = []
    for row in users:
        out.append(
            AdminUserOut(
                id=row.id,
                email=row.email,
                name=row.name or row.email,
                immich_url=row.immich_url or "",
                api_key_configured=bool(row.immich_api_key),
                is_admin=bool(getattr(row, "is_admin", False)),
                frame_count=db.query(Frame).filter(Frame.owner_user_id == row.id).count(),
                created_at=row.created_at.isoformat() if row.created_at else None,
            )
        )
    return out


@app.patch("/api/admin/users/{user_id}", response_model=AdminUserOut)
def admin_update_user(
    user_id: int,
    payload: AdminUserUpdate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="User not found")

    if payload.is_admin is not None:
        if payload.is_admin is False and bool(getattr(target, "is_admin", False)):
            admin_count = (
                db.query(User).filter(User.is_admin.is_(True)).count()
            )
            if admin_count <= 1:
                raise HTTPException(
                    status_code=400,
                    detail="Cannot remove the last server admin",
                )
        target.is_admin = bool(payload.is_admin)
        db.commit()
        db.refresh(target)

    del admin
    return AdminUserOut(
        id=target.id,
        email=target.email,
        name=target.name or target.email,
        immich_url=target.immich_url or "",
        api_key_configured=bool(target.immich_api_key),
        is_admin=bool(getattr(target, "is_admin", False)),
        frame_count=db.query(Frame).filter(Frame.owner_user_id == target.id).count(),
        created_at=target.created_at.isoformat() if target.created_at else None,
    )


@app.get("/api/admin/frames", response_model=list[FrameOut])
def admin_list_frames(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    del admin
    frames = db.query(Frame).order_by(Frame.name.asc()).all()
    return [frame_to_out(frame, db=db) for frame in frames]


@app.post("/api/auth/login/password", response_model=UserOut)
async def login_password(
    payload: LoginPasswordIn,
    response: Response,
    db: Session = Depends(get_db),
):
    config = get_app_config(db)
    immich_url = (payload.immich_url or config.default_immich_url).rstrip("/")
    if not immich_url:
        raise HTTPException(status_code=400, detail="Immich URL is required")

    user = await connect_with_password(
        db,
        immich_url=immich_url,
        email=payload.email,
        password=payload.password,
    )
    token = create_session(db, user)
    set_session_cookie(response, token)
    return user_to_out(user)


@app.post("/api/auth/login/api-key", response_model=UserOut)
async def login_api_key(
    payload: LoginApiKeyIn,
    response: Response,
    db: Session = Depends(get_db),
):
    user = await connect_with_api_key(
        db,
        immich_url=payload.immich_url.rstrip("/"),
        immich_api_key=payload.immich_api_key,
        email_hint=payload.email,
    )
    token = create_session(db, user)
    set_session_cookie(response, token)
    return user_to_out(user)


@app.post("/api/auth/logout", status_code=204)
def logout(
    response: Response,
    db: Session = Depends(get_db),
    photoframe_session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
):
    destroy_session(db, photoframe_session)
    clear_session_cookie(response)


@app.get("/api/auth/me", response_model=UserOut)
def me(user: User = Depends(require_user)):
    return user_to_out(user)


@app.get("/api/me/immich", response_model=ImmichSettingsOut)
def read_my_immich(user: User = Depends(require_user), db: Session = Depends(get_db)):
    config = get_app_config(db)
    return ImmichSettingsOut(
        immich_url=user.immich_url or config.default_immich_url,
        api_key_configured=bool(user.immich_api_key),
        default_immich_url=config.default_immich_url,
    )


@app.put("/api/me/immich", response_model=ImmichSettingsOut)
async def write_my_immich(
    payload: ImmichSettingsIn,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    config = get_app_config(db)
    immich_url = (payload.immich_url or config.default_immich_url or "").rstrip("/")
    if not immich_url:
        raise HTTPException(status_code=400, detail="Immich URL is required")
    if not payload.immich_api_key.strip():
        raise HTTPException(status_code=400, detail="Immich API key is required")

    updated = await connect_with_api_key(
        db,
        immich_url=immich_url,
        immich_api_key=payload.immich_api_key,
        email_hint=user.email,
    )
    # Ensure we update the logged-in user row even if email differs slightly.
    if updated.id != user.id:
        user.immich_url = updated.immich_url
        user.immich_api_key = updated.immich_api_key
        user.immich_user_id = updated.immich_user_id or user.immich_user_id
        db.commit()
        db.refresh(user)
        updated = user

    return ImmichSettingsOut(
        immich_url=updated.immich_url,
        api_key_configured=bool(updated.immich_api_key),
        default_immich_url=config.default_immich_url,
    )


@app.post("/api/me/immich/test")
async def test_my_immich(user: User = Depends(require_user)):
    try:
        client = immich_for_user(user)
        await client.ping()
        return {"ok": True}
    except ImmichError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/albums", response_model=list[AlbumOut])
async def list_albums(user: User = Depends(require_user)):
    try:
        return await albums_for_immich_user(user)
    except ImmichError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/frames/{frame_id}/albums", response_model=list[AlbumOut])
async def list_frame_albums(
    frame_id: int,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    frame = accessible_frame(db, frame_id, user)
    try:
        return await albums_for_immich_user(frame_owner(db, frame))
    except ImmichError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/frames/{frame_id}/people", response_model=list[PersonOut])
async def list_frame_people(
    frame_id: int,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    frame = accessible_frame(db, frame_id, user)
    try:
        client = immich_for_user(frame_owner(db, frame))
        return people_to_out(await client.list_people())
    except ImmichError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/frames/{frame_id}/people/{person_id}/thumbnail")
async def frame_person_thumbnail(
    frame_id: int,
    person_id: str,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    frame = accessible_frame(db, frame_id, user)
    try:
        client = immich_for_user(frame_owner(db, frame))
        content, content_type = await client.get_person_thumbnail(person_id)
        return Response(content=content, media_type=content_type)
    except ImmichError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/frames", response_model=list[FrameOut])
def list_frames(user: User = Depends(require_user), db: Session = Depends(get_db)):
    frames = (
        db.query(Frame)
        .filter(Frame.owner_user_id == user.id)
        .order_by(Frame.name.asc())
        .all()
    )
    return [frame_to_out(frame, db=db) for frame in frames]


@app.post("/api/frames", response_model=FrameOut)
def create_frame(
    payload: FrameCreate,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    data = payload.model_dump(exclude={"source", "overlay", "context", "slideshow"})
    frame = Frame(**data, token=secrets.token_urlsafe(24), owner_user_id=user.id)
    apply_source(frame, payload.source)
    apply_overlay(frame, payload.overlay)
    apply_context(frame, payload.context)
    apply_slideshow(frame, payload.slideshow)
    sync_seasonal_fields(frame)
    db.add(frame)
    db.commit()
    db.refresh(frame)
    return frame_to_out(frame, db=db)


@app.put("/api/frames/{frame_id}", response_model=FrameOut)
def update_frame(
    frame_id: int,
    payload: FrameUpdate,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    frame = accessible_frame(db, frame_id, user)
    apply_frame_update(frame, payload)
    db.commit()
    db.refresh(frame)
    return frame_to_out(frame, db=db)


@app.delete("/api/frames/{frame_id}", status_code=204)
def delete_frame(
    frame_id: int,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    frame = accessible_frame(db, frame_id, user)
    db.query(Device).filter(Device.frame_id == frame.id).update({"frame_id": None})
    db.delete(frame)
    db.commit()


@app.post("/api/setup/start", response_model=SetupStartOut)
def setup_start(payload: SetupStartIn, db: Session = Depends(get_db)):
    config = get_app_config(db)
    device = get_or_create_device(db, payload.device_key, payload.name)
    device.last_seen_at = datetime.utcnow()

    if device.frame_id:
        frame = db.get(Frame, device.frame_id)
        db.commit()
        return SetupStartOut(
            device_key=device.device_key,
            setup_code=device.setup_code or "",
            expires_in_seconds=0,
            bound=True,
            frame_token=frame.token if frame else None,
            default_immich_url=config.default_immich_url,
        )

    device = refresh_setup_code(db, device)
    return SetupStartOut(
        device_key=device.device_key,
        setup_code=device.setup_code or "",
        expires_in_seconds=SETUP_CODE_TTL_MINUTES * 60,
        bound=False,
        frame_token=None,
        default_immich_url=config.default_immich_url,
    )


@app.get("/api/setup/{setup_code}", response_model=SetupStatusOut)
def setup_status(setup_code: str, db: Session = Depends(get_db)):
    config = get_app_config(db)
    device = (
        db.query(Device)
        .filter(Device.setup_code == setup_code.strip().upper())
        .first()
    )
    if device is None:
        # Also allow lookup after bind via recently used codes is not supported;
        # if already bound, clients should poll device status instead.
        raise HTTPException(status_code=404, detail="Setup code not found")

    frame = db.get(Frame, device.frame_id) if device.frame_id else None
    expired = (
        device.setup_expires_at is not None
        and device.setup_expires_at < datetime.utcnow()
    )
    if expired and not device.frame_id:
        raise HTTPException(status_code=410, detail="Setup code expired")

    return SetupStatusOut(
        setup_code=setup_code.strip().upper(),
        bound=bool(frame),
        frame_token=frame.token if frame else None,
        default_immich_url=config.default_immich_url,
        device_name=device.name,
    )


@app.get("/api/devices/{device_key}", response_model=DeviceStatusOut)
def device_status(device_key: str, db: Session = Depends(get_db)):
    device = db.query(Device).filter(Device.device_key == device_key).first()
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")

    frame = db.get(Frame, device.frame_id) if device.frame_id else None
    device.last_seen_at = datetime.utcnow()
    db.commit()
    return DeviceStatusOut(
        device_key=device.device_key,
        bound=bool(frame),
        frame_token=frame.token if frame else None,
        frame=frame_to_out(frame) if frame else None,
    )


async def _complete_setup(
    db: Session,
    response: Response,
    *,
    setup_code: str,
    user: User,
    frame_name: str | None,
) -> SetupCompleteOut:
    device = get_device_by_setup_code(db, setup_code)
    cleaned = (frame_name or "").strip()
    # Ignore generic device placeholders so setup gets "<First>'s Frame".
    if cleaned.lower() in {"", "photo frame", "living room frame", "new frame"}:
        cleaned = default_frame_name_for_user(user)
    frame = create_frame_for_user(db, user, cleaned)
    bind_device_to_frame(db, device, frame)
    token = create_session(db, user)
    set_session_cookie(response, token)
    return SetupCompleteOut(
        frame_token=frame.token,
        frame=frame_to_out(frame),
        user=user_to_out(user),
    )


@app.post("/api/setup/complete/password", response_model=SetupCompleteOut)
async def setup_complete_password(
    payload: SetupCompletePasswordIn,
    response: Response,
    db: Session = Depends(get_db),
):
    config = get_app_config(db)
    immich_url = (payload.immich_url or config.default_immich_url).rstrip("/")
    if not immich_url:
        raise HTTPException(status_code=400, detail="Immich URL is required")

    user = await connect_with_password(
        db,
        immich_url=immich_url,
        email=payload.email,
        password=payload.password,
    )
    return await _complete_setup(
        db,
        response,
        setup_code=payload.setup_code,
        user=user,
        frame_name=payload.frame_name,
    )


@app.post("/api/setup/complete/api-key", response_model=SetupCompleteOut)
async def setup_complete_api_key(
    payload: SetupCompleteApiKeyIn,
    response: Response,
    db: Session = Depends(get_db),
):
    user = await connect_with_api_key(
        db,
        immich_url=payload.immich_url.rstrip("/"),
        immich_api_key=payload.immich_api_key,
    )
    return await _complete_setup(
        db,
        response,
        setup_code=payload.setup_code,
        user=user,
        frame_name=payload.frame_name,
    )


def get_frame_by_token(db: Session, token: str) -> Frame:
    frame = db.query(Frame).filter(Frame.token == token).first()
    if frame is None:
        raise HTTPException(status_code=404, detail="Frame not found")
    return frame


def require_kiosk_frame(
    db: Session = Depends(get_db),
    x_frame_token: Annotated[str | None, Header()] = None,
    frame_token: Annotated[str | None, Query()] = None,
) -> Frame:
    """
    Authorize kiosk access via X-Frame-Token header (preferred) or
    frame_token query param (for <img src> / media URLs).
    """
    token = (x_frame_token or frame_token or "").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing frame token")
    return get_frame_by_token(db, token)


async def build_kiosk_config(db: Session, frame: Frame) -> KioskConfig:
    # Waiting room: frame exists and is bound, but first settings save hasn't happened.
    if not bool(getattr(frame, "configured", True)):
        return KioskConfig(
            frame=frame_to_out(frame, db=db),
            assets=[],
            asset_count=0,
            truncated=False,
            weather=None,
        )

    owner = frame_owner(db, frame)
    source = source_from_frame(frame)
    try:
        client = immich_for_user(owner)
        assets, truncated = await assets_for_source(
            client,
            source,
            seasonal_strength=seasonal_strength_from_frame(frame),
            context=context_from_frame(frame),
        )
    except ImmichError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    from .assets import asset_to_out

    weather = await weather_for_frame(db, frame)

    return KioskConfig(
        frame=frame_to_out(frame, db=db),
        assets=[asset_to_out(asset) for asset in assets],
        asset_count=len(assets),
        truncated=truncated,
        weather=weather,
    )


def apply_frame_update(frame: Frame, payload: FrameUpdate) -> Frame:
    for key, value in payload.model_dump(
        exclude={"source", "overlay", "context", "slideshow"}
    ).items():
        setattr(frame, key, value)
    apply_source(frame, payload.source)
    apply_overlay(frame, payload.overlay)
    apply_context(frame, payload.context)
    apply_slideshow(frame, payload.slideshow)
    sync_seasonal_fields(frame)
    frame.configured = True
    return frame


@app.get("/api/kiosk", response_model=KioskConfig)
async def kiosk_config(frame: Frame = Depends(require_kiosk_frame), db: Session = Depends(get_db)):
    return await build_kiosk_config(db, frame)


@app.put("/api/kiosk", response_model=FrameOut)
def kiosk_update_frame(
    payload: FrameUpdate,
    frame: Frame = Depends(require_kiosk_frame),
    db: Session = Depends(get_db),
):
    """On-device settings: authorized by possession of the frame token."""
    apply_frame_update(frame, payload)
    db.commit()
    db.refresh(frame)
    return frame_to_out(frame)


@app.get("/api/kiosk/albums", response_model=list[AlbumOut])
async def kiosk_albums(frame: Frame = Depends(require_kiosk_frame), db: Session = Depends(get_db)):
    owner = frame_owner(db, frame)
    try:
        client = immich_for_user(owner)
        albums = await client.list_albums()
        return [
            AlbumOut(
                id=album["id"],
                albumName=album.get("albumName", "Unnamed album"),
                assetCount=album.get("assetCount", 0),
            )
            for album in albums
        ]
    except ImmichError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/kiosk/people", response_model=list[PersonOut])
async def kiosk_people(frame: Frame = Depends(require_kiosk_frame), db: Session = Depends(get_db)):
    owner = frame_owner(db, frame)
    try:
        client = immich_for_user(owner)
        return people_to_out(await client.list_people())
    except ImmichError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/kiosk/people/{person_id}/thumbnail")
async def kiosk_person_thumbnail(
    person_id: str,
    frame: Frame = Depends(require_kiosk_frame),
    db: Session = Depends(get_db),
):
    owner = frame_owner(db, frame)
    try:
        client = immich_for_user(owner)
        content, content_type = await client.get_person_thumbnail(person_id)
        return Response(content=content, media_type=content_type)
    except ImmichError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/kiosk/asset/{asset_id}")
async def kiosk_asset(
    asset_id: str,
    frame: Frame = Depends(require_kiosk_frame),
    db: Session = Depends(get_db),
):
    owner = frame_owner(db, frame)
    try:
        client = immich_for_user(owner)
        content, media_type = await client.get_thumbnail(asset_id)
        return Response(
            content=content,
            media_type=media_type,
            headers={"Cache-Control": "public, max-age=86400"},
        )
    except ImmichError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def require_kiosk_photo_actions(frame: Frame = Depends(require_kiosk_frame)) -> Frame:
    if not bool(getattr(frame, "allow_photo_actions", False)):
        raise HTTPException(
            status_code=403,
            detail="Photo actions are disabled for this frame",
        )
    return frame


@app.post("/api/kiosk/assets/{asset_id}/archive")
async def kiosk_archive_asset(
    asset_id: str,
    frame: Frame = Depends(require_kiosk_photo_actions),
    db: Session = Depends(get_db),
):
    owner = frame_owner(db, frame)
    try:
        client = immich_for_user(owner)
        await client.archive_asset(asset_id)
        return {"ok": True, "asset_id": asset_id, "action": "archive"}
    except ImmichError as exc:
        status = 403 if exc.status_code in {401, 403} else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc


@app.post("/api/kiosk/assets/{asset_id}/rotate")
async def kiosk_rotate_asset(
    asset_id: str,
    payload: AssetRotateRequest,
    frame: Frame = Depends(require_kiosk_photo_actions),
    db: Session = Depends(get_db),
):
    owner = frame_owner(db, frame)
    try:
        client = immich_for_user(owner)
        result = await client.rotate_asset(asset_id, payload.degrees)
        return {
            "ok": True,
            "asset_id": asset_id,
            "action": "rotate",
            "degrees": payload.degrees,
            "angle": result.get("angle"),
        }
    except ImmichError as exc:
        status = 403 if exc.status_code in {401, 403} else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc


# Legacy path-token routes (still accepted; prefer header / query auth above).
@app.get("/api/kiosk/{token}", response_model=KioskConfig)
async def kiosk_config_legacy(token: str, db: Session = Depends(get_db)):
    return await build_kiosk_config(db, get_frame_by_token(db, token))


@app.put("/api/kiosk/{token}", response_model=FrameOut)
def kiosk_update_frame_legacy(
    token: str,
    payload: FrameUpdate,
    db: Session = Depends(get_db),
):
    frame = get_frame_by_token(db, token)
    apply_frame_update(frame, payload)
    db.commit()
    db.refresh(frame)
    return frame_to_out(frame)


async def weather_for_frame(db: Session, frame: Frame) -> WeatherOut | None:
    if not frame.show_weather or not frame.weather_location:
        return None

    config = get_app_config(db)
    key = weather_api_key(config)
    if not key:
        return None

    try:
        client = OpenWeatherClient(key, units=config.weather_units or "imperial")
        snapshot = await client.get_weather(frame.weather_location)
        return WeatherOut(
            location_label=snapshot.location_label,
            temperature=snapshot.temperature,
            units=snapshot.units,
            description=snapshot.description,
            icon=snapshot.icon,
            fetched_at=snapshot.fetched_at,
        )
    except WeatherError as exc:
        # Don't break the slideshow if weather is unavailable.
        import logging

        logging.getLogger(__name__).warning(
            "Weather lookup failed for %r: %s",
            frame.weather_location,
            exc,
        )
        return None


def people_to_out(people: list[dict]) -> list[PersonOut]:
    out: list[PersonOut] = []
    for person in people:
        person_id = person.get("id")
        if not isinstance(person_id, str) or not person_id:
            continue
        name = person.get("name")
        out.append(
            PersonOut(
                id=person_id,
                name=name.strip() if isinstance(name, str) and name.strip() else "Unnamed",
                is_hidden=bool(person.get("isHidden")),
                thumbnail_path=person.get("thumbnailPath"),
            )
        )
    out.sort(key=lambda item: (item.name.lower(), item.id))
    return out


@app.get("/api/people", response_model=list[PersonOut])
async def list_people(user: User = Depends(require_user)):
    try:
        client = immich_for_user(user)
        return people_to_out(await client.list_people())
    except ImmichError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/people/{person_id}/thumbnail")
async def person_thumbnail(person_id: str, user: User = Depends(require_user)):
    try:
        client = immich_for_user(user)
        content, content_type = await client.get_person_thumbnail(person_id)
        return Response(content=content, media_type=content_type)
    except ImmichError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/kiosk/{token}/albums", response_model=list[AlbumOut])
async def kiosk_albums_legacy(token: str, db: Session = Depends(get_db)):
    return await kiosk_albums(get_frame_by_token(db, token), db)


@app.get("/api/kiosk/{token}/people", response_model=list[PersonOut])
async def kiosk_people_legacy(token: str, db: Session = Depends(get_db)):
    return await kiosk_people(get_frame_by_token(db, token), db)


@app.get("/api/kiosk/{token}/people/{person_id}/thumbnail")
async def kiosk_person_thumbnail_legacy(
    token: str,
    person_id: str,
    db: Session = Depends(get_db),
):
    return await kiosk_person_thumbnail(person_id, get_frame_by_token(db, token), db)


@app.get("/api/kiosk/{token}/asset/{asset_id}")
async def kiosk_asset_legacy(token: str, asset_id: str, db: Session = Depends(get_db)):
    return await kiosk_asset(asset_id, get_frame_by_token(db, token), db)


@app.post("/api/kiosk/{token}/assets/{asset_id}/archive")
async def kiosk_archive_asset_legacy(
    token: str,
    asset_id: str,
    db: Session = Depends(get_db),
):
    frame = get_frame_by_token(db, token)
    if not bool(getattr(frame, "allow_photo_actions", False)):
        raise HTTPException(
            status_code=403,
            detail="Photo actions are disabled for this frame",
        )
    return await kiosk_archive_asset(asset_id, frame, db)


@app.post("/api/kiosk/{token}/assets/{asset_id}/rotate")
async def kiosk_rotate_asset_legacy(
    token: str,
    asset_id: str,
    payload: AssetRotateRequest,
    db: Session = Depends(get_db),
):
    frame = get_frame_by_token(db, token)
    if not bool(getattr(frame, "allow_photo_actions", False)):
        raise HTTPException(
            status_code=403,
            detail="Photo actions are disabled for this frame",
        )
    return await kiosk_rotate_asset(asset_id, payload, frame, db)
