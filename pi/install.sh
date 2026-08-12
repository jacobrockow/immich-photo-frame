#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  sudo ./install.sh [--server URL] [--user USER] [--config FILE]
  sudo ./install.sh https://frame.example.com [username]

Options:
  --server URL   Preconfigure this device for a Photo Frame server.
  --user USER    Desktop/kiosk user (default: pi, or KIOSK_USER from --config).
  --config FILE  Load builder-specific values from an env-style file.
  -h, --help     Show this help.

Builder config may define PHOTOFRAME_URL, DEVICE_ID, PHOTOFRAME_URL_LOCKED,
and KIOSK_USER. CLI values override config-file values.
EOF
}

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer with sudo/root privileges." >&2
  usage
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVICE_CONFIG=/etc/photoframe/device.env
CONFIG_FILE=""
CLI_SERVER=""
CLI_USER=""
POSITIONAL=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)
      CLI_SERVER="${2:-}"
      shift 2
      ;;
    --user)
      CLI_USER="${2:-}"
      shift 2
      ;;
    --config)
      CONFIG_FILE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

# Preserve previously provisioned device identity/config across reinstalls.
PHOTOFRAME_URL=""
DEVICE_ID=""
PHOTOFRAME_URL_LOCKED="false"
KIOSK_USER="pi"
if [[ -f "${DEVICE_CONFIG}" ]]; then
  # shellcheck disable=SC1090
  source "${DEVICE_CONFIG}"
fi

if [[ -n "${CONFIG_FILE}" ]]; then
  if [[ ! -f "${CONFIG_FILE}" ]]; then
    echo "Config file not found: ${CONFIG_FILE}" >&2
    exit 2
  fi
  # shellcheck disable=SC1090
  source "${CONFIG_FILE}"
fi

# Backward compatibility: install.sh URL [username]
if [[ ${#POSITIONAL[@]} -gt 0 && -z "${CLI_SERVER}" ]]; then
  CLI_SERVER="${POSITIONAL[0]}"
fi
if [[ ${#POSITIONAL[@]} -gt 1 && -z "${CLI_USER}" ]]; then
  CLI_USER="${POSITIONAL[1]}"
fi
if [[ ${#POSITIONAL[@]} -gt 2 ]]; then
  echo "Too many positional arguments." >&2
  usage
  exit 2
fi

if [[ -n "${CLI_SERVER}" ]]; then
  PHOTOFRAME_URL="${CLI_SERVER}"
  PHOTOFRAME_URL_LOCKED="true"
fi
if [[ -n "${CLI_USER}" ]]; then
  KIOSK_USER="${CLI_USER}"
fi

PHOTOFRAME_URL="${PHOTOFRAME_URL%/}"
if [[ -n "${PHOTOFRAME_URL}" && ! "${PHOTOFRAME_URL}" =~ ^https?://[^/]+$ ]]; then
  echo "Photo Frame server must be an http(s) origin without a path: ${PHOTOFRAME_URL}" >&2
  exit 2
fi

if [[ -z "${DEVICE_ID}" ]]; then
  RANDOM_ID="$(cat /proc/sys/kernel/random/uuid | tr -d '-' | cut -c1-10)"
  DEVICE_ID="pf-${RANDOM_ID}"
fi

if [[ ! "${DEVICE_ID}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "DEVICE_ID contains unsupported characters: ${DEVICE_ID}" >&2
  exit 2
fi

if [[ "${PHOTOFRAME_URL_LOCKED}" != "true" && "${PHOTOFRAME_URL_LOCKED}" != "false" ]]; then
  echo "PHOTOFRAME_URL_LOCKED must be true or false" >&2
  exit 2
fi

USER_HOME="$(getent passwd "${KIOSK_USER}" | cut -d: -f6)"
if [[ -z "${USER_HOME}" ]]; then
  echo "User ${KIOSK_USER} not found" >&2
  exit 1
fi
KIOSK_GROUP="$(id -gn "${KIOSK_USER}")"

echo "Installing Chromium…"
apt-get update
if ! apt-get install -y chromium; then
  apt-get install -y chromium-browser
fi

install -d -m 755 /etc/photoframe
cat >"${DEVICE_CONFIG}" <<EOF
PHOTOFRAME_URL=${PHOTOFRAME_URL}
DEVICE_ID=${DEVICE_ID}
PHOTOFRAME_URL_LOCKED=${PHOTOFRAME_URL_LOCKED}
EOF
chmod 644 "${DEVICE_CONFIG}"

install -m 755 "${SCRIPT_DIR}/chromium-launch.sh" /usr/local/bin/photoframe-chromium.sh
install -d -m 755 /usr/share/photoframe
install -m 644 "${SCRIPT_DIR}/bootstrap.html" /usr/share/photoframe/bootstrap.html

# Modern Raspberry Pi OS uses labwc/Wayland. Start Chromium from the graphical
# session so WAYLAND_DISPLAY and XDG_RUNTIME_DIR are inherited correctly.
LABWC_DIR="${USER_HOME}/.config/labwc"
LABWC_AUTOSTART="${LABWC_DIR}/autostart"
install -d -o "${KIOSK_USER}" -g "${KIOSK_GROUP}" "${LABWC_DIR}"
touch "${LABWC_AUTOSTART}"
chown "${KIOSK_USER}:${KIOSK_GROUP}" "${LABWC_AUTOSTART}"

if ! grep -Fq '/usr/local/bin/photoframe-chromium.sh' "${LABWC_AUTOSTART}"; then
  printf '\n# Immich Photo Frame kiosk\n/usr/local/bin/photoframe-chromium.sh &\n' >>"${LABWC_AUTOSTART}"
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
echo "Device ID: ${DEVICE_ID}"
echo "Startup: labwc Wayland autostart"
if [[ -n "${PHOTOFRAME_URL}" ]]; then
  echo "Photo Frame server: ${PHOTOFRAME_URL}"
  echo "Server setting locked: ${PHOTOFRAME_URL_LOCKED}"
  echo
echo "Reboot the Pi. Chromium will open ${PHOTOFRAME_URL}/setup in kiosk mode."
  echo "Unbound devices remain in setup; paired devices continue to their saved frame."
else
  echo "Photo Frame server: not configured"
  echo
echo "Reboot the Pi. Chromium will open the local device-bootstrap placeholder."
  echo "A later device-agent step will provide self-service Wi-Fi/server onboarding."
fi
echo "The dedicated Chromium profile persists device pairing across reboots."
