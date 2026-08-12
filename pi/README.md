# Raspberry Pi photo frame appliance

Turn a Raspberry Pi into a Photo Frame appliance that boots directly into setup
or an already-bound slideshow.

## Design

The physical device only needs to know the URL of its Photo Frame server. It does
not store an Immich server URL or Immich credentials. The Photo Frame server owns
that configuration centrally.

Device-local configuration is stored in:

```text
/etc/photoframe/device.env
```

with values such as:

```bash
PHOTOFRAME_URL=https://frame.example.com
DEVICE_ID=pf-a73f92c1
PHOTOFRAME_URL_LOCKED=true
```

`DEVICE_ID` is generated automatically on first install and preserved on
reinstall. `PHOTOFRAME_URL_LOCKED=true` indicates a builder-provisioned server
that a future factory-reset flow should preserve.

## What the installer does

- Installs Chromium.
- Creates/preserves a stable device ID.
- Writes the persistent device configuration.
- Installs the dedicated Chromium kiosk launcher.
- Starts the kiosk through labwc autostart on modern Raspberry Pi OS / Wayland.
- Uses a dedicated Chromium profile so pairing survives reboots.
- Opens the Photo Frame server at `/setup`; an already-bound browser continues
  automatically to its saved frame.
- Restarts Chromium if it exits or crashes.
- Cleans up the legacy X11/systemd-user kiosk service if present.

The Pi does **not** need WireGuard, NFS/CIFS mounts, a local Immich API key, or
the Immich server URL.

## Requirements

- Current Raspberry Pi OS / Debian with the labwc Wayland desktop session.
- A desktop user configured for automatic graphical login.
- Network access to the chosen Photo Frame server for a preconfigured device.

## Preconfigured device

This is the recommended build path when you are preparing a frame for someone
who should never need to know the Photo Frame server address:

```bash
sudo ./install.sh --server https://frame.example.com --user pi
```

The server value is marked as builder-owned (`PHOTOFRAME_URL_LOCKED=true`). On
boot, Chromium opens `https://frame.example.com/setup`; the end user only
completes normal frame/account pairing.

The legacy positional form remains supported:

```bash
sudo ./install.sh https://frame.example.com pi
```

## Builder config file

For repeatable personal builds, copy the template to a private ignored file:

```bash
cp device.env.example device.env
vim device.env
sudo ./install.sh --config ./device.env --user pi
```

`pi/device.env` is ignored by Git, so deployment-specific URLs do not need to be
committed to the public repository. `DEVICE_ID` may be left empty to generate
one automatically.

## Generic / self-hosted device

The installer also accepts no server at all:

```bash
sudo ./install.sh --user pi
```

That produces an intentionally unprovisioned device. For now it opens a local
bootstrap placeholder. The next appliance component will be a local device agent
that lets an owner configure Wi-Fi and their Photo Frame server from the device
or a phone without exposing Raspberry Pi OS.

The intended finished flow is:

```text
power on
  -> local Wi-Fi/server bootstrap when needed
  -> Photo Frame server /setup
  -> Immich account pairing
  -> slideshow
```

## Testing without a clean Raspberry Pi

Most installer behavior can be tested safely without modifying the host. The
`--root` option mirrors the files that would be installed beneath a temporary
directory and skips package installation/systemd changes:

```bash
sudo ./install.sh \
  --root /tmp/photoframe-test \
  --server https://frame.example.com \
  --user pi

find /tmp/photoframe-test -type f -print
cat /tmp/photoframe-test/etc/photoframe/device.env
cat /tmp/photoframe-test/home/pi/.config/labwc/autostart
```

Run the repository smoke tests with:

```bash
sudo bash pi/test-install.sh
```

The same smoke test runs in GitHub Actions whenever the Pi appliance files
change. It verifies preconfigured and generic installs, persistent device IDs,
idempotent labwc autostart, private builder configuration, and URL validation.

### Interactive virtual-machine testing

A normal Debian/Raspberry Pi Desktop-style x86_64 VM on a PC is useful for
interactively testing the bootstrap UI, Chromium kiosk behavior, server pairing,
and most of the installer. It does **not** emulate Raspberry Pi hardware, and a
stock Debian desktop may not exactly reproduce Raspberry Pi OS's `rpd-labwc`
session. Treat it as the fast GUI-development environment rather than the final
hardware certification environment.

For the closest GUI test, give the VM a graphical desktop with labwc/Wayland and
Chromium, configure automatic login, then run the normal installer against the
VM (without `--root`). The existing physical Pi remains the final integration
test for Raspberry Pi OS-specific autostart, touchscreen behavior, GPU/display
handling, and future Wi-Fi hotspot/client transitions.

This layered approach avoids requiring a clean SD-card flash for every change:

1. sandbox/CI tests validate filesystem and installer behavior;
2. an x86_64 graphical VM validates the visible setup/kiosk experience;
3. a physical Pi validates hardware-specific behavior before release.

## After install

1. Reboot the Pi.
2. labwc starts the Photo Frame Chromium kiosk automatically.
3. A preconfigured device opens the server's `/setup` page.
4. Pair the device with an Immich account, preferably using the QR/phone flow.
5. The bound frame token remains in the dedicated Chromium profile.
6. Future boots return automatically to the paired slideshow.

## Files

```text
pi/
├── bootstrap.html
├── chromium-launch.sh
├── device.env.example
├── install.sh
├── test-install.sh
├── photoframe-kiosk.service   # legacy installer compatibility only
└── README.md
```

## Reconfigure / factory reset

Until the device agent implements a first-class reset flow, pairing can be reset
by clearing the dedicated Chromium profile/localStorage. A future factory reset
will distinguish between builder configuration and user configuration so a
preconfigured `PHOTOFRAME_URL_LOCKED=true` server can survive a reset while Wi-Fi
and frame pairing are cleared.
