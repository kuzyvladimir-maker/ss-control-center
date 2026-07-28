#!/bin/bash

# Install and operate the per-user LaunchAgent. `install` only writes files;
# starting the service is always a separate explicit action.

set +x
set -euo pipefail
umask 077

readonly SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
readonly APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
readonly LABEL="com.salutem.channelmax-browser-worker"
readonly KEYCHAIN_SERVICE="com.salutem.sscc.jackie-api-token"
readonly KEYCHAIN_ACCOUNT="$(/usr/bin/id -un)"
readonly UID_VALUE="$(/usr/bin/id -u)"
readonly SERVICE_TARGET="gui/$UID_VALUE/$LABEL"
readonly LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
readonly PLIST_PATH="$LAUNCH_AGENTS_DIR/$LABEL.plist"
readonly RUNTIME_DIR="$HOME/Library/Application Support/SS Command Center/channelmax-browser-worker"
readonly RUNTIME_SCRIPT="$RUNTIME_DIR/run-worker.sh"
readonly LOG_DIR="$HOME/Library/Logs/SS Command Center/channelmax-browser-worker"
readonly TEMPLATE_PATH="$SCRIPT_DIR/$LABEL.plist.template"
readonly SOURCE_RUNNER="$SCRIPT_DIR/run-worker.sh"
readonly STATUS_SCRIPT="$SCRIPT_DIR/status.sh"
readonly SSCC_BASE_URL="https://ss-control-center.vercel.app"
readonly WORKER_ID="imac-channelmax-primary"
readonly CDP_PORT="9222"

NODE_BIN=""
NODE_VERSION=""
TSX_CLI=""
TSX_VERSION=""
PYTHON_BIN=""
CDP_SCRIPT=""
TEMP_PLIST=""
TARGET_TEMP=""

cleanup() {
  if [ -n "$TEMP_PLIST" ] && [ -f "$TEMP_PLIST" ]; then
    /bin/rm -f "$TEMP_PLIST"
  fi
  if [ -n "$TARGET_TEMP" ] && [ -f "$TARGET_TEMP" ]; then
    /bin/rm -f "$TARGET_TEMP"
  fi
}
trap cleanup EXIT

die() {
  /bin/echo "ERROR: $1" >&2
  exit "${2:-1}"
}

usage() {
  /bin/echo "Usage: $0 {set-token|install|start|stop|restart|status|doctor|uninstall}"
  /bin/echo "  set-token  Store the existing shared JACKIE_API_TOKEN at a hidden Keychain prompt."
  /bin/echo "  install    Render/copy the LaunchAgent, but do not load or start it."
  /bin/echo "  start      Run fail-closed preflight, then bootstrap the LaunchAgent."
  /bin/echo "  stop       Boot out this exact per-user LaunchAgent."
  /bin/echo "  restart    Stop, preflight, and start the exact LaunchAgent."
  /bin/echo "  status     Read-only health/status checks; never reads the token value."
  /bin/echo "  doctor     Validate installed runtime prerequisites without starting it."
  /bin/echo "  uninstall  Stop and remove the plist/runtime copy; preserve logs and Keychain."
}

is_loaded() {
  /bin/launchctl print "$SERVICE_TARGET" >/dev/null 2>&1
}

keychain_item_exists() {
  /usr/bin/security find-generic-password \
    -a "$KEYCHAIN_ACCOUNT" \
    -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1
}

validate_keychain_token() {
  local token=""
  token="$(/usr/bin/security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)"
  if [ "${#token}" -lt 16 ] || [ "${#token}" -gt 8192 ]; then
    token=""
    die "The Keychain item is missing or does not contain a valid shared token. Run '$0 set-token'."
  fi
  case "$token" in
    *$'\n'*|*$'\r'*)
      token=""
      die "The Keychain token contains a forbidden line break. Run '$0 set-token'."
      ;;
  esac
  token=""
}

set_token() {
  /bin/echo "Store the EXISTING shared JACKIE_API_TOKEN in macOS Keychain."
  /bin/echo "The native prompt is hidden; the token is not placed in argv, plist, shell history, or logs."
  /usr/bin/security add-generic-password \
    -U \
    -a "$KEYCHAIN_ACCOUNT" \
    -s "$KEYCHAIN_SERVICE" \
    -l "SS Command Center shared Jackie API token" \
    -T /usr/bin/security \
    -w
  validate_keychain_token
  /bin/echo "Keychain item is present and structurally valid."
}

