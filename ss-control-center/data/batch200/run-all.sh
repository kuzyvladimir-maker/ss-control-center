#!/bin/bash
cd "/Users/vladimirkuznetsov/SS Command Center/ss-control-center"
i=1
while IFS= read -r slugs; do
  RUN="c$i" SLUGS="$slugs" npx tsx scripts/_b2_composite.ts > "data/batch200/c$i.log" 2>&1
  echo "batch $i done: $(grep -c '^✓' data/batch200/c$i.log) passed"
  i=$((i+1))
done < data/batch200/batches.txt
echo "ALL-BATCHES-COMPLETE"
