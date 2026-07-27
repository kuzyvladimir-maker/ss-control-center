#!/bin/bash

# LaunchAgent entrypoint for the supervised, read-only ChannelMAX browser worker.
# The shared Jackie token is read from the login Keychain and is never accepted
# as an argument, written to a plist, or printed.

set +x
set -u
umask 077

readonly SSCC_BASE_URL_FIXED="https://ss-control-center.vercel.app"
readonly CHANNELMAX_WORKER_ID_FIXED="imac-channelmax-primary"
readonly CHANNELMAX_CDP_PORT_FIXED="9222"
readonly MAX_LOG_BYTES="5242880"
readonly LOG_ARCHIVES="5"

APP_ROOT=""
NODE_BIN=""
EXPECTED_NODE_VERSION=""
TSX_CLI=""
EXPECTED_TSX_VERSION=""
PYTHON_BIN=""
CDP_SCRIPT=""
LOG_DIR=""
KEYCHAIN_SERVICE=""
KEYCHAIN_ACCOUNT=""
CHECK_ONLY="0"

usage() {
  /bin/echo "Usage: run-worker.sh [--check-only] --app-root PATH --node PATH --node-version VERSION --tsx PATH --tsx-version VERSION --python PATH --cdp-script PATH --log-dir PATH --keychain-service NAME --keychain-account NAME" >&2
}

require_value() {
  if [ "$#" -lt 2 ] || [ -z "$2" ]; then
    usage
    exit 64
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check-only)
      CHECK_ONLY="1"
      shift
      ;;
    --app-root)
      require_value "$@"
      APP_ROOT="$2"
      shift 2
      ;;
    --node)
      require_value "$@"
      NODE_BIN="$2"
      shift 2
      ;;
    --node-version)
      require_value "$@"
      EXPECTED_NODE_VERSION="$2"
      shift 2
      ;;
    --tsx)
      require_value "$@"
      TSX_CLI="$2"
      shift 2
      ;;
    --tsx-version)
      require_value "$@"
      EXPECTED_TSX_VERSION="$2"
      shift 2
      ;;
    --python)
      require_value "$@"
      PYTHON_BIN="$2"
      shift 2
      ;;
    --cdp-script)
      require_value "$@"
      CDP_SCRIPT="$2"
      shift 2
      ;;
    --log-dir)
      require_value "$@"
      LOG_DIR="$2"
      shift 2
      ;;
    --keychain-service)
      require_value "$@"
      KEYCHAIN_SERVICE="$2"
      shift 2
      ;;
    --keychain-account)
      require_value "$@"
      KEYCHAIN_ACCOUNT="$2"
      shift 2
      ;;
    *)
      usage
      exit 64
      ;;
  esac
done

