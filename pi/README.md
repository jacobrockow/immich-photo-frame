# Raspberry Pi photo frame appliance

Turn a Raspberry Pi into a disposable kiosk that boots into Immich Photo Frame
setup (or an already-bound slideshow).

## What this does

- Installs Chromium
- Creates a kiosk systemd user service
- Disables screen blanking
- Hides the cursor after inactivity
- Opens the Photo Frame server at `/frame` on boot (`/setup` if unbound)
- Restarts Chromium if it crashes

The Pi does **not** need:

- WireGuard
- NFS/CIFS mounts
- A local Immich API key

Immich credentials stay on the Photo Frame server. After setup, the browser
stores the bound frame token in its persistent profile and opens `/frame`
(the token is not shown in the URL).

## Requirements

- Raspberry Pi OS (Bookworm or newer recommended)
- Network access to your Photo Frame server
- A desktop/session that can run Chromium (the default Raspberry Pi desktop works)

## Install

On the Pi:

```bash
sudo ./install.sh https://frame.example.com
```

Replace the URL with your Photo Frame frontend origin (the host that serves the
React app, usually port 5173 in compose, or your reverse-proxied HTTPS URL).

Optional second argument sets the local kiosk username (default: `pi`):

```bash
sudo ./install.sh https://frame.example.com pi
```

## After install

1. Reboot the Pi.
2. Chromium opens `/frame` (redirects to `/setup` if unbound).
3. Sign in with Immich on the Pi or via the QR code on a phone.
4. The device binds and shows “Setup in progress” until settings are saved once.
5. Reboots reopen `/frame` with the stored binding — no Immich login again.
6. Hold on the slideshow later to edit frame settings (or use the web UI).

## Files

```text
pi/
├── install.sh
├── photoframe-kiosk.service
├── chromium-launch.sh
└── README.md
```

## Reconfigure / factory reset

Clear the browser profile used by the kiosk user (or remove
`photoframe_frame_token` / `photoframe_device_key` from that profile's
localStorage), then reopen `/setup`.
