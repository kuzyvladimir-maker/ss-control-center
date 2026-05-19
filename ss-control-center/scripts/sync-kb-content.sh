#!/usr/bin/env bash
# Sync the marketplace-rules KB into ss-control-center for runtime use.
#
# We bake the KB into the app folder because Vercel's build container
# starts inside `ss-control-center/` and can't see sibling directories.
# Run this after editing `docs/marketplace-rules/<channel>/*.md` so the
# baked copy follows the source.
#
# Usage (from repo root or ss-control-center/):
#   bash scripts/sync-kb-content.sh

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$APP_ROOT/.." && pwd)"

SRC="$REPO_ROOT/docs/marketplace-rules"
DST="$APP_ROOT/src/lib/bundle-factory/kb-content"

if [ ! -d "$SRC" ]; then
  echo "Source KB not found: $SRC"
  exit 1
fi

mkdir -p "$DST/amazon" "$DST/walmart"

AMAZON_FILES=(
  "title-policy.md"
  "bullet-points-policy.md"
  "description-policy.md"
  "gift-set-policy.md"
)
WALMART_FILES=(
  "title-policy.md"
  "food-gift-baskets-deep-dive.md"
  "category-grocery.md"
  "multipack-policy.md"
)

for f in "${AMAZON_FILES[@]}"; do
  cp -v "$SRC/amazon/$f" "$DST/amazon/$f"
done
for f in "${WALMART_FILES[@]}"; do
  cp -v "$SRC/walmart/$f" "$DST/walmart/$f"
done

echo
echo "✓ KB content synced into $DST"