for required_path in "$APP_ROOT" "$NODE_BIN" "$TSX_CLI" "$PYTHON_BIN" "$CDP_SCRIPT" "$LOG_DIR"; do
  case "$required_path" in
    /*) ;;
    *)
      /bin/echo "All worker paths must be absolute." >&2
      exit 64
      ;;
  esac
done

if [ -z "$EXPECTED_NODE_VERSION" ] || [ -z "$EXPECTED_TSX_VERSION" ] || [ -z "$KEYCHAIN_SERVICE" ] || [ -z "$KEYCHAIN_ACCOUNT" ]; then
  usage
  exit 64
fi

rotate_log() {
  local file="$1"
  local bytes="0"
  local suffix=""
  local prior=""

  if [ ! -f "$file" ]; then
    return 0
  fi
  bytes="$(/usr/bin/stat -f '%z' "$file" 2>/dev/null || /bin/echo 0)"
  case "$bytes" in
    ''|*[!0-9]*) bytes="0" ;;
  esac
  if [ "$bytes" -lt "$MAX_LOG_BYTES" ]; then
    return 0
  fi

  /bin/rm -f "${file}.${LOG_ARCHIVES}"
  suffix="$((LOG_ARCHIVES - 1))"
  while [ "$suffix" -ge 1 ]; do
    prior="${file}.${suffix}"
    if [ -f "$prior" ]; then
      /bin/mv -f "$prior" "${file}.$((suffix + 1))"
    fi
    suffix="$((suffix - 1))"
  done
  /bin/mv -f "$file" "${file}.1"
}

/bin/mkdir -p "$LOG_DIR" || exit 73
/bin/chmod 700 "$LOG_DIR" || exit 73
rotate_log "$LOG_DIR/stdout.log"
rotate_log "$LOG_DIR/stderr.log"
exec >>"$LOG_DIR/stdout.log" 2>>"$LOG_DIR/stderr.log"

log_event() {
  local level="$1"
  local event="$2"
  /usr/bin/printf '{"time":"%s","level":"%s","event":"%s","worker_id":"%s"}\n' \
    "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    "$level" \
    "$event" \
    "$CHANNELMAX_WORKER_ID_FIXED"
}

fail_closed() {
  local event="$1"
  local exit_code="${2:-78}"
  log_event "error" "$event" >&2
  exit "$exit_code"
}

log_event "info" "launcher_preflight_started"

[ -d "$APP_ROOT" ] || fail_closed "app_root_unavailable"
[ -f "$APP_ROOT/scripts/channelmax-browser-worker.ts" ] || fail_closed "worker_source_unavailable"
[ -x "$NODE_BIN" ] || fail_closed "node_unavailable"
[ -f "$TSX_CLI" ] || fail_closed "tsx_cli_unavailable"
[ -x "$PYTHON_BIN" ] || fail_closed "python_unavailable"
[ -f "$CDP_SCRIPT" ] || fail_closed "cdp_helper_unavailable"

ACTUAL_NODE_VERSION="$("$NODE_BIN" --version 2>/dev/null || true)"
if [ "$ACTUAL_NODE_VERSION" != "$EXPECTED_NODE_VERSION" ]; then
  fail_closed "node_version_mismatch"
fi

TSX_PACKAGE_JSON="$APP_ROOT/node_modules/tsx/package.json"
[ -f "$TSX_PACKAGE_JSON" ] || fail_closed "tsx_package_unavailable"
ACTUAL_TSX_VERSION="$("$NODE_BIN" -p 'require(process.argv[1]).version' "$TSX_PACKAGE_JSON" 2>/dev/null || true)"
if [ "$ACTUAL_TSX_VERSION" != "$EXPECTED_TSX_VERSION" ]; then
  fail_closed "tsx_version_mismatch"
fi

"$PYTHON_BIN" -c 'import websocket' >/dev/null 2>&1 || fail_closed "python_websocket_unavailable"
CDP_PORT="$CHANNELMAX_CDP_PORT_FIXED" "$PYTHON_BIN" "$CDP_SCRIPT" ping >/dev/null 2>&1 || fail_closed "cdp_unavailable" 75

JACKIE_TOKEN="$(/usr/bin/security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)"
if [ "${#JACKIE_TOKEN}" -lt 16 ] || [ "${#JACKIE_TOKEN}" -gt 8192 ]; then
  JACKIE_TOKEN=""
  fail_closed "keychain_token_missing_or_invalid"
fi
case "$JACKIE_TOKEN" in
  *$'\n'*|*$'\r'*)
    JACKIE_TOKEN=""
    fail_closed "keychain_token_missing_or_invalid"
    ;;
esac

log_event "info" "launcher_preflight_succeeded"
if [ "$CHECK_ONLY" = "1" ]; then
  JACKIE_TOKEN=""
  exit 0
fi

export HOME
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export NODE_ENV="production"
export SSCC_BASE_URL="$SSCC_BASE_URL_FIXED"
export CHANNELMAX_WORKER_ID="$CHANNELMAX_WORKER_ID_FIXED"
export CHANNELMAX_CDP_PORT="$CHANNELMAX_CDP_PORT_FIXED"
export CHANNELMAX_CDP_SCRIPT_PATH="$CDP_SCRIPT"
export CHANNELMAX_PYTHON_EXECUTABLE="$PYTHON_BIN"
export JACKIE_API_TOKEN="$JACKIE_TOKEN"
unset JACKIE_TOKEN
unset CHANNELMAX_ALLOW_HTTP_LOCALHOST
unset OPENAI_API_KEY
unset CODEX_API_KEY
unset ANTHROPIC_API_KEY

log_event "info" "worker_exec_started"
exec "$NODE_BIN" "$TSX_CLI" "$APP_ROOT/scripts/channelmax-browser-worker.ts"