resolve_prerequisites() {
  local node_candidate=""
  local python_candidate=""

  [ -f "$SOURCE_RUNNER" ] || die "Missing source runner: $SOURCE_RUNNER"
  [ -f "$TEMPLATE_PATH" ] || die "Missing plist template: $TEMPLATE_PATH"
  [ -f "$STATUS_SCRIPT" ] || die "Missing status script: $STATUS_SCRIPT"

  node_candidate="$(command -v node || true)"
  [ -n "$node_candidate" ] && [ -x "$node_candidate" ] || die "Node.js is unavailable."
  NODE_BIN="$("$node_candidate" -p 'process.execPath')"
  [ -x "$NODE_BIN" ] || die "Resolved Node.js executable is unavailable."
  NODE_VERSION="$("$NODE_BIN" --version)"

  TSX_CLI="$APP_ROOT/node_modules/tsx/dist/cli.mjs"
  [ -f "$TSX_CLI" ] || die "Pinned local tsx CLI is unavailable. Run npm install in $APP_ROOT."
  [ -f "$APP_ROOT/node_modules/tsx/package.json" ] || die "tsx package metadata is unavailable."
  TSX_VERSION="$("$NODE_BIN" -p 'require(process.argv[1]).version' "$APP_ROOT/node_modules/tsx/package.json")"
  [ -n "$TSX_VERSION" ] || die "Could not resolve the local tsx version."

  CDP_SCRIPT="$(cd "$APP_ROOT/../scripts" && pwd -P)/cdp_browser.py"
  [ -f "$CDP_SCRIPT" ] || die "Hardened CDP helper is unavailable: $CDP_SCRIPT"

  for python_candidate in /usr/bin/python3 /opt/homebrew/bin/python3 "$(command -v python3 || true)"; do
    if [ -n "$python_candidate" ] && [ -x "$python_candidate" ] && "$python_candidate" -c 'import websocket' >/dev/null 2>&1; then
      PYTHON_BIN="$python_candidate"
      break
    fi
  done
  [ -n "$PYTHON_BIN" ] || die "No absolute Python 3 executable with websocket-client is available."
}

install_agent() {
  local program_arguments_json=""
  if is_loaded; then
    die "The LaunchAgent is loaded. Run '$0 stop' before replacing its files."
  fi
  resolve_prerequisites
  if ! keychain_item_exists; then
    set_token
  else
    validate_keychain_token
  fi

  /bin/mkdir -p "$LAUNCH_AGENTS_DIR" "$RUNTIME_DIR" "$LOG_DIR"
  /bin/chmod 700 "$RUNTIME_DIR" "$LOG_DIR"
  /usr/bin/install -m 700 "$SOURCE_RUNNER" "$RUNTIME_SCRIPT"

  TEMP_PLIST="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/channelmax-launchagent.XXXXXX")"
  /bin/cp "$TEMPLATE_PATH" "$TEMP_PLIST"
  program_arguments_json="$("$NODE_BIN" -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' \
    /bin/bash \
    "$RUNTIME_SCRIPT" \
    --app-root "$APP_ROOT" \
    --node "$NODE_BIN" \
    --node-version "$NODE_VERSION" \
    --tsx "$TSX_CLI" \
    --tsx-version "$TSX_VERSION" \
    --python "$PYTHON_BIN" \
    --cdp-script "$CDP_SCRIPT" \
    --log-dir "$LOG_DIR" \
    --keychain-service "$KEYCHAIN_SERVICE" \
    --keychain-account "$KEYCHAIN_ACCOUNT")"
  /usr/bin/plutil -replace ProgramArguments -json "$program_arguments_json" "$TEMP_PLIST"
  /usr/bin/plutil -replace WorkingDirectory -string "$APP_ROOT" "$TEMP_PLIST"
  /usr/bin/plutil -lint "$TEMP_PLIST" >/dev/null

  TARGET_TEMP="$LAUNCH_AGENTS_DIR/.$LABEL.plist.$$"
  /usr/bin/install -m 600 "$TEMP_PLIST" "$TARGET_TEMP"
  /bin/mv -f "$TARGET_TEMP" "$PLIST_PATH"
  TARGET_TEMP=""

  /bin/echo "Installed (not started): $PLIST_PATH"
  /bin/echo "Pinned runtime: $NODE_BIN $NODE_VERSION; local tsx $TSX_VERSION"
  /bin/echo "Control plane: $SSCC_BASE_URL; worker: $WORKER_ID; CDP: localhost:$CDP_PORT"
  /bin/echo "Start remains explicit: $0 start"
}

plist_value() {
  /usr/bin/plutil -extract "$1" raw -n "$PLIST_PATH"
}

