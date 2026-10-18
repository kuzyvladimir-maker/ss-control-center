#!/bin/sh
# Claude Code hook (SessionStart / UserPromptSubmit): new answers from Jackie for repo ss-control-center. Silent when empty or offline.
out=$(ssh -o BatchMode=yes -o ConnectTimeout=4 server 'python3 /root/.openclaw/workspace/scripts/repo_jackie.py ss-control-center inbox' 2>/dev/null)
[ -n "$out" ] && printf 'Новые сообщения от Джеки (ящик ss-control-center):\n%s\n' "$out"
exit 0
