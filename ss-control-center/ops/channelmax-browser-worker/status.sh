#!/bin/bash

# Read-only status/health check. It checks only Keychain item metadata and never
# asks Keychain for the token value.

set +x
set -u
umask 077

readonly SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
readonly APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
readonly LABEL="com.salutem.channelmax-browser-worker"
readonly KEYCHAIN_SERVICE="com.salutem.sscc.jackie-api-token"
readonly KEYCHAIN_ACCOUNT="$(/usr/bin/id -un)"
readonly UID_VALUE="$(/usr/bin/id -u)"
readonly SERVICE_TARGET="gui/$UID_VALUE/$LABEL"
readonly PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
readonly RUNTIME_SCRIPT="$HOME/Library/Application Support/SS Command Center/channelmax-browser-worker/run-worker.sh"
readonly LOG_DIR="$HOME/Library/Logs/SS Command Center/channelmax-browser-worker"
readonly SSCC_BASE_URL="https://ss-control-center.vercel.app"
readonly WORKER_ID="imac-channelmax-primary"
readonly CDP_PORT="9222"

QUIET="0"
if [ "${1:-}" = "--quiet" ]; then
  QUIET="1"
elif [ "$#" -ne 0 ]; then
  /bin/echo "Usage: $0 [--quiet]" >&2
  exit 64
fi

say() {
  if [ "$QUIET" = "0" ]; then
    /usr/bin/printf '%-20s %s\n' "$1" "$2"
  fi
}

plist_value() {
  /usr/bin/plutil -extract "$1" raw -n "$PLIST_PATH" 2>/dev/null || true
}

log_metadata() {
  local path="$1"
  local label="$2"
  local metadata=""
  if [ -f "$path" ]; then
    metadata="$(/usr/bin/stat -f '%z bytes; modified %Sm' -t '%Y-%m-%dT%H:%M:%S%z' "$path" 2>/dev/null || /bin/echo 'metadata unavailable')"
    say "$label" "$metadata ($path)"
  else
    say "$label" "not created ($path)"
  fi
}

installed="no"
plist_ok="no"
runtime_ok="no"
keychain_ok="no"
loaded="no"
state="not loaded"
pid="-"
last_exit="-"
cdp_ok="no"
control_plane_ok="no"
http_code="000"

if [ -f "$PLIST_PATH" ]; then
  installed="yes"
  if /usr/bin/plutil -lint "$PLIST_PATH" >/dev/null 2>&1 && \
     [ "$(plist_value Label)" = "$LABEL" ] && \
     [ "$(plist_value ProgramArguments.1)" = "$RUNTIME_SCRIPT" ] && \
     [ "$(plist_value ProgramArguments.3)" = "$APP_ROOT" ] && \
     [ "$(plist_value ProgramArguments.19)" = "$KEYCHAIN_SERVICE" ] && \
     [ "$(plist_value ProgramArguments.21)" = "$KEYCHAIN_ACCOUNT" ]; then
    plist_ok="yes"
  fi
fi

if [ "$plist_ok" = "yes" ]; then
  node_bin="$(plist_value ProgramArguments.5)"
  expected_node="$(plist_value ProgramArguments.7)"
  tsx_cli="$(plist_value ProgramArguments.9)"
  expected_tsx="$(plist_value ProgramArguments.11)"
  python_bin="$(plist_value ProgramArguments.13)"
  cdp_script="$(plist_value ProgramArguments.15)"
  actual_node=""
  actual_tsx=""

  if [ -x "$node_bin" ]; then
    actual_node="$("$node_bin" --version 2>/dev/null || true)"
  fi
  if [ -x "$node_bin" ] && [ -f "$APP_ROOT/node_modules/tsx/package.json" ]; then
    actual_tsx="$("$node_bin" -p 'require(process.argv[1]).version' "$APP_ROOT/node_modules/tsx/package.json" 2>/dev/null || true)"
  fi
  if [ -x "$RUNTIME_SCRIPT" ] && \
     [ -f "$tsx_cli" ] && \
     [ "$actual_node" = "$expected_node" ] && \
     [ "$actual_tsx" = "$expected_tsx" ]; then
    runtime_ok="yes"
  fi

  if [ -x "$python_bin" ] && [ -f "$cdp_script" ] && \
     "$python_bin" -c 'import websocket' >/dev/null 2>&1 && \
     CDP_PORT="$CDP_PORT" "$python_bin" "$cdp_script" ping >/dev/null 2>&1; then
    cdp_ok="yes"
  fi
fi

if /usr/bin/security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1; then
  keychain_ok="yes"
fi

if /bin/launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
  loaded="yes"
  state="$(/bin/launchctl print "$SERVICE_TARGET" 2>/dev/null | /usr/bin/awk -F' = ' '/^[[:space:]]*state = / { gsub(/"/, "", $2); print $2; exit }')"
  pid="$(/bin/launchctl print "$SERVICE_TARGET" 2>/dev/null | /usr/bin/awk -F' = ' '/^[[:space:]]*pid = / { print $2; exit }')"
  last_exit="$(/bin/launchctl print "$SERVICE_TARGET" 2>/dev/null | /usr/bin/awk -F' = ' '/^[[:space:]]*last exit code = / { print $2; exit }')"
  [ -n "$state" ] || state="loaded"
  [ -n "$pid" ] || pid="-"
  [ -n "$last_exit" ] || last_exit="-"
fi

http_code="$(/usr/bin/curl --silent --location --output /dev/null --connect-timeout 5 --max-time 10 --write-out '%{http_code}' "$SSCC_BASE_URL/" 2>/dev/null || true)"
case "$http_code" in
  2??|3??|4??) control_plane_ok="yes" ;;
esac

say "worker" "$WORKER_ID"
say "control plane" "$SSCC_BASE_URL (reachable=$control_plane_ok; http=$http_code)"
say "plist installed" "$installed ($PLIST_PATH)"
say "plist binding" "$plist_ok"
say "runtime pinned" "$runtime_ok"
say "keychain metadata" "$keychain_ok (service=$KEYCHAIN_SERVICE; account=$KEYCHAIN_ACCOUNT)"
say "launchd loaded" "$loaded ($SERVICE_TARGET)"
say "launchd state" "$state (pid=$pid; last_exit=$last_exit)"
say "CDP read-only ping" "$cdp_ok (localhost:$CDP_PORT)"
log_metadata "$LOG_DIR/stdout.log" "stdout log"
log_metadata "$LOG_DIR/stderr.log" "stderr log"

if [ "$installed" != "yes" ]; then
  exit 2
fi
if [ "$plist_ok" = "yes" ] && \
   [ "$runtime_ok" = "yes" ] && \
   [ "$keychain_ok" = "yes" ] && \
   [ "$loaded" = "yes" ] && \
   [ "$state" = "running" ] && \
   [ "$cdp_ok" = "yes" ] && \
   [ "$control_plane_ok" = "yes" ]; then
  exit 0
fi
exit 1
