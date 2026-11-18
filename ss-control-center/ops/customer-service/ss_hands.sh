#!/usr/bin/env bash
# Local RDP hands for the Salutem Seller-Ops VPS. Only :92 and these two
# systemd units are managed here; no account/browser data is changed.
set -euo pipefail

readonly DISP=:92
readonly ENV_FILE=/root/.openclaw/workspace/.secrets/ss_vps.env
readonly XVFB_UNIT=ss-hands-xvfb.service
readonly RDP_UNIT=ss-hands-rdp.service
readonly LOCK_FILE=/run/lock/ss-hands.lock
readonly RDP_LOG=/var/log/ss-hands-rdp.log
readonly SCRIPT_PATH=$(readlink -f "$0")
export DISPLAY="$DISP"
readonly LEASE=/root/.openclaw/workspace/scripts/ss_screen_lease.py
lease_check() { python3 "$LEASE" check --owner "${SS_SCREEN_OWNER:-}" --mode worker; }

unit_active() { systemctl is-active --quiet "$1"; }
unit_pid() { systemctl show --value -p MainPID "$1" 2>/dev/null || echo 0; }
# Only the VPS address is read from the env file — never the password.
vps_ip() { sed -n 's/^SS_VPS_IP=["'"'"']\{0,1\}\([^"'"'"']*\).*/\1/p' "$ENV_FILE" | head -1; }

status() {
  local unit state pid ip
  for unit in "$XVFB_UNIT" "$RDP_UNIT"; do
    state=$(systemctl is-active "$unit" 2>/dev/null || true)
    pid=$(unit_pid "$unit")
    printf '%s: %s pid=%s\n' "$unit" "${state:-not-found}" "${pid:-0}"
  done
  # Last xfreerdp exit as systemd recorded it for the transient unit.
  printf 'rdp last exit: %s\n' "$(systemctl show -p Result -p ExecMainCode -p ExecMainStatus -p NRestarts -p ExecMainExitTimestamp "$RDP_UNIT" 2>/dev/null | tr '\n' ' ')"
  if xdpyinfo -display "$DISP" >/dev/null 2>&1; then echo "xvfb display $DISP: answering"; else echo "xvfb display $DISP: NOT answering"; fi
  ip=$(vps_ip)
  if [[ -n "$ip" ]] && timeout 3 bash -c "</dev/tcp/$ip/3389" 2>/dev/null; then
    echo 'vps tcp/3389: reachable'
  else
    echo 'vps tcp/3389: NOT reachable'
  fi
  if unit_active "$RDP_UNIT" && unit_active "$XVFB_UNIT" && xdpyinfo -display "$DISP" >/dev/null 2>&1; then
    echo 'transport: connected (Seller Central content NOT verified)'
  else
    echo 'transport: unavailable'
  fi
  if [[ -s "$RDP_LOG" ]]; then echo "rdp log tail ($RDP_LOG):"; tail -n 5 "$RDP_LOG"; fi
  echo "logs: journalctl -u $XVFB_UNIT -u $RDP_UNIT -n 50 --no-pager"
}

# Internal service entry point. The secret is read inside systemd's service,
# never passed to systemd-run or stored in a unit property.
if [[ "${1:-}" == _run_rdp ]]; then
  lease_check
  export HOME=/root XDG_RUNTIME_DIR=/run/user/0
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  : "${SS_VPS_IP:?}" "${SS_VPS_USER:?}" "${SS_VPS_PASS:?}"
  # Timestamped stderr + explicit exit status, both to the journal and to
  # $RDP_LOG (the password is passed as an argument only, never logged).
  ts() { while IFS= read -r line; do printf '%s %s\n' "$(date -Is)" "$line"; done; }
  printf '%s xfreerdp starting -> %s as %s\n' "$(date -Is)" "$SS_VPS_IP" "$SS_VPS_USER" | tee -a "$RDP_LOG" >&2
  set +e
  /usr/bin/xfreerdp /v:"$SS_VPS_IP" /u:"$SS_VPS_USER" /p:"$SS_VPS_PASS" /cert:fingerprint:sha256:FFEDD80E08EE13D0AB30AF4A969E4B768F1163853532D3B47B027E59D6A6C1BF \
    /size:1366x768 /bpp:32 +clipboard -themes -wallpaper -auto-reconnect /log-level:ERROR \
    /drive:uploads,/root/.openclaw/workspace/media 2> >(ts | tee -a "$RDP_LOG" >&2)
  rc=$?
  set -e
  printf '%s xfreerdp exited rc=%s\n' "$(date -Is)" "$rc" | tee -a "$RDP_LOG" >&2
  exit "$rc"
