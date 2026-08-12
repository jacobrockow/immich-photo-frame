#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file() {
  [[ -f "$1" ]] || fail "expected file: $1"
}

assert_contains() {
  grep -Fq "$2" "$1" || fail "expected '$2' in $1"
}

run_install() {
  "${SCRIPT_DIR}/install.sh" --root "$1" "${@:2}"
}

echo "== preconfigured appliance =="
ROOT="${TMP_DIR}/configured"
run_install "${ROOT}" --server https://frame.example.com --user frame
CONFIG="${ROOT}/etc/photoframe/device.env"
AUTOSTART="${ROOT}/home/frame/.config/labwc/autostart"
assert_file "${CONFIG}"
assert_file "${ROOT}/usr/local/bin/photoframe-chromium.sh"
assert_file "${ROOT}/usr/share/photoframe/bootstrap.html"
assert_file "${AUTOSTART}"
assert_contains "${CONFIG}" 'PHOTOFRAME_URL=https://frame.example.com'
assert_contains "${CONFIG}" 'PHOTOFRAME_URL_LOCKED=true'
assert_contains "${CONFIG}" 'DEVICE_ID=pf-'
assert_contains "${AUTOSTART}" '/usr/local/bin/photoframe-chromium.sh &'
DEVICE_ID_BEFORE="$(sed -n 's/^DEVICE_ID=//p' "${CONFIG}")"

# Reinstalling should preserve identity and not duplicate autostart entries.
run_install "${ROOT}" --server https://frame.example.com --user frame
DEVICE_ID_AFTER="$(sed -n 's/^DEVICE_ID=//p' "${CONFIG}")"
[[ "${DEVICE_ID_BEFORE}" == "${DEVICE_ID_AFTER}" ]] || fail "DEVICE_ID changed across reinstall"
[[ "$(grep -Fc '/usr/local/bin/photoframe-chromium.sh &' "${AUTOSTART}")" -eq 1 ]] || fail "duplicate labwc autostart entry"

echo "== generic appliance =="
ROOT="${TMP_DIR}/generic"
run_install "${ROOT}" --user frame
CONFIG="${ROOT}/etc/photoframe/device.env"
assert_file "${CONFIG}"
assert_contains "${CONFIG}" 'PHOTOFRAME_URL='
assert_contains "${CONFIG}" 'PHOTOFRAME_URL_LOCKED=false'
assert_contains "${CONFIG}" 'DEVICE_ID=pf-'

echo "== private builder config =="
BUILDER_CONFIG="${TMP_DIR}/builder.env"
cat >"${BUILDER_CONFIG}" <<'EOF'
PHOTOFRAME_URL=https://private.example.test
PHOTOFRAME_URL_LOCKED=true
DEVICE_ID=pf-testdevice
KIOSK_USER=builder
EOF
ROOT="${TMP_DIR}/builder"
run_install "${ROOT}" --config "${BUILDER_CONFIG}"
CONFIG="${ROOT}/etc/photoframe/device.env"
assert_contains "${CONFIG}" 'PHOTOFRAME_URL=https://private.example.test'
assert_contains "${CONFIG}" 'DEVICE_ID=pf-testdevice'
assert_file "${ROOT}/home/builder/.config/labwc/autostart"

echo "== validation =="
if run_install "${TMP_DIR}/bad-url" --server 'https://frame.example.com/setup' --user frame >/dev/null 2>&1; then
  fail "installer accepted server URL with a path"
fi

echo "All appliance installer smoke tests passed."
