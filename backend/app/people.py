"""Helpers for Immich person IDs on assets and context filters."""

from __future__ import annotations

from typing import Any, Iterable


def asset_person_ids(asset: dict[str, Any]) -> set[str]:
    """
    Collect person UUIDs attached to an Immich asset payload.

    Immich may place people under `people`, `people[].id`, or nested under
    `faces[].person.id` depending on version / withPeople flags.
    """
    found: set[str] = set()

    people = asset.get("people")
    if isinstance(people, list):
        for person in people:
            person_id = _person_id(person)
            if person_id:
                found.add(person_id)

    faces = asset.get("faces")
    if isinstance(faces, list):
        for face in faces:
            if not isinstance(face, dict):
                continue
            person = face.get("person")
            person_id = _person_id(person) or _as_id(face.get("personId"))
            if person_id:
                found.add(person_id)

    return found


def asset_has_any_person(asset: dict[str, Any], person_ids: Iterable[str]) -> bool:
    wanted = {pid for pid in person_ids if pid}
    if not wanted:
        return False
    return bool(asset_person_ids(asset) & wanted)


def exclude_people(
    assets: list[dict[str, Any]],
    exclude_ids: Iterable[str],
) -> list[dict[str, Any]]:
    """Drop assets that include any excluded person."""
    blocked = {pid for pid in exclude_ids if pid}
    if not blocked:
        return list(assets)
    return [
        asset
        for asset in assets
        if not (asset_person_ids(asset) & blocked)
    ]


def _person_id(value: Any) -> str | None:
    if isinstance(value, dict):
        return _as_id(value.get("id"))
    return _as_id(value)


def _as_id(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