fi

cmd="${1:-status}"
shift || true
case "$cmd" in
  up)
    lease_check
    exec 9>"$LOCK_FILE"
    flock -x 9
    if ! unit_active "$XVFB_UNIT"; then
      # Refuse to take over another desktop on :92.
      if xdpyinfo -display "$DISP" >/dev/null 2>&1; then
        echo "display $DISP is already owned outside $XVFB_UNIT" >&2
        exit 1
      fi
      display_pid=
      if [[ -r /tmp/.X92-lock ]]; then
        display_pid=$(tr -dc '0-9' </tmp/.X92-lock)
      fi
      if [[ -n "$display_pid" ]] && kill -0 "$display_pid" 2>/dev/null; then
        echo "display $DISP lock belongs to live pid $display_pid" >&2
        exit 1
      fi
      # Xvfb can leave both files after an unclean death; no live X server
      # or lock owner exists at this point.
      rm -f /tmp/.X92-lock /tmp/.X11-unix/X92
      systemctl reset-failed "$XVFB_UNIT" 2>/dev/null || true
      systemd-run --unit="$XVFB_UNIT" --description='Salutem hands Xvfb :92' \
        --property=Restart=on-failure --property=RestartSec=5 \
        --property=StandardOutput=journal --property=StandardError=journal \
        /usr/bin/Xvfb "$DISP" -screen 0 1366x768x24 >/dev/null
    fi
    for _ in {1..30}; do
      if unit_active "$XVFB_UNIT" && xdpyinfo -display "$DISP" >/dev/null 2>&1; then break; fi
      sleep 0.2
    done
    if ! unit_active "$XVFB_UNIT" || ! xdpyinfo -display "$DISP" >/dev/null 2>&1; then
      echo "Xvfb $DISP failed; inspect journalctl -u $XVFB_UNIT" >&2
      exit 1
    fi
    if ! unit_active "$RDP_UNIT"; then
      systemctl reset-failed "$RDP_UNIT" 2>/dev/null || true
      systemd-run --unit="$RDP_UNIT" --description='Salutem hands RDP session' \
        --property=Restart=no --setenv="SS_SCREEN_OWNER=$SS_SCREEN_OWNER" \
        --property=StartLimitIntervalSec=120 --property=StartLimitBurst=3 \
        --property=StandardOutput=journal --property=StandardError=journal \
        "$SCRIPT_PATH" _run_rdp >/dev/null
    fi
    sleep 2
    status
    unit_active "$RDP_UNIT" || { echo "RDP exited; inspect journalctl -u $RDP_UNIT" >&2; exit 1; }
    ;;
  down)
    python3 "$LEASE" check --owner "${SS_SCREEN_OWNER:-}"
    exec 9>"$LOCK_FILE"
    flock -x 9
    systemctl stop "$RDP_UNIT" 2>/dev/null || true
    systemctl stop "$XVFB_UNIT" 2>/dev/null || true
    status
    ;;
  status) status ;;
  logs) journalctl -u "$XVFB_UNIT" -u "$RDP_UNIT" -n "${1:-50}" --no-pager ;;
  shot) lease_check; f="${1:-/tmp/ss_shot.png}"; import -window root "$f" && echo "$f" ;;
  click) lease_check; xdotool mousemove "$1" "$2" click 1; echo "click $1 $2" ;;
  dclick) lease_check; xdotool mousemove "$1" "$2" click --repeat 2 --delay 120 1; echo "dclick $1 $2" ;;
  type) lease_check; xdotool type --delay 40 "$1"; echo typed ;;
  key) lease_check; xdotool key "$@"; echo "key $*" ;;
  scroll) lease_check; n="${1:-5}"; for ((i=0; i<n; i++)); do xdotool mousemove 680 400 click 5; done; echo "scrolled $n" ;;
  *) echo "usage: $0 {up|down|status|logs [lines]|shot [file]|click X Y|dclick X Y|type TEXT|key KEYS|scroll N}" >&2; exit 2 ;;
esac
