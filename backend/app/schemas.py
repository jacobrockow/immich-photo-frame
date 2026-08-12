from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ImmichSettingsIn(BaseModel):
    # immich_url is retained for backward-compatible clients but ignored by the
    # server. The admin-owned AppConfig URL is the single source of truth.
    immich_url: str = ""
    immich_api_key: str


class ImmichSettingsOut(BaseModel):
    immich_url: str
    api_key_configured: bool
    default_immich_url: str = ""
    immich_server_name: str = "Immich"


class AlbumOut(BaseModel):
    id: str
    albumName: str
    assetCount: int = 0


class LibrarySource(BaseModel):
    type: Literal["library"] = "library"


class AlbumSource(BaseModel):
    type: Literal["album"] = "album"
    album_id: str = Field(min_length=1)


PhotoSource = Annotated[LibrarySource | AlbumSource, Field(discriminator="type")]

Corner = Literal["top-left", "top-right", "bottom-left", "bottom-right"]
# "quarter" ≈ up to ~1/4 of the viewport for that element.
OverlayScale = Literal[
    "xsmall",
    "small",
    "medium",
    "large",
    "xlarge",
    "huge",
    "quarter",
]
OverlayFont = Literal[
    "sans",
    "serif",
    "rounded",
    "mono",
    "display",
    "script",
    "slab",
    "pixel",
    "hand",
    "condensed",
    "segment",
]
OverlayTextColor = Literal["white", "warm", "amber", "mint", "soft"]
OverlayContrast = Literal["none", "soft", "heavy", "pill", "bar"]
ClockFormat = Literal["12h", "24h"]
ClockDateFormat = Literal["long", "short", "weekday", "none"]
PhotoDateFormat = Literal["long", "short", "numeric"]


class OverlaySettings(BaseModel):
    """Kiosk chrome layout/typography. Defaults match the classic Conky frame."""

    clock_corner: Corner = "top-right"
    photo_meta_corner: Corner = "bottom-left"
    weather_corner: Corner = "bottom-right"
    clock_format: ClockFormat = "12h"
    clock_show_seconds: bool = False
    clock_date_format: ClockDateFormat = "long"
    photo_date_format: PhotoDateFormat = "long"
    clock_scale: OverlayScale = "medium"
    photo_meta_scale: OverlayScale = "medium"
    weather_scale: OverlayScale = "medium"
    font: OverlayFont = "sans"
    text_color: OverlayTextColor = "white"
    contrast: OverlayContrast = "soft"
    # 40–100 percent text/icon opacity.
    opacity: int = Field(default=100, ge=40, le=100)
    # 0–100 percent pill/bar background opacity.
    scrim_opacity: int = Field(default=50, ge=0, le=100)

    @model_validator(mode="before")
    @classmethod
    def migrate_legacy_scale(cls, data: Any) -> Any:
        """Older frames stored a single `scale`; copy it onto per-element sizes."""
        if not isinstance(data, dict):
            return data
        legacy = data.get("scale")
        if legacy:
            for key in ("clock_scale", "photo_meta_scale", "weather_scale"):
                data.setdefault(key, legacy)
            data.pop("scale", None)
        return data


class PersonRef(BaseModel):
    """Stable Immich person reference stored on a frame."""

    id: str = Field(min_length=1, max_length=64)
    name: str = Field(default="", max_length=255)


class ContextFilters(BaseModel):
    """People (and later tags) include/exclude / soft-prefer rules."""

    exclude_people: list[PersonRef] = Field(default_factory=list)
    prefer_people: list[PersonRef] = Field(default_factory=list)
    prefer_strength: int = Field(default=3, ge=0, le=5)


class PersonOut(BaseModel):
    id: str
    name: str
    is_hidden: bool = False
    thumbnail_path: str | None = None


TransitionStyle = Literal["none", "fade", "crossfade"]
TransitionSpeed = Literal["fast", "medium", "slow"]
PanStyle = Literal["off", "subtle", "medium"]
BackdropStyle = Literal["black", "blur", "glow"]


class SlideshowSettings(BaseModel):
    """Visual presentation for the kiosk slideshow."""

    transition: TransitionStyle = "fade"
    transition_speed: TransitionSpeed = "medium"
    pan: PanStyle = "subtle"
    backdrop: BackdropStyle = "blur"


class FrameCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    source: PhotoSource = Field(default_factory=LibrarySource)
    interval_seconds: int = Field(default=15, ge=3, le=3600)
    image_fit: str = Field(default="contain", pattern="^(contain|cover)$")
    show_clock: bool = True
    show_photo_date: bool = True
    show_photo_location: bool = True
    show_weather: bool = False
    weather_location: str | None = None
    allow_photo_actions: bool = False
    seasonal_strength: int = Field(default=3, ge=0, le=5)
    overlay: OverlaySettings = Field(default_factory=OverlaySettings)
    context: ContextFilters = Field(default_factory=ContextFilters)
    slideshow: SlideshowSettings = Field(default_factory=SlideshowSettings)


