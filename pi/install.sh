#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo ./install.sh https://frame.example.com [username]"
  exit 1
fi

PHOTOFRAME_URL="${1:-}"
KIOSK_USER="${2:-pi}"

if [[ -z "${PHOTOFRAME_URL}" ]]; then
  echo "Usage: sudo ./install.sh https://frame.example.com [username]"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing packages…"
apt-get update
apt-get install -y chromium-browser unclutter x11-xserver-utils || \
  apt-get install -y chromium unclutter x11-xserver-utils

install -d /etc/photoframe
cat >/etc/photoframe/kiosk.env <<EOF
PHOTOFRAME_URL=${PHOTOFRAME_URL}
EOF

install -m 755 "${SCRIPT_DIR}/chromium-launch.sh" /usr/local/bin/photoframe-chromium.sh

# Prefer chromium if chromium-browser is unavailable.
if ! command -v chromium-browser >/dev/null 2>&1 && command -v chromium >/dev/null 2>&1; then
  sed -i 's/chromium-browser/chromium/g' /usr/local/bin/photoframe-chromium.sh
fi

USER_HOME="$(getent passwd "${KIOSK_USER}" | cut -d: -f6)"
if [[ -z "${USER_HOME}" ]]; then
  echo "User ${KIOSK_USER} not found"
  exit 1
fi

install -d -o "${KIOSK_USER}" -g "${KIOSK_USER}" \
  "${USER_HOME}/.config/systemd/user"

install -m 644 "${SCRIPT_DIR}/photoframe-kiosk.service" \
  "${USER_HOME}/.config/systemd/user/photoframe-kiosk.service"
chown "${KIOSK_USER}:${KIOSK_USER}" \
  "${USER_HOME}/.config/systemd/user/photoframe-kiosk.service"

# Enable lingering so the user service can start at boot.
loginctl enable-linger "${KIOSK_USER}"

sudo -u "${KIOSK_USER}" XDG_RUNTIME_DIR="/run/user/$(id -u "${KIOSK_USER}")" \
  systemctl --user daemon-reload || true
sudo -u "${KIOSK_USER}" XDG_RUNTIME_DIR="/run/user/$(id -u "${KIOSK_USER}")" \
  systemctl --user enable photoframe-kiosk.service || true

echo
echo "Installed Immich Photo Frame kiosk for user '${KIOSK_USER}'."
echo "Photo Frame URL: ${PHOTOFRAME_URL}"
echo
echo "Reboot the Pi. On first boot Chromium opens ${PHOTOFRAME_URL%/}/frame"
echo "(unbound devices redirect to /setup). Sign in with Immich to bind this device."
echo "The frame token is stored in the Chromium profile and survives reboots."
