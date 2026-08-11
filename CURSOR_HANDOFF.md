# Cursor Handoff

## Project goal

Self-hosted digital photo frame platform backed by Immich.

## Deployment model

1. Server admin hosts one Photo Frame server (internet-accessible).
2. One shared Immich instance holds everyone’s photos.
3. End users in different homes sign in with **their** Immich accounts.
4. Unconfigured Pi boots to `/setup` (QR + code).
5. User signs in on the Pi or phone → frame is created and device is bound.
6. Kiosk shows “Setup in progress” until settings are saved (`frame.configured`).
7. Phone continues to `/frames/:id` (or configure on-device); first save starts slideshow.
8. Later edits refresh via kiosk polling. No Immich credentials on the Pi.

## Product principles

- Immich is the photo database; do not recreate photo management.
- Frame-specific state belongs in this application.
- Immich credentials are per-user and stay server-side.
- Raspberry Pis are disposable thin clients.
- Logout of the control UI must not wipe device/frame settings.

## Current surface

**Backend:** FastAPI, SQLite, per-user Immich keys, `is_admin`, frames/devices, seasonal playlist, OpenWeather, kiosk token auth.

**Frontend routes:**
- `/` — Frames list (admins see all)
- `/frames/:id` — frame settings
- `/account` — Immich API key
- `/admin/settings`, `/admin/users` — server admin
- `/setup` — device enrollment
- `/frame` — kiosk (token in localStorage)

**Pi:** `pi/install.sh` Chromium kiosk → `/frame` (falls through to `/setup` if unbound).

**Compose:**
- `compose.yml` — local: UI `:5173` + API `:8000`, `VITE_API_URL=http://localhost:8000`
- `compose.prod.yml` — production: only Nginx published; same-origin `/api` proxied to backend; SQLite on `photoframe-data`

## Architecture

```text
Browser / Raspberry Pi
        |
        | frame token (kiosk) or session cookie (control UI)
        v
Photo Frame FastAPI
        |
        | per-user Immich API key
        v
      Immich
```

Keep Immich endpoint details in `backend/app/immich.py`. Prefer Immich v3 search APIs — do not use `GET /api/assets/random`. Docs: https://api.immich.app/

## Coding conventions

- Python 3.12+, type hints, Pydantic API contracts
- React function components, TypeScript strict
- Avoid storing UI-only state in the backend

## Backlog (not started)

- Multi-album / weighted sources, favorites, date ranges, video toggle
- Offline resilience (service worker / image cache)
- Factory reset on device; frame-token rotation
- CSRF / rate limits / HTTPS-only production hardening
- Richer kiosk controls (pause, hide-from-frame without Immich archive)
