#!/usr/bin/env bash
# One-command owner-executed Uncrustables base-offer repair (sealed engine).
#
# Runs 4 rounds — LK canary (1 SKU), then waves of 54/54/52 — and for EACH round:
#   1. captures a fresh read-only 164-row SP-API snapshot (30-min validity)
#   2. builds the sealed rollback binding for that round's selection
#   3. materializes the owner authorization (TTL 12 min, hash-bound to this round)
#   4. derives the preview arm token and runs the non-mutating VALIDATION PREVIEW
#   5. derives the apply arm token and runs APPLY (CAS + one attempt + readback)
# Any failure stops the whole run immediately (set -e). Sale prices, coupons and
# list_price are structurally out of scope of the sealed plan (preserve profile).
#
# Usage:  bash scripts/run-uncrustables-base-offer-repair.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PLAN=data/repairs/base-offer-preserve/uncrustables-base-offer-preserve-20260719-v3/base-offer-preserve-plan.json
FULL=data/repairs/base-offer-preserve/uncrustables-base-offer-preserve-20260719-v3/base-offer-preserve-selection.json
ARM_ENV=BF_UNCRUSTABLES_AMAZON_BASE_OFFER_PRESERVE_LIVE_ARM

# canary (LK-AS7X-K43B) applied + verified live 2026-07-20T01:58Z: 76.99/66.95/76.99 + B2B.
ROUNDS=(
  "wave1:data/repairs/base-offer-preserve/waves-20260719/live-selection-wave-1.json"
  "wave2:data/repairs/base-offer-preserve/waves-20260719/live-selection-wave-2.json"
  "wave3:data/repairs/base-offer-preserve/waves-20260719/live-selection-wave-3.json"
)

json_field() { # file key -> value (python, no jq dependency)
  python3 -c "import json,sys;s=open(sys.argv[1]).read();print(json.loads(s[s.index('{'):]).get(sys.argv[2],''))" "$1" "$2"
}

for round in "${ROUNDS[@]}"; do
  LABEL="${round%%:*}"
  SEL="${round#*:}"
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  OUTDIR="data/repairs/base-offer-preserve/live-run-${LABEL}-${STAMP}"
  mkdir -p "$OUTDIR"
  echo ""
  echo "════════════════ ROUND ${LABEL} (${SEL}) ════════════════"

  echo "── [1/5] fresh 164-row snapshot (read-only)…"
  npx tsx scripts/prepare-uncrustables-amazon-rollback.ts --capture-live --no-download-images \
    > "$OUTDIR/snapshot-capture.log" 2>&1 || { tail -5 "$OUTDIR/snapshot-capture.log"; exit 1; }
  SNAP="$(ls -t data/repairs/rollback/UAPS-*.json | head -1)"
  echo "    snapshot: $SNAP"

  echo "── [2/5] rollback binding…"
  npx tsx scripts/build-uncrustables-base-offer-rollback-binding.ts \
    --snapshot="$SNAP" --plan="$PLAN" --full-selection="$FULL" \
    --live-selection="$SEL" --output-dir="$OUTDIR/binding" \
    > "$OUTDIR/binding.log" 2>&1 || { tail -5 "$OUTDIR/binding.log"; exit 1; }
  BIND="$OUTDIR/binding/rollback-binding.json"

  echo "── [3/5] owner authorization (TTL 12m)…"
  npx tsx scripts/author-uncrustables-base-offer-authorization.ts \
    --live-selection="$SEL" --snapshot="$SNAP" --rollback-binding="$BIND" \
    --output="$OUTDIR/owner-authorization.json" \
    | sed 's/^/    /'
  AUTH="$OUTDIR/owner-authorization.json"

  echo "── [4/5] validation preview (non-mutating)…"
  npx tsx scripts/derive-uncrustables-base-offer-live-arm.ts --mode=preview \
    --plan="$PLAN" --full-selection="$FULL" --live-selection="$SEL" \
    --snapshot="$SNAP" --rollback-binding="$BIND" \
    2>/dev/null | python3 -c "import json,sys;s=sys.stdin.read();print(json.loads(s[s.index('{'):])['confirmation_token'])" > "$OUTDIR/preview.token"
  PTOKEN="$(cat "$OUTDIR/preview.token")"
  env "$ARM_ENV=$PTOKEN" npx tsx scripts/execute-uncrustables-base-offer-live.ts \
    --mode=preview --snapshot="$SNAP" --rollback-binding="$BIND" --live-selection="$SEL" \
    --checkpoint-dir="$OUTDIR/checkpoints-preview" --confirm="$PTOKEN" \
    > "$OUTDIR/preview.json" 2>"$OUTDIR/preview.err" || { tail -5 "$OUTDIR/preview.err"; exit 1; }
  PV="$(json_field "$OUTDIR/preview.json" preview_valid_actions)"
  SELN="$(json_field "$OUTDIR/preview.json" selected_actions)"
  echo "    preview_valid: $PV / $SELN"
  [ "$PV" = "$SELN" ] || { echo "PREVIEW MISMATCH — stopping."; exit 1; }

  echo "── [5/5] APPLY…"
  npx tsx scripts/derive-uncrustables-base-offer-live-arm.ts --mode=apply \
    --plan="$PLAN" --full-selection="$FULL" --live-selection="$SEL" \
    --snapshot="$SNAP" --rollback-binding="$BIND" --authorization="$AUTH" \
    2>/dev/null | python3 -c "import json,sys;s=sys.stdin.read();print(json.loads(s[s.index('{'):])['confirmation_token'])" > "$OUTDIR/apply.token"
  ATOKEN="$(cat "$OUTDIR/apply.token")"
  env "$ARM_ENV=$ATOKEN" npx tsx scripts/execute-uncrustables-base-offer-live.ts \
    --mode=apply --snapshot="$SNAP" --rollback-binding="$BIND" --live-selection="$SEL" \
    --authorization="$AUTH" \
    --checkpoint-dir="$OUTDIR/checkpoints-apply" --confirm="$ATOKEN" \
    --readback-attempts=12 --readback-delay-ms=10000 \
    > "$OUTDIR/apply.json" 2>"$OUTDIR/apply.err" || { tail -8 "$OUTDIR/apply.err"; exit 1; }
  VOK="$(json_field "$OUTDIR/apply.json" verified_actions)"
  AOK="$(json_field "$OUTDIR/apply.json" already_applied_actions)"
  STOPPED="$(json_field "$OUTDIR/apply.json" stopped_early)"
  DONE_N=$((VOK + AOK))
  echo "    verified: $VOK  already_applied: $AOK  (=$DONE_N / $SELN)   stopped_early: $STOPPED"
  cat "$OUTDIR/apply.json"
  if [ "$STOPPED" != "False" ] && [ "$STOPPED" != "false" ]; then
    echo "ROUND ${LABEL} STOPPED EARLY — not continuing to the next round."
    exit 1
  fi
  [ "$DONE_N" = "$SELN" ] || { echo "APPLY VERIFICATION INCOMPLETE — stopping."; exit 1; }
done

echo ""
echo "ALL WAVES DONE (161/161 incl. canary). Tell Claude to run the post-repair audit."
