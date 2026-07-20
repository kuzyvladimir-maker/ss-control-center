/**
 * Offline drift census for the sealed 2026-07-19 v3 base-offer plan: for every
 * plan action, try a 1-SKU rollback binding against a fresh snapshot. The
 * engine's own CAS (assertEntryMatchesFreshSnapshot inside
 * createBaseOfferRollbackBinding) is the oracle — an action that binds is
 * repairable now; one that throws has drifted from the plan's "before" state
 * and needs a re-planned repair. No Amazon/DB writes.
 *
 * Usage:
 *   npx tsx scripts/check-uncrustables-base-offer-drift.ts --snapshot=PATH
 */
import { readFile, writeFile } from "node:fs/promises";
import {
  createBaseOfferLiveSelection,
  createBaseOfferRollbackBinding,
} from "../src/lib/bundle-factory/repair/uncrustables-base-offer-live-contract";

const SOURCE_DIR =
  "data/repairs/base-offer-preserve/uncrustables-base-offer-preserve-20260719-v3";

async function main(): Promise<void> {
  const snapshotPath = process.argv
    .slice(2)
    .find((a) => a.startsWith("--snapshot="))
    ?.slice("--snapshot=".length);
  if (!snapshotPath) throw new Error("--snapshot is required.");

  const [planBytes, fullBytes, snapshotBytes] = await Promise.all([
    readFile(`${SOURCE_DIR}/base-offer-preserve-plan.json`),
    readFile(`${SOURCE_DIR}/base-offer-preserve-selection.json`),
    readFile(snapshotPath),
  ]);
  const plan = JSON.parse(planBytes.toString("utf8"));
  const fullSelection = JSON.parse(fullBytes.toString("utf8"));
  const snapshot = JSON.parse(snapshotBytes.toString("utf8"));

  const clean: string[] = [];
  const drifted: Array<{ action_id: string; reason: string }> = [];
  for (const actionId of fullSelection.selected_action_ids as string[]) {
    try {
      const selection = createBaseOfferLiveSelection({
        plan,
        fullSelection,
        kind: "CANARY", // 1-SKU probe; kind irrelevant for the CAS check
        actionIds: [actionId],
      });
      createBaseOfferRollbackBinding({
        plan,
        fullSelection,
        liveSelection: selection,
        snapshotPath,
        snapshotBytes,
        snapshot,
        now: new Date(),
      });
      clean.push(actionId);
    } catch (error) {
      drifted.push({
        action_id: actionId,
        reason: (error instanceof Error ? error.message : String(error)).slice(0, 140),
      });
    }
  }

  console.log(`clean (bindable now): ${clean.length}`);
  console.log(`drifted (need re-plan): ${drifted.length}`);
  for (const d of drifted) console.log(`  ${d.action_id}\n    ${d.reason}`);
  await writeFile(
    "data/repairs/base-offer-preserve/drift-census.json",
    `${JSON.stringify({ snapshot: snapshotPath, clean, drifted }, null, 2)}\n`,
  );
  console.log("wrote data/repairs/base-offer-preserve/drift-census.json");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
