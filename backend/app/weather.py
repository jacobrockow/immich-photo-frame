"""OpenWeatherMap client with simple in-memory caching."""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class WeatherError(RuntimeError):
    pass


@dataclass(frozen=True)
class WeatherSnapshot:
    location_label: str
    temperature: float
    units: str
    description: str
    icon: str | None
    fetched_at: str


_cache: dict[str, tuple[float, WeatherSnapshot]] = {}
_icon_cache: dict[str, tuple[float, bytes, str]] = {}
CACHE_TTL_SECONDS = 20 * 60
ICON_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60
ICON_CODE_RE = re.compile(r"^[0-9]{2}[dn]$")
OWM_ICON_URL = "https://openweathermap.org/img/wn/{code}@2x.png"

# OpenWeather geocoding is picky about "City, ST" with spaces; prefer City,ST,US.
_US_STATE_ABBR = {
    "AL": "Alabama",
    "AK": "Alaska",
    "AZ": "Arizona",
    "AR": "Arkansas",
    "CA": "California",
    "CO": "Colorado",
    "CT": "Connecticut",
    "DE": "Delaware",
    "FL": "Florida",
    "GA": "Georgia",
    "HI": "Hawaii",
    "ID": "Idaho",
    "IL": "Illinois",
    "IN": "Indiana",
    "IA": "Iowa",
    "KS": "Kansas",
    "KY": "Kentucky",
    "LA": "Louisiana",
    "ME": "Maine",
    "MD": "Maryland",
    "MA": "Massachusetts",
    "MI": "Michigan",
    "MN": "Minnesota",
    "MS": "Mississippi",
    "MO": "Missouri",
    "MT": "Montana",
    "NE": "Nebraska",
    "NV": "Nevada",
    "NH": "New Hampshire",
    "NJ": "New Jersey",
    "NM": "New Mexico",
    "NY": "New York",
    "NC": "North Carolina",
    "ND": "North Dakota",
    "OH": "Ohio",
    "OK": "Oklahoma",
    "OR": "Oregon",
    "PA": "Pennsylvania",
    "RI": "Rhode Island",
    "SC": "South Carolina",
    "SD": "South Dakota",
    "TN": "Tennessee",
    "TX": "Texas",
    "UT": "Utah",
    "VT": "Vermont",
    "VA": "Virginia",
    "WA": "Washington",
    "WV": "West Virginia",
    "WI": "Wisconsin",
    "WY": "Wyoming",
    "DC": "District of Columbia",
}


