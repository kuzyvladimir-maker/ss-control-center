#!/bin/bash
# Непрерывный конвейер batch-200. Перезапускает _b2_auto.ts, пока очередь не
# опустеет. Падение внутри одной итерации не убивает цикл — состояние в
# data/batch200/auto-state.json, следующий заход продолжит с того же места.
cd "/Users/vladimirkuznetsov/SS Command Center/ss-control-center"
LOG="data/batch200/auto-loop.log"
LOCK="data/batch200/auto.lock"

# один экземпляр за раз
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "[$(date +%H:%M)] уже работает (pid $(cat "$LOCK"))" >> "$LOG"
  exit 0
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

echo "[$(date +%H:%M)] --- цикл стартовал ---" >> "$LOG"
while true; do
  OUT=$(LIMIT=10 npx tsx scripts/_b2_auto.ts 2>&1)
  echo "$OUT" | grep -E "^\[auto\]|✓ ОПУБЛИКОВАН|✗" >> "$LOG"
  if echo "$OUT" | grep -q "ALL-DONE"; then
    echo "[$(date +%H:%M)] === ВСЕ 200 ГОТОВЫ ===" >> "$LOG"
    break
  fi
  sleep 5
done
