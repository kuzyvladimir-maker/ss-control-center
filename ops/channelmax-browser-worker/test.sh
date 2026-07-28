#!/bin/bash

# Offline/static operational tests. This script never installs, loads, starts,
# stops, contacts SSCC, reads Keychain, or opens Chrome/CDP.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
readonly TEMPLATE="$SCRIPT_DIR/com.salutem.channelmax-browser-worker.plist.template"
readonly RUNNER="$SCRIPT_DIR/run-worker.sh"
readonly INSTALLER="$SCRIPT_DIR/install-launchagent.sh"
readonly STATUS="$SCRIPT_DIR/status.sh"

fail() {
  /bin/echo "FAIL: $1" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local pattern="$2"
  rg -q -- "$pattern" "$file" || fail "$file does not contain required pattern: $pattern"
}

assert_absent() {
  local file="$1"
  local pattern="$2"
  if rg -q -- "$pattern" "$file"; then
    fail "$file contains forbidden pattern: $pattern"
  fi
}

for script in "$RUNNER" "$INSTALLER" "$STATUS" "$SCRIPT_DIR/test.sh"; do
  /bin/bash -n "$script"
done

/usr/bin/plutil -lint "$TEMPLATE" >/dev/null
[ "$(/usr/bin/plutil -extract Label raw -n "$TEMPLATE")" = "com.salutem.channelmax-browser-worker" ] || fail "wrong label"
[ "$(/usr/bin/plutil -extract KeepAlive raw -n "$TEMPLATE")" = "true" ] || fail "KeepAlive must be true"
[ "$(/usr/bin/plutil -extract RunAtLoad raw -n "$TEMPLATE")" = "true" ] || fail "RunAtLoad must be true"
[ "$(/usr/bin/plutil -extract ThrottleInterval raw -n "$TEMPLATE")" = "30" ] || fail "ThrottleInterval must be 30"

assert_absent "$TEMPLATE" 'JACKIE_API_TOKEN'
assert_absent "$TEMPLATE" 'EnvironmentVariables'
assert_contains "$RUNNER" 'https://ss-control-center\.vercel\.app'
assert_contains "$RUNNER" 'imac-channelmax-primary'
assert_contains "$RUNNER" 'CHANNELMAX_CDP_PORT_FIXED="9222"'
assert_contains "$RUNNER" 'exec "\$NODE_BIN" "\$TSX_CLI"'
assert_absent "$RUNNER" 'npx'
assert_absent "$INSTALLER" 'npx'
assert_contains "$RUNNER" 'cdp_unavailable'
assert_contains "$RUNNER" 'security find-generic-password'
assert_contains "$STATUS" 'find-generic-password'
assert_absent "$STATUS" 'find-generic-password[^\n]* -w'

install_block="$(/usr/bin/awk '/^install_agent\(\)/,/^}/ { print }' "$INSTALLER")"
if /usr/bin/printf '%s\n' "$install_block" | rg -q 'launchctl (bootstrap|kickstart)'; then
  fail "install must not load or start launchd"
fi

TEMP_DIR="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/channelmax-ops-test.XXXXXX")"
TEMP_PLIST="$TEMP_DIR/rendered.plist"
cleanup() {
  /bin/rm -f "$TEMP_PLIST"
  /bin/rmdir "$TEMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

/bin/cp "$TEMPLATE" "$TEMP_PLIST"
/usr/bin/plutil -replace ProgramArguments -json '["/bin/bash","/tmp/runtime/run-worker.sh","--app-root","/tmp/app","--node","/tmp/bin/node","--node-version","v25.8.1","--tsx","/tmp/app/node_modules/tsx/dist/cli.mjs","--tsx-version","4.20.6","--python","/usr/bin/python3","--cdp-script","/tmp/scripts/cdp_browser.py","--log-dir","/tmp/logs","--keychain-service","com.salutem.sscc.jackie-api-token","--keychain-account","test-user"]' "$TEMP_PLIST"
/usr/bin/plutil -replace WorkingDirectory -string "/tmp/app" "$TEMP_PLIST"
/usr/bin/plutil -lint "$TEMP_PLIST" >/dev/null
assert_absent "$TEMP_PLIST" '__(RUNNER|APP_ROOT|NODE_BIN|NODE_VERSION|TSX_CLI|TSX_VERSION|PYTHON_BIN|CDP_SCRIPT|LOG_DIR|KEYCHAIN_ACCOUNT)__'

/bin/echo "PASS: ChannelMAX LaunchAgent operational layer is syntactically valid and offline-safe."
