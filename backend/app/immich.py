from typing import Any

import httpx


class ImmichError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class ImmichClient:
    """
    Small adapter around the Immich HTTP API.

    Keep ALL Immich-version-specific endpoint details in this file.
    This starter targets Immich v3.
    """

    def __init__(
        self,
        base_url: str,
        *,
        api_key: str | None = None,
        access_token: str | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.access_token = access_token
        if not api_key and not access_token:
            raise ValueError("ImmichClient requires api_key or access_token")

    @property
    def headers(self) -> dict[str, str]:
        if self.api_key:
            return {"x-api-key": self.api_key}
        return {"Authorization": f"Bearer {self.access_token}"}

    async def _request(self, method: str, path: str, **kwargs) -> Any:
        timeout = httpx.Timeout(20.0, connect=10.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.request(
                method,
                f"{self.base_url}/api{path}",
                headers=self.headers,
                **kwargs,
            )

        if response.is_error:
            body = response.text[:500]
            raise ImmichError(
                f"Immich returned HTTP {response.status_code} for {path}: {body}",
                status_code=response.status_code,
            )

        if response.status_code == 204 or not response.content:
            return None

        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            return response.json()
        return response.content

    @classmethod
    async def login(
        cls,
        base_url: str,
        email: str,
        password: str,
    ) -> tuple["ImmichClient", dict[str, Any]]:
        """Authenticate with Immich email/password and return a bearer client."""
        timeout = httpx.Timeout(20.0, connect=10.0)
        url = f"{base_url.rstrip('/')}/api/auth/login"
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.post(
                url,
                json={"email": email, "password": password},
            )

        if response.is_error:
            body = response.text[:500]
            raise ImmichError(
                f"Immich login failed (HTTP {response.status_code}): {body}"
            )

        data = response.json()
        token = data.get("accessToken")
        if not token:
            raise ImmichError("Immich login response missing accessToken")

        return cls(base_url, access_token=token), data

    async def ping(self) -> bool:
        await self.get_my_user()
        return True

    async def get_my_user(self) -> dict[str, Any]:
        data = await self._request("GET", "/users/me")
        if not isinstance(data, dict) or "id" not in data:
            raise ImmichError("Unexpected response from Immich /users/me")
        return data

    async def create_api_key(self, name: str = "Immich Photo Frame") -> str:
        """
        Create a dedicated Immich API key using the current bearer session.

        Tries a few payload shapes because Immich permission DTOs vary by version.
        """
        payloads = [
            {"name": name, "permissions": ["all"]},
            {"name": name},
        ]
        last_error: Exception | None = None
        for payload in payloads:
            try:
                data = await self._request("POST", "/api-keys", json=payload)
                if isinstance(data, dict):
                    secret = data.get("secret") or data.get("apiKey") or data.get("key")
                    if isinstance(secret, str) and secret:
                        return secret
                last_error = ImmichError(
                    "Immich API key create response missing secret"
                )
            except ImmichError as exc:
                last_error = exc
        raise ImmichError(str(last_error) if last_error else "API key creation failed")

    async def list_albums(self) -> list[dict[str, Any]]:
        data = await self._request("GET", "/albums")
        if not isinstance(data, list):
            raise ImmichError("Unexpected response from Immich album endpoint")
        return data

    async def list_people(
        self,
        *,
        with_hidden: bool = False,
        page_size: int = 500,
        max_people: int = 2000,
    ) -> list[dict[str, Any]]:
        """
        Named people from Immich GET /people (paginated).

        Returns the flat `people` array entries (id, name, isHidden, …).
        """
        collected: list[dict[str, Any]] = []
        page = 1
        max_pages = max(1, (max_people + page_size - 1) // page_size)

        while page <= max_pages and len(collected) < max_people:
            data = await self._request(
                "GET",
                "/people",
                params={
                    "page": page,
                    "size": min(page_size, max_people - len(collected)),
                    "withHidden": str(with_hidden).lower(),
                },
            )
            if not isinstance(data, dict):
                raise ImmichError("Unexpected response from Immich /people")

            people = data.get("people")
            if not isinstance(people, list):
                raise ImmichError("Unexpected Immich /people.people shape")

            if not people:
                break

            remaining = max_people - len(collected)
            collected.extend(people[:remaining])

            has_next = data.get("hasNextPage")
            if has_next is False or len(people) < page_size:
                break
            if has_next is None and len(people) < page_size:
                break
            page += 1

        return collected

    async def get_person_thumbnail(self, person_id: str) -> tuple[bytes, str]:
        timeout = httpx.Timeout(20.0, connect=10.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.get(
                f"{self.base_url}/api/people/{person_id}/thumbnail",
                headers=self.headers,
            )

        if response.is_error:
            raise ImmichError(
                f"Immich returned HTTP {response.status_code} for person thumbnail"
            )

        return response.content, response.headers.get("content-type", "image/jpeg")

    def _search_filters(
        self,
        *,
        album_ids: list[str] | None = None,
        with_people: bool = False,
        taken_after: str | None = None,
        taken_before: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "type": "IMAGE",
            # Required for city/state/country (and other EXIF) on search items.
            "withExif": True,
        }
        if with_people:
            # Needed for exclude/prefer people filters on the Photo Frame side.
            payload["withPeople"] = True
        if album_ids:
            payload["albumIds"] = album_ids
        if taken_after:
            payload["takenAfter"] = taken_after
        if taken_before:
            payload["takenBefore"] = taken_before
        return payload

    async def search_assets_page(
        self,
        *,
        album_ids: list[str] | None = None,
        page: int = 1,
        size: int = 100,
        with_people: bool = False,
        order: str = "desc",
        taken_after: str | None = None,
        taken_before: str | None = None,
    ) -> tuple[list[dict[str, Any]], int | None]:
        """
        One page of Immich v3 asset search via POST /search/metadata.

        Returns (items, next_page) where next_page is None when finished.
        Default Immich order is newest-first (`desc`) by taken/created date.
        """
        payload = self._search_filters(
            album_ids=album_ids,
            with_people=with_people,
            taken_after=taken_after,
            taken_before=taken_before,
        )
        payload.update(
            {
                "size": size,
                "page": page,
                "order": order,
            }
        )

        data = await self._request("POST", "/search/metadata", json=payload)
        return self._parse_search_page(data, current_page=page, page_size=size)

    async def search_random_assets(
        self,
        *,
        album_ids: list[str] | None = None,
        max_assets: int = 1000,
        with_people: bool = False,
    ) -> list[dict[str, Any]]:
        """
        Sample images via POST /search/random (Immich's kiosk-friendly endpoint).

        Immich caps `size` at 1000 per call, so we may issue a few rounds and
        dedupe to build a larger / fresher pool.
        """
        collected: list[dict[str, Any]] = []
        seen: set[str] = set()
        # Extra rounds improve coverage when the library is much larger than max.
        rounds = min(6, max(1, (max_assets + 999) // 1000) + 2)

        for _ in range(rounds):
            if len(collected) >= max_assets:
                break
            payload = self._search_filters(
                album_ids=album_ids,
                with_people=with_people,
            )
            payload["size"] = min(1000, max_assets)
            data = await self._request("POST", "/search/random", json=payload)
            items = self._parse_random_response(data)
            if not items:
                break
            for item in items:
                asset_id = item.get("id")
                if not isinstance(asset_id, str) or asset_id in seen:
                    continue
                seen.add(asset_id)
                collected.append(item)
                if len(collected) >= max_assets:
                    break

        return collected[:max_assets]

    async def search_assets_time_spread(
        self,
        *,
        album_ids: list[str] | None = None,
        page_size: int = 100,
        max_assets: int = 1000,
        with_people: bool = False,
    ) -> list[dict[str, Any]]:
        """
        Fallback when /search/random is unavailable: sample newest + oldest +
        a few taken-date windows so recent years cannot crowd out the pool.
        """
        from datetime import datetime, timezone

        collected: list[dict[str, Any]] = []
        seen: set[str] = set()

        def add_items(items: list[dict[str, Any]]) -> None:
            for item in items:
                asset_id = item.get("id")
                if not isinstance(asset_id, str) or asset_id in seen:
                    continue
                seen.add(asset_id)
                collected.append(item)

        # Newest and oldest slices.
        for order in ("desc", "asc"):
            if len(collected) >= max_assets:
                break
            items, _ = await self.search_assets_page(
                album_ids=album_ids,
                page=1,
                size=min(page_size, max_assets),
                with_people=with_people,
                order=order,
            )
            add_items(items)

        # Year-ish windows relative to today (recent → older).
        now = datetime.now(timezone.utc)

        def shift_years(years_ago: int) -> str:
            year = max(1970, now.year - years_ago)
            try:
                return now.replace(year=year).isoformat()
            except ValueError:
                # Feb 29 → Feb 28 on non-leap targets.
                return now.replace(year=year, day=28).isoformat()

        windows = (
            (0, 1),
            (1, 3),
            (3, 6),
            (6, 12),
            (12, 25),
        )
        per_window = max(20, max_assets // (len(windows) + 2))
        for start_years_ago, end_years_ago in windows:
            if len(collected) >= max_assets:
                break
            items, _ = await self.search_assets_page(
                album_ids=album_ids,
                page=1,
                size=min(page_size, per_window),
                with_people=with_people,
                order="desc",
                taken_after=shift_years(end_years_ago),
                taken_before=shift_years(start_years_ago),
            )
            add_items(items)

        return collected[:max_assets]

    async def search_assets(
        self,
        *,
        album_ids: list[str] | None = None,
        page_size: int = 100,
        max_assets: int = 1000,
        with_people: bool = False,
    ) -> list[dict[str, Any]]:
        """
        Build a slideshow candidate pool from Immich.

        Prefer /search/random so large recent uploads (e.g. all of 2026) do not
        dominate a newest-first metadata crawl capped at max_assets. Falls back
        to a time-spread metadata sample if random search is unavailable.
        """
        try:
            return await self.search_random_assets(
                album_ids=album_ids,
                max_assets=max_assets,
                with_people=with_people,
            )
        except ImmichError:
            return await self.search_assets_time_spread(
                album_ids=album_ids,
                page_size=page_size,
                max_assets=max_assets,
                with_people=with_people,
            )

    @staticmethod
    def _parse_random_response(data: Any) -> list[dict[str, Any]]:
        """POST /search/random returns a bare asset array on current Immich."""
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        if isinstance(data, dict):
            assets = data.get("assets")
            if isinstance(assets, dict) and isinstance(assets.get("items"), list):
                return [item for item in assets["items"] if isinstance(item, dict)]
            if isinstance(data.get("items"), list):
                return [item for item in data["items"] if isinstance(item, dict)]
        raise ImmichError("Unexpected response shape from Immich random search")

    @staticmethod
    def _parse_search_page(
        data: Any,
        *,
        current_page: int,
        page_size: int,
    ) -> tuple[list[dict[str, Any]], int | None]:
        if not isinstance(data, dict):
            raise ImmichError("Unexpected response shape from Immich metadata search")

        assets = data.get("assets")
        if isinstance(assets, dict):
            items = assets.get("items", [])
            if not isinstance(items, list):
                raise ImmichError("Unexpected Immich search assets.items shape")

            next_raw = assets.get("nextPage")
            next_page: int | None
            if next_raw is None or next_raw == "" or next_raw is False:
                next_page = None
            else:
                try:
                    next_page = int(next_raw)
                except (TypeError, ValueError):
                    next_page = current_page + 1 if len(items) >= page_size else None
            return items, next_page

        if isinstance(data.get("items"), list):
            items = data["items"]
            next_page = current_page + 1 if len(items) >= page_size else None
            return items, next_page

        raise ImmichError("Unexpected response shape from Immich metadata search")

    async def get_thumbnail(self, asset_id: str) -> tuple[bytes, str]:
        """
        Fetch a web-displayable still for an asset.

        Prefer Immich preview (viewer size); fall back to thumbnail when the
        preview is missing or not yet generated.
        """
        timeout = httpx.Timeout(30.0, connect=10.0)
        last_error: ImmichError | None = None
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            for size in ("preview", "thumbnail"):
                response = await client.get(
                    f"{self.base_url}/api/assets/{asset_id}/thumbnail",
                    params={"size": size},
                    headers=self.headers,
                )
                if response.is_error:
                    last_error = ImmichError(
                        f"Immich returned HTTP {response.status_code} for asset {size}",
                        status_code=response.status_code,
                    )
                    continue
                content = response.content
                if not content:
                    last_error = ImmichError(
                        f"Immich returned an empty {size} for asset",
                        status_code=502,
                    )
                    continue
                content_type = response.headers.get("content-type", "image/jpeg")
                media_type = content_type.split(";")[0].strip() or "image/jpeg"
                if not media_type.startswith("image/"):
                    last_error = ImmichError(
                        f"Immich returned non-image {media_type} for asset {size}",
                        status_code=502,
                    )
                    continue
                return content, media_type

        if last_error:
            raise last_error
        raise ImmichError("Immich returned no usable thumbnail for asset", status_code=502)

    async def archive_asset(self, asset_id: str) -> None:
        """
        Archive an asset in Immich.

        Newer Immich uses `visibility: archive`; older builds used `isArchived`.
        """
        attempts: list[tuple[str, str, dict[str, Any]]] = [
            ("PUT", "/assets", {"ids": [asset_id], "visibility": "archive"}),
            ("PUT", "/assets", {"ids": [asset_id], "isArchived": True}),
            ("PUT", f"/assets/{asset_id}", {"visibility": "archive"}),
            ("PUT", f"/assets/{asset_id}", {"isArchived": True}),
        ]
        last_error: ImmichError | None = None
        for method, path, payload in attempts:
            try:
                await self._request(method, path, json=payload)
                return
            except ImmichError as exc:
                last_error = exc
                if exc.status_code in {401, 403}:
                    raise
                continue
        raise ImmichError(
            str(last_error)
            if last_error
            else "Unable to archive asset in Immich"
        )

    async def get_asset_edits(self, asset_id: str) -> list[dict[str, Any]]:
        data = await self._request("GET", f"/assets/{asset_id}/edits")
        if data is None:
            return []
        if isinstance(data, dict):
            edits = data.get("edits")
            if isinstance(edits, list):
                return [item for item in edits if isinstance(item, dict)]
            return []
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        return []

    async def rotate_asset(self, asset_id: str, degrees: int) -> dict[str, Any]:
        """
        Rotate via Immich asset edits (v2.5+).

        `degrees` is a relative turn: +90 (right / CW) or -90 (left / CCW).
        Immich stores an absolute angle in {0, 90, 180, 270}.
        """
        if degrees not in (90, -90):
            raise ImmichError("Rotate degrees must be 90 or -90")

        try:
            edits = await self.get_asset_edits(asset_id)
        except ImmichError as exc:
            if exc.status_code in {404, 405, 501}:
                raise ImmichError(
                    "Rotate needs Immich asset edits support (v2.5+)",
                    status_code=exc.status_code,
                ) from exc
            raise

        current_angle = 0
        other_edits: list[dict[str, Any]] = []
        for edit in edits:
            if edit.get("action") == "rotate":
                params = edit.get("parameters") or {}
                try:
                    current_angle = int(params.get("angle") or 0) % 360
                except (TypeError, ValueError):
                    current_angle = 0
            else:
                other_edits.append(edit)

        new_angle = (current_angle + degrees) % 360
        if new_angle not in (0, 90, 180, 270):
            new_angle = int(round(new_angle / 90.0) * 90) % 360

        new_edits = list(other_edits)
        if new_angle != 0:
            new_edits.append(
                {"action": "rotate", "parameters": {"angle": new_angle}}
            )

        try:
            if not new_edits:
                await self._request("DELETE", f"/assets/{asset_id}/edits")
                return {"edits": [], "angle": 0}

            data = await self._request(
                "PUT",
                f"/assets/{asset_id}/edits",
                json={"edits": new_edits},
            )
            if isinstance(data, dict):
                return {**data, "angle": new_angle}
            return {"edits": new_edits, "angle": new_angle}
        except ImmichError as exc:
            if exc.status_code in {404, 405, 501}:
                raise ImmichError(
                    "Rotate needs Immich asset edits support (v2.5+)",
                    status_code=exc.status_code,
                ) from exc
            raise
