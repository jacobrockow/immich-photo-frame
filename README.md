# Immich Photo Frame

A multi-user digital photo frame platform backed by a self-hosted Immich instance.

Architecture:

- **Immich remains the source of truth for photos**
- **The frame server owns users, devices, and frame-specific configuration**
- **Raspberry Pis are thin kiosk clients**
- Each physical frame binds to an unguessable **frame token**
- Immich credentials stay on the server (per user), never on the Pi

## Who it's for

One Photo Frame server + one Immich server (both internet-accessible). End users
in different homes sign in with **their** Immich accounts. Each person’s frames
only see what their Immich credentials can access. A server admin sets the shared
Immich URL and can manage users and any frame.

## Features

- Per-user Immich connection (login or API key)
- Frames list + click-in settings (`/` → `/frames/:id`)
- Account page for Immich API key (`/account`)
- Server admin settings and users (`/admin/settings`, `/admin/users`)
- Device self-enrollment at `/setup` (QR + code; phone or on-device)
- First-run “Setup in progress” until settings are saved
- Photo source per frame (library or album) with overlays, weather, seasonal weighting
- Kiosk at `/frame` (token in local storage, not the URL)
- Backend image proxy so the Pi never receives Immich secrets
- Docker/Podman Compose + Raspberry Pi appliance scripts in `pi/`

## Repository layout

```text
immich-photo-frame/
├── backend/          # FastAPI app
├── frontend/         # React + Vite control UI & kiosk
├── pi/               # Chromium kiosk install scripts
├── compose.yml       # Local development (UI :5173 + API :8000)
├── compose.prod.yml  # Production (only Nginx published; /api proxied)
├── .env.example
├── README.md
└── CURSOR_HANDOFF.md
```

## Quick start (local)

Copy `.env.example` to `.env` and set at least `DEFAULT_IMMICH_URL` to your
public Immich base URL.

### Option 1: Docker / Podman Compose (local)

```bash
podman compose up --build
# or: docker compose up --build
```

Then open:

- Frames: http://localhost:5173
- Account: http://localhost:5173/account
- Admin settings: http://localhost:5173/admin/settings
- Admin users: http://localhost:5173/admin/users
- Device setup: http://localhost:5173/setup
- API docs: http://localhost:8000/docs

The local stack publishes both the UI (`5173`) and the API (`8000`). The
frontend is built to call `http://localhost:8000`.

### Option 2: Development mode

Backend:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

## Production

Production uses [compose.prod.yml](compose.prod.yml):

- Only the frontend Nginx container is published (default host port `80`)
- Browser calls same-origin `/api/*`; Nginx proxies to the backend on the Docker network
- Backend is **not** exposed on the host
- SQLite persists on the `photoframe-data` volume at `/data/photoframe.db`

```bash
cp .env.example .env
# Set DEFAULT_IMMICH_URL, OPENWEATHER_API_KEY, etc.
# For production, clear CORS_ORIGINS (same-origin) or set it to your public origin.
# Optional: FRONTEND_PORT=8080

podman compose -f compose.prod.yml --env-file .env up -d --build
# or: docker compose -f compose.prod.yml --env-file .env up -d --build
```

Then open your public origin (or `http://localhost` if testing locally on port 80):

- Frames / account / admin / setup / kiosk all on that single origin
- Health check: `https://your-frame.example.com/api/health`

Point Raspberry Pis at the same public origin (see [`pi/README.md`](pi/README.md)).
TLS can terminate in front of the published port (reverse proxy / tunnel); the
app itself has no CDN-specific logic.

## Immich connection

The shared Immich **server address** is a server-admin setting
(`DEFAULT_IMMICH_URL` seeds it). Each user keeps their own Immich **API key**
under Account.

Users can:

1. Sign in with Immich email/password (server attempts to create an API key), or
2. Paste an Immich API key

Needed Immich permissions: albums, asset metadata/search, and thumbnails.
API key creation permission is required for the password login path.

The first account on a fresh server becomes the server admin.

## Device setup

1. Pi (or browser) opens `/setup` and shows a QR code + setup code
2. Finish on the phone or on the device with Immich login / API key
3. Server creates a frame (default name: `Firstname's Frame`) and binds the device
4. Pi stores the frame token and opens `/frame` (“Setup in progress”)
5. Phone lands on frame settings; save once to start the slideshow
6. Later changes from phone or on-device settings refresh automatically

## Raspberry Pi

See [`pi/README.md`](pi/README.md).

## Notes

- Frame tokens authorize kiosk access; keep them private.
- Weather uses a server-wide OpenWeather key; each frame picks its own location.
- `/admin/*` is for server operators. Per-user Immich API keys live under Account.
