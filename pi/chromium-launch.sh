#!/usr/bin/env bash
set -euo pipefail

PHOTOFRAME_URL="${PHOTOFRAME_URL:-http://localhost:5173}"
# Opaque kiosk path — frame token lives in the persistent Chromium profile.
TARGET_URL="${PHOTOFRAME_URL%/}/frame"
USER_DATA_DIR="${PHOTOFRAME_USER_DATA_DIR:-${HOME}/.config/photoframe-chromium}"

mkdir -p "${USER_DATA_DIR}"

# Disable screen blanking / power management when possible.
if command -v xset >/dev/null 2>&1; then
  xset s off || true
  xset -dpms || true
  xset s noblank || true
fi

# Hide the mouse cursor after a few seconds of inactivity.
if command -v unclutter >/dev/null 2>&1; then
  unclutter -idle 3 -root &
fi

exec chromium-browser \
  --kiosk \
  --user-data-dir="${USER_DATA_DIR}" \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --check-for-update-interval=31536000 \
  --password-store=basic \
  --autoplay-policy=no-user-gesture-required \
  "${TARGET_URL}"
