"""Server-side helpers for building a weighted kiosk asset queue."""

from __future__ import annotations

import os
import random
from datetime import date, datetime
from typing import Any, Iterable


# Base weight for photos outside the seasonal window.
BASE_WEIGHT = float(os.getenv("SEASONAL_BASE_WEIGHT", "1.0"))
# Exact month/day anniversary (any prior year) — at strength 3 (Balanced).
WEIGHT_EXACT = float(os.getenv("SEASONAL_WEIGHT_EXACT", "12.0"))
# Within ±7 calendar days of today's month/day.
WEIGHT_WEEK = float(os.getenv("SEASONAL_WEIGHT_WEEK", "6.0"))
# Within ±14 days.
WEIGHT_FORTNIGHT = float(os.getenv("SEASONAL_WEIGHT_FORTNIGHT", "3.0"))
# Within ±30 days.
WEIGHT_MONTH = float(os.getenv("SEASONAL_WEIGHT_MONTH", "1.75"))

# How strongly bucket boosts are applied at each UI strength (0 = off).
# Strength 3 matches the historical default weights (factor 1.0).
STRENGTH_FACTOR = {
    0: 0.0,
    1: 0.3,
    2: 0.6,
    3: 1.0,
    4: 1.8,
    5: 3.2,
}

# Multiplier applied when an asset contains any preferred person (OR).
PEOPLE_PREFER_FACTOR = {
    0: 1.0,
    1: 1.5,
    2: 2.5,
    3: 4.0,
    4: 7.0,
    5: 12.0,
}


