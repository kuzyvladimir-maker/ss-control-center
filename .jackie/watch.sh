#!/bin/sh
# Claude Code background listener for Jackie, repo ss-control-center. Blocks on the server's inotify (no timer, no AI tokens) and EXITS
# the moment Jackie writes to the ss-control-center mailbox, printing the message: the exit wakes Claude. Claude acts, then starts it again.
while :; do
  out=$(ssh -o BatchMode=yes -o ServerAliveInterval=60 -o ServerAliveCountMax=3 server \
        'python3 /root/.openclaw/workspace/scripts/repo_jackie.py ss-control-center wait 86400' 2>/dev/null)
  case "$out" in
    ''|timeout) sleep 60 ;;
    *) printf 'Сообщение от Джеки:\n%s\n' "$out"; exit 0 ;;
  esac
done