class OpenWeatherClient:
    def __init__(self, api_key: str, *, units: str = "imperial"):
        self.api_key = api_key.strip()
        self.units = units if units in {"imperial", "metric"} else "imperial"
        if not self.api_key:
            raise WeatherError("Weather API key is not configured")

    async def get_weather(self, location_query: str) -> WeatherSnapshot:
        query = location_query.strip()
        if not query:
            raise WeatherError("Weather location is empty")

        cache_key = f"{self.units}:{query.lower()}"
        cached = _cache.get(cache_key)
        now = time.time()
        if cached and now - cached[0] < CACHE_TTL_SECONDS:
            return cached[1]

        place = await self._resolve_place(query)
        weather = await self._current(place["lat"], place["lon"])
        label = place.get("label") or query
        unit_symbol = "F" if self.units == "imperial" else "C"
        snapshot = WeatherSnapshot(
            location_label=label,
            temperature=round(float(weather["main"]["temp"])),
            units=unit_symbol,
            description=str(weather["weather"][0]["description"]).title(),
            icon=_as_str(weather["weather"][0].get("icon")),
            fetched_at=datetime.now(timezone.utc).isoformat(),
        )
        _cache[cache_key] = (now, snapshot)
        return snapshot

    async def ping(self) -> bool:
        # Lightweight authenticated check via geocoding a known place.
        await self._geocode("London")
        return True

    async def _resolve_place(self, query: str) -> dict[str, Any]:
        candidates = location_query_candidates(query)
        last_error: Exception | None = None

        for candidate in candidates:
            try:
                return await self._geocode(candidate)
            except WeatherError as exc:
                last_error = exc

        # Fallback: current-weather city query is often more forgiving.
        for candidate in candidates:
            try:
                return await self._place_from_weather_query(candidate)
            except WeatherError as exc:
                last_error = exc

        raise WeatherError(
            str(last_error)
            if last_error
            else f"Could not find weather location “{query}”"
        )

    async def _geocode(self, query: str) -> dict[str, Any]:
        data = await self._request(
            "https://api.openweathermap.org/geo/1.0/direct",
            params={"q": query, "limit": 1, "appid": self.api_key},
        )
        if not isinstance(data, list) or not data:
            raise WeatherError(f"Could not find weather location “{query}”")

        place = data[0]
        return {
            "lat": place["lat"],
            "lon": place["lon"],
            "label": _format_place_label(place, fallback=query),
        }

    async def _place_from_weather_query(self, query: str) -> dict[str, Any]:
        data = await self._request(
            "https://api.openweathermap.org/data/2.5/weather",
            params={
                "q": query,
                "units": self.units,
                "appid": self.api_key,
            },
        )
        if not isinstance(data, dict) or "coord" not in data:
            raise WeatherError(f"Could not find weather location “{query}”")

        coord = data["coord"]
        name = data.get("name") or query
        country = (data.get("sys") or {}).get("country")
        parts = [str(name)]
        if country:
            parts.append(str(country))
        return {
            "lat": coord["lat"],
            "lon": coord["lon"],
            "label": ", ".join(parts),
        }

    async def _current(self, lat: float, lon: float) -> dict[str, Any]:
        data = await self._request(
            "https://api.openweathermap.org/data/2.5/weather",
            params={
                "lat": lat,
                "lon": lon,
                "units": self.units,
                "appid": self.api_key,
            },
        )
        if not isinstance(data, dict) or "main" not in data or "weather" not in data:
            raise WeatherError("Unexpected OpenWeather response")
        if not data["weather"]:
            raise WeatherError("OpenWeather returned no conditions")
        return data

    async def _request(self, url: str, *, params: dict[str, Any]) -> Any:
        timeout = httpx.Timeout(15.0, connect=8.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.get(url, params=params)

        if response.is_error:
            body = response.text[:300]
            raise WeatherError(
                f"OpenWeather returned HTTP {response.status_code}: {body}"
            )
        return response.json()


def location_query_candidates(query: str) -> list[str]:
    """
    Build geocode candidates for common US inputs like "Durham, NC".

    OpenWeather's /geo/1.0/direct often fails on "City, ST" with a space, but
    accepts "City,ST,US".
    """
    cleaned = re.sub(r"\s+", " ", query.strip())
    candidates = [cleaned]

    match = re.fullmatch(
        r"(?P<city>.+),\s*(?P<region>[A-Za-z]{2}|[A-Za-z][A-Za-z .'-]+?)(?:,\s*(?P<country>[A-Za-z]{2,}))?",
        cleaned,
    )
    if match:
        city = match.group("city").strip()
        region = match.group("region").strip()
        country = (match.group("country") or "").strip().upper()
        region_upper = region.upper()

        if len(region) == 2 and region_upper in _US_STATE_ABBR:
            candidates.extend(
                [
                    f"{city},{region_upper},US",
                    f"{city},{_US_STATE_ABBR[region_upper]},US",
                    f"{city},{region_upper}",
                ]
            )
        elif not country:
            candidates.append(f"{city},{region},US")
        else:
            candidates.append(f"{city},{region},{country}")

    # Preserve order, drop duplicates.
    unique: list[str] = []
    seen: set[str] = set()
    for item in candidates:
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique


def _format_place_label(place: dict[str, Any], *, fallback: str) -> str:
    name = place.get("name") or fallback
    state = place.get("state")
    country = place.get("country")
    parts = [str(name)]
    if state:
        parts.append(str(state))
    if country:
        parts.append(str(country))
    return ", ".join(parts)


def _as_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def normalize_icon_code(icon: str) -> str:
    code = (icon or "").strip().lower()
    # Allow callers to pass "01d@2x" / "01d.png" — keep the OpenWeather code only.
    code = code.split("@", 1)[0]
    code = code.split(".", 1)[0]
    if not ICON_CODE_RE.fullmatch(code):
        raise WeatherError(f"Invalid weather icon code “{icon}”")
    return code


async def fetch_weather_icon(icon: str) -> tuple[bytes, str]:
    """
    Fetch an OpenWeather icon PNG via the server (Pi/kiosk browsers often cannot
    reach openweathermap.org, and the CDN may 403 bare clients).
    """
    code = normalize_icon_code(icon)
    cached = _icon_cache.get(code)
    now = time.time()
    if cached and now - cached[0] < ICON_CACHE_TTL_SECONDS:
        return cached[1], cached[2]

    url = OWM_ICON_URL.format(code=code)
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                url,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (compatible; ImmichPhotoFrame/1.0; "
                        "+https://github.com/)"
                    ),
                    "Accept": "image/png,image/*;q=0.8,*/*;q=0.5",
                },
            )
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise WeatherError(f"Weather icon fetch failed: {exc}") from exc

    content_type = response.headers.get("content-type", "image/png").split(";")[0]
    if "image" not in content_type:
        content_type = "image/png"
    body = response.content
    if not body:
        raise WeatherError("Weather icon response was empty")

    _icon_cache[code] = (now, body, content_type)
    return body, content_type


def clear_weather_cache() -> None:
    _cache.clear()
    _icon_cache.clear()