def dedupe_assets(assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for asset in assets:
        asset_id = asset.get("id")
        if not isinstance(asset_id, str) or asset_id in seen:
            continue
        seen.add(asset_id)
        unique.append(asset)
    return unique


def shuffle_assets(assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Uniform shuffle (used when seasonal weighting is disabled)."""
    playlist = list(assets)
    random.shuffle(playlist)
    return playlist


def clamp_strength(strength: int | bool | None) -> int:
    """Normalize API/DB values to 0–5. Legacy booleans map to 0 / 3."""
    if strength is None:
        return 3
    if isinstance(strength, bool):
        return 3 if strength else 0
    try:
        value = int(strength)
    except (TypeError, ValueError):
        return 3
    return max(0, min(5, value))


def build_playlist(
    assets: list[dict[str, Any]],
    *,
    seasonal: bool | None = None,
    seasonal_strength: int | bool | None = None,
    prefer_person_ids: Iterable[str] | None = None,
    prefer_strength: int | bool | None = 3,
    today: date | None = None,
) -> list[dict[str, Any]]:
    """
    Build an ordered slideshow queue.

    seasonal_strength 0 = uniform (unless people prefer is on). 1–5 increasingly
    favor photos near today's month/day. prefer_person_ids soft-boosts assets
    that contain any of those people (OR).
    """
    from .people import asset_has_any_person

    unique = dedupe_assets(assets)
    if not unique:
        return []

    if seasonal_strength is None and seasonal is not None:
        strength = 3 if seasonal else 0
    else:
        strength = clamp_strength(seasonal_strength)

    prefer_ids = {pid for pid in (prefer_person_ids or []) if pid}
    people_strength = clamp_strength(prefer_strength) if prefer_ids else 0
    use_weights = strength > 0 or people_strength > 0

    if not use_weights or len(unique) == 1:
        return shuffle_assets(unique)
    return weighted_shuffle(
        unique,
        today=today or date.today(),
        strength=strength,
        prefer_person_ids=prefer_ids,
        prefer_strength=people_strength,
        has_preferred=asset_has_any_person,
    )


def weighted_shuffle(
    assets: list[dict[str, Any]],
    *,
    today: date,
    strength: int = 3,
    prefer_person_ids: set[str] | None = None,
    prefer_strength: int = 0,
    has_preferred=None,
) -> list[dict[str, Any]]:
    """
    Efraimidis–Spirakis weighted random shuffle.

    Higher weight => likelier to appear earlier in the playlist.
    """
    strength = clamp_strength(strength)
    prefer_strength = clamp_strength(prefer_strength)
    prefer_ids = prefer_person_ids or set()
    people_factor = PEOPLE_PREFER_FACTOR.get(prefer_strength, 1.0)

    keyed: list[tuple[float, dict[str, Any]]] = []
    for asset in assets:
        weight = max(seasonal_weight(asset, today=today, strength=strength), 1e-6)
        if (
            prefer_ids
            and prefer_strength > 0
            and has_preferred is not None
            and has_preferred(asset, prefer_ids)
        ):
            weight *= people_factor
        # random() ** (1/weight); higher weight => larger key on average
        key = random.random() ** (1.0 / weight)
        keyed.append((key, asset))
    keyed.sort(key=lambda item: item[0], reverse=True)
    return [asset for _, asset in keyed]


def seasonal_weight(
    asset: dict[str, Any],
    *,
    today: date,
    strength: int = 3,
) -> float:
    strength = clamp_strength(strength)
    if strength <= 0:
        return BASE_WEIGHT

    taken = asset_date(asset)
    if taken is None:
        return BASE_WEIGHT

    distance = calendar_day_distance(taken, today)
    if distance == 0:
        bucket = WEIGHT_EXACT
    elif distance <= 7:
        bucket = WEIGHT_WEEK
    elif distance <= 14:
        bucket = WEIGHT_FORTNIGHT
    elif distance <= 30:
        bucket = WEIGHT_MONTH
    else:
        return BASE_WEIGHT

    factor = STRENGTH_FACTOR.get(strength, 1.0)
    return BASE_WEIGHT + (bucket - BASE_WEIGHT) * factor


def calendar_day_distance(photo: date, today: date) -> int:
    """
    Minimum day distance between photo month/day and today's month/day,
    ignoring year (anniversary-style), wrapping across year boundaries.
    """
    candidates = [
        _safe_date(today.year, photo.month, photo.day),
        _safe_date(today.year - 1, photo.month, photo.day),
        _safe_date(today.year + 1, photo.month, photo.day),
    ]
    return min(abs((candidate - today).days) for candidate in candidates)


def asset_date(asset: dict[str, Any]) -> date | None:
    for key in ("localDateTime", "fileCreatedAt", "exifInfoLocalDateTime"):
        value = asset.get(key)
        if isinstance(value, str) and value:
            parsed = _parse_datetime(value)
            if parsed is not None:
                return parsed
    exif = asset.get("exifInfo")
    if isinstance(exif, dict):
        for key in ("dateTimeOriginal", "localDateTime"):
            value = exif.get(key)
            if isinstance(value, str) and value:
                parsed = _parse_datetime(value)
                if parsed is not None:
                    return parsed
    return None


def _parse_datetime(value: str) -> date | None:
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text).date()
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d", "%Y:%m:%d %H:%M:%S"):
        try:
            return datetime.strptime(text[:19], fmt).date()
        except ValueError:
            continue
    return None


def _safe_date(year: int, month: int, day: int) -> date:
    """Clamp invalid days (e.g. Feb 29 in non-leap years) rather than failing."""
    while day >= 28:
        try:
            return date(year, month, day)
        except ValueError:
            day -= 1
    return date(year, month, day)


def seasonal_stats(
    assets: list[dict[str, Any]],
    *,
    today: date | None = None,
) -> dict[str, Any]:
    """Small diagnostic summary (useful for tests / future admin UI)."""
    today = today or date.today()
    buckets = {"exact": 0, "week": 0, "fortnight": 0, "month": 0, "other": 0, "undated": 0}
    for asset in assets:
        taken = asset_date(asset)
        if taken is None:
            buckets["undated"] += 1
            continue
        distance = calendar_day_distance(taken, today)
        if distance == 0:
            buckets["exact"] += 1
        elif distance <= 7:
            buckets["week"] += 1
        elif distance <= 14:
            buckets["fortnight"] += 1
        elif distance <= 30:
            buckets["month"] += 1
        else:
            buckets["other"] += 1
    return buckets