run_installed_preflight() {
  local runner=""
  local app_root=""
  local node_bin=""
  local node_version=""
  local tsx_cli=""
  local tsx_version=""
  local python_bin=""
  local cdp_script=""
  local log_dir=""
  local keychain_service=""
  local keychain_account=""

  [ -f "$PLIST_PATH" ] || die "LaunchAgent is not installed. Run '$0 install'."
  /usr/bin/plutil -lint "$PLIST_PATH" >/dev/null || die "Installed plist is invalid."
  [ "$(plist_value Label)" = "$LABEL" ] || die "Installed plist label mismatch."
  [ "$(plist_value ProgramArguments.2)" = "--app-root" ] || die "Installed plist argument layout mismatch."
  [ "$(plist_value ProgramArguments.4)" = "--node" ] || die "Installed plist argument layout mismatch."
  [ "$(plist_value ProgramArguments.6)" = "--node-version" ] || die "Installed plist argument layout mismatch."
  [ "$(plist_value ProgramArguments.8)" = "--tsx" ] || die "Installed plist argument layout mismatch."
  [ "$(plist_value ProgramArguments.10)" = "--tsx-version" ] || die "Installed plist argument layout mismatch."
  [ "$(plist_value ProgramArguments.12)" = "--python" ] || die "Installed plist argument layout mismatch."
  [ "$(plist_value ProgramArguments.14)" = "--cdp-script" ] || die "Installed plist argument layout mismatch."
  [ "$(plist_value ProgramArguments.16)" = "--log-dir" ] || die "Installed plist argument layout mismatch."
  [ "$(plist_value ProgramArguments.18)" = "--keychain-service" ] || die "Installed plist argument layout mismatch."
  [ "$(plist_value ProgramArguments.20)" = "--keychain-account" ] || die "Installed plist argument layout mismatch."

  runner="$(plist_value ProgramArguments.1)"
  app_root="$(plist_value ProgramArguments.3)"
  node_bin="$(plist_value ProgramArguments.5)"
  node_version="$(plist_value ProgramArguments.7)"
  tsx_cli="$(plist_value ProgramArguments.9)"
  tsx_version="$(plist_value ProgramArguments.11)"
  python_bin="$(plist_value ProgramArguments.13)"
  cdp_script="$(plist_value ProgramArguments.15)"
  log_dir="$(plist_value ProgramArguments.17)"
  keychain_service="$(plist_value ProgramArguments.19)"
  keychain_account="$(plist_value ProgramArguments.21)"

  [ "$runner" = "$RUNTIME_SCRIPT" ] || die "Installed runner path mismatch."
  [ "$app_root" = "$APP_ROOT" ] || die "Installed application path mismatch. Reinstall from the current checkout."
  [ "$keychain_service" = "$KEYCHAIN_SERVICE" ] || die "Installed Keychain service mismatch."
  [ "$keychain_account" = "$KEYCHAIN_ACCOUNT" ] || die "Installed Keychain account mismatch."

  "$runner" \
    --check-only \
    --app-root "$app_root" \
    --node "$node_bin" \
    --node-version "$node_version" \
    --tsx "$tsx_cli" \
    --tsx-version "$tsx_version" \
    --python "$python_bin" \
    --cdp-script "$cdp_script" \
    --log-dir "$log_dir" \
    --keychain-service "$keychain_service" \
    --keychain-account "$keychain_account" || die "Worker preflight failed. See $LOG_DIR/stderr.log."

  local http_code=""
  http_code="$(/usr/bin/curl --silent --location --output /dev/null --connect-timeout 5 --max-time 10 --write-out '%{http_code}' "$SSCC_BASE_URL/" || true)"
  case "$http_code" in
    2??|3??|4??) ;;
    *) die "SSCC production control plane is unreachable ($http_code)." ;;
  esac
}

start_agent() {
  if is_loaded; then
    /bin/echo "Already loaded: $SERVICE_TARGET"
    "$STATUS_SCRIPT"
    return
  fi
  run_installed_preflight
  /bin/launchctl bootstrap "gui/$UID_VALUE" "$PLIST_PATH"
  /bin/echo "Started: $SERVICE_TARGET"
  /bin/echo "Run '$0 status' to verify health."
}

stop_agent() {
  if ! is_loaded; then
    /bin/echo "Already stopped: $SERVICE_TARGET"
    return
  fi
  /bin/launchctl bootout "$SERVICE_TARGET"
  /bin/echo "Stopped: $SERVICE_TARGET"
}

doctor() {
  run_installed_preflight
  /bin/echo "Preflight passed. No service state was changed."
}

uninstall_agent() {
  stop_agent
  /bin/rm -f "$PLIST_PATH" "$RUNTIME_SCRIPT"
  /bin/rmdir "$RUNTIME_DIR" 2>/dev/null || true
  /bin/echo "Removed the LaunchAgent plist and installed runner copy."
  /bin/echo "Preserved Keychain item '$KEYCHAIN_SERVICE' and logs at '$LOG_DIR'."
}

command_name="${1:-}"
case "$command_name" in
  set-token)
    set_token
    ;;
  install)
    install_agent
    ;;
  start)
    start_agent
    ;;
  stop)
    stop_agent
    ;;
  restart)
    stop_agent
    start_agent
    ;;
  status)
    exec "$STATUS_SCRIPT"
    ;;
  doctor)
    doctor
    ;;
  uninstall)
    uninstall_agent
    ;;
  *)
    usage >&2
    exit 64
    ;;
esac
