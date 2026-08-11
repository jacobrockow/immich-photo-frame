"""Normalize Immich asset payloads for kiosk clients."""

from __future__ import annotations

from typing import Any

from .schemas import AssetOut


def asset_to_out(asset: dict[str, Any]) -> AssetOut:
    return AssetOut(
        id=str(asset.get("id", "")),
        type=asset.get("type"),
        fileCreatedAt=_as_str(asset.get("fileCreatedAt")),
        localDateTime=_as_str(asset.get("localDateTime")),
        originalFileName=_as_str(asset.get("originalFileName")),
        location=format_location(asset),
        city=_exif_str(asset, "city"),
        state=_exif_str(asset, "state"),
        country=_exif_str(asset, "country"),
    )


def format_location(asset: dict[str, Any]) -> str | None:
    """
    Build a human-readable place string from Immich reverse-geocode fields.

    Prefer "City, State" / "City, Country" and fall back sensibly when parts
    are missing.
    """
    city = _exif_str(asset, "city")
    state = _exif_str(asset, "state")
    country = _exif_str(asset, "country")

    parts: list[str] = []
    if city:
        parts.append(city)
    if state and state not in parts:
        parts.append(state)
    elif country and country not in parts and not city:
        parts.append(country)
    elif country and country not in parts and city and not state:
        parts.append(country)

    if not parts and country:
        parts.append(country)

    if not parts:
        return None
    return ", ".join(parts)


def _exif_str(asset: dict[str, Any], key: str) -> str | None:
    exif = asset.get("exifInfo")
    if isinstance(exif, dict):
        value = exif.get(key)
        if isinstance(value, str):
            cleaned = value.strip()
            if cleaned:
                return cleaned
    # Some payloads may flatten these fields.
    value = asset.get(key)
    if isinstance(value, str):
        cleaned = value.strip()
        if cleaned:
            return cleaned
    return None


def _as_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
