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
USER_HOME="$(getent passwd "${KIOSK_USER}" | cut -d: -f6)"
if [[ -z "${USER_HOME}" ]]; then
  echo "User ${KIOSK_USER} not found"
  exit 1
fi

KIOSK_GROUP="$(id -gn "${KIOSK_USER}")"

echo "Installing Chromium…"
apt-get update
if ! apt-get install -y chromium; then
  apt-get install -y chromium-browser
fi

install -d /etc/photoframe
cat >/etc/photoframe/kiosk.env <<EOF
PHOTOFRAME_URL=${PHOTOFRAME_URL}
EOF

install -m 755 "${SCRIPT_DIR}/chromium-launch.sh" /usr/local/bin/photoframe-chromium.sh

# Modern Raspberry Pi OS uses labwc/Wayland. Start Chromium from the graphical
# session so WAYLAND_DISPLAY and XDG_RUNTIME_DIR are inherited correctly.
LABWC_DIR="${USER_HOME}/.config/labwc"
LABWC_AUTOSTART="${LABWC_DIR}/autostart"
install -d -o "${KIOSK_USER}" -g "${KIOSK_GROUP}" "${LABWC_DIR}"
touch "${LABWC_AUTOSTART}"
chown "${KIOSK_USER}:${KIOSK_GROUP}" "${LABWC_AUTOSTART}"

AUTOSTART_LINE='PHOTOFRAME_URL="$(cat /etc/photoframe/kiosk.env | sed -n "s/^PHOTOFRAME_URL=//p")" /usr/local/bin/photoframe-chromium.sh &'
if ! grep -Fq '/usr/local/bin/photoframe-chromium.sh' "${LABWC_AUTOSTART}"; then
  printf '\n# Immich Photo Frame kiosk\n%s\n' "${AUTOSTART_LINE}" >>"${LABWC_AUTOSTART}"
fi

# Remove the legacy user-service installation if this script is rerun on a Pi
# previously configured by an older Photo Frame installer.
LEGACY_SERVICE="${USER_HOME}/.config/systemd/user/photoframe-kiosk.service"
if [[ -f "${LEGACY_SERVICE}" ]]; then
  USER_UID="$(id -u "${KIOSK_USER}")"
  sudo -u "${KIOSK_USER}" XDG_RUNTIME_DIR="/run/user/${USER_UID}" \
    systemctl --user disable --now photoframe-kiosk.service 2>/dev/null || true
  rm -f "${LEGACY_SERVICE}"
fi

echo
echo "Installed Immich Photo Frame kiosk for user '${KIOSK_USER}'."
echo "Photo Frame URL: ${PHOTOFRAME_URL}"
echo "Startup: labwc Wayland autostart"
echo
echo "Reboot the Pi. Chromium will open ${PHOTOFRAME_URL%/}/setup in kiosk mode."
echo "Unbound devices remain in setup; paired devices continue to their saved frame."
echo "The dedicated Chromium profile persists the device pairing across reboots."
