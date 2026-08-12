#!/usr/bin/env bash
set -u

DEVICE_CONFIG="${PHOTOFRAME_DEVICE_CONFIG:-/etc/photoframe/device.env}"
if [[ -f "${DEVICE_CONFIG}" ]]; then
  # shellcheck disable=SC1090
  source "${DEVICE_CONFIG}"
fi

PHOTOFRAME_URL="${PHOTOFRAME_URL:-}"
DEVICE_ID="${DEVICE_ID:-unknown}"
USER_DATA_DIR="${PHOTOFRAME_USER_DATA_DIR:-${HOME}/.config/photoframe-chromium}"
BOOTSTRAP_PAGE="${PHOTOFRAME_BOOTSTRAP_PAGE:-file:///usr/share/photoframe/bootstrap.html}"

if [[ -n "${PHOTOFRAME_URL}" ]]; then
  # /setup is the appliance entry point: unbound devices stay in setup, while
  # already-bound devices validate their saved token and continue to /frame.
  TARGET_URL="${PHOTOFRAME_URL%/}/setup"
else
  TARGET_URL="${BOOTSTRAP_PAGE}"
fi

mkdir -p "${USER_DATA_DIR}"

if command -v chromium >/dev/null 2>&1; then
  CHROMIUM_BIN="$(command -v chromium)"
elif command -v chromium-browser >/dev/null 2>&1; then
  CHROMIUM_BIN="$(command -v chromium-browser)"
else
  echo "Chromium is not installed" >&2
  exit 1
fi

echo "Starting Photo Frame device ${DEVICE_ID} at ${TARGET_URL}"

# Keep the kiosk alive if Chromium exits or crashes. labwc owns the graphical
# session, so restarting the browser here preserves the correct Wayland env.
while true; do
  "${CHROMIUM_BIN}" \
    --kiosk \
    --ozone-platform=wayland \
    --user-data-dir="${USER_DATA_DIR}" \
    --no-first-run \
    --no-default-browser-check \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-features=Translate \
    --check-for-update-interval=31536000 \
    --password-store=basic \
    --autoplay-policy=no-user-gesture-required \
    "${TARGET_URL}"

  sleep 3
done