class FrameUpdate(FrameCreate):
    pass


class FrameOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    token: str
    name: str
    source: PhotoSource
    interval_seconds: int
    image_fit: str
    show_clock: bool
    show_photo_date: bool
    show_photo_location: bool = True
    show_weather: bool
    weather_location: str | None = None
    allow_photo_actions: bool = False
    seasonal_strength: int = 3
    overlay: OverlaySettings = Field(default_factory=OverlaySettings)
    context: ContextFilters = Field(default_factory=ContextFilters)
    slideshow: SlideshowSettings = Field(default_factory=SlideshowSettings)
    configured: bool = False
    owner_user_id: int | None = None
    owner_email: str | None = None
    owner_name: str | None = None


class AssetRotateRequest(BaseModel):
    degrees: Literal[90, -90]


class AssetOut(BaseModel):
    id: str
    type: str | None = None
    fileCreatedAt: str | None = None
    localDateTime: str | None = None
    originalFileName: str | None = None
    location: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None


class WeatherOut(BaseModel):
    location_label: str
    temperature: float
    units: str
    description: str
    icon: str | None = None
    fetched_at: str | None = None


class WeatherSettingsIn(BaseModel):
    weather_api_key: str = ""
    weather_units: str = Field(default="imperial", pattern="^(imperial|metric)$")


class WeatherSettingsOut(BaseModel):
    api_key_configured: bool
    weather_units: str = "imperial"


class ServerSettingsOut(BaseModel):
    """Server-wide admin settings (not per-frame / per-user)."""

    default_immich_url: str = ""
    immich_server_name: str = "Immich"
    weather_api_key_configured: bool = False
    weather_units: str = "imperial"


class ServerSettingsIn(BaseModel):
    default_immich_url: str | None = None
    immich_server_name: str | None = Field(default=None, max_length=255)
    weather_api_key: str = ""
    weather_units: str | None = Field(
        default=None,
        pattern="^(imperial|metric)$",
    )


class KioskConfig(BaseModel):
    frame: FrameOut
    assets: list[AssetOut]
    asset_count: int = 0
    truncated: bool = False
    weather: WeatherOut | None = None


class UserOut(BaseModel):
    id: int
    email: str
    name: str
    # Compatibility field; always mirrors the server-wide admin setting.
    immich_url: str
    api_key_configured: bool
    is_admin: bool = False


class AdminUserOut(BaseModel):
    id: int
    email: str
    name: str
    # Compatibility field; always mirrors the server-wide admin setting.
    immich_url: str
    api_key_configured: bool
    is_admin: bool = False
    frame_count: int = 0
    created_at: str | None = None


class AdminUserUpdate(BaseModel):
    is_admin: bool | None = None


class LoginPasswordIn(BaseModel):
    # Retained for old clients; ignored by the backend.
    immich_url: str | None = None
    email: str = Field(min_length=1)
    password: str = Field(min_length=1)


class LoginApiKeyIn(BaseModel):
    # Retained for old clients; ignored by the backend.
    immich_url: str = ""
    immich_api_key: str = Field(min_length=1)
    email: str | None = None


class SetupStartIn(BaseModel):
    device_key: str = Field(min_length=8, max_length=128)
    name: str = Field(default="Photo Frame", max_length=255)


class SetupStartOut(BaseModel):
    device_key: str
    setup_code: str
    expires_in_seconds: int
    bound: bool
    frame_token: str | None = None
    default_immich_url: str = ""
    immich_server_name: str = "Immich"


class SetupStatusOut(BaseModel):
    setup_code: str
    bound: bool
    frame_token: str | None = None
    default_immich_url: str = ""
    immich_server_name: str = "Immich"
    device_name: str = "Photo Frame"


class SetupCompletePasswordIn(BaseModel):
    setup_code: str = Field(min_length=4, max_length=16)
    # Retained for old clients; ignored by the backend.
    immich_url: str | None = None
    email: str = Field(min_length=1)
    password: str = Field(min_length=1)
    frame_name: str | None = None


class SetupCompleteApiKeyIn(BaseModel):
    setup_code: str = Field(min_length=4, max_length=16)
    # Retained for old clients; ignored by the backend.
    immich_url: str = ""
    immich_api_key: str = Field(min_length=1)
    frame_name: str | None = None


class SetupCompleteOut(BaseModel):
    frame_token: str
    frame: FrameOut
    user: UserOut


class DeviceStatusOut(BaseModel):
    device_key: str
    bound: bool
    frame_token: str | None = None
    frame: FrameOut | None = None
