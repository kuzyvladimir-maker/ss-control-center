/**
 * Exact offline-only ChannelMAX mutation preflight for sealed Uncrustables v10.
 *
 * This command performs no browser, network, database, or external writes. It
 * exits non-zero while any production mutation blocker remains.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildChannelMaxUncrustablesMutationPreflight } from
  "@/lib/channelmax-agent/uncrustables-mutation-preflight";

async function main(): Promise<void> {
  const root = process.cwd();
  const v10 = path.join(
    root,
    "data/repairs/generated/uncrustables-amazon-launch-aware-162-20260718-v10",
  );
  const full = process.argv.slice(2).includes("--full");
  const unsupported = process.argv.slice(2).filter((arg) => arg !== "--full");
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported option(s): ${unsupported.join(", ")}. Only --full is accepted.`,
    );
  }

  const [
    sourcePlanBytes,
    assignmentManifestBytes,
    assignmentTsvBytes,
    inventorySnapshotBytes,
    manualModelDiscoveryBytes,
  ] = await Promise.all([
    readFile(path.join(v10, "URP-20260718T162541078Z-2af6e0a671b7.json")),
    readFile(
      path.join(
        v10,
        "URP-20260718T162541078Z-2af6e0a671b7-channelmax.manifest.json",
      ),
    ),
    readFile(
      path.join(v10, "URP-20260718T162541078Z-2af6e0a671b7-channelmax.txt"),
    ),
    readFile(
      path.join(root, "data/audits/channelmax-live-snapshot-20260718T215936Z.json"),
    ),
    readFile(
      path.join(
        root,
        "data/audits/channelmax-manual-model-discovery-20260718T220023Z.json",
      ),
    ),
  ]);

  const preflight = buildChannelMaxUncrustablesMutationPreflight({
    sourcePlanBytes,
    assignmentManifestBytes,
    assignmentTsvBytes,
    inventorySnapshotBytes,
    manualModelDiscoveryBytes,
  });

  console.log(
    JSON.stringify(
      full
        ? preflight
        : {
          schema_version: preflight.schema_version,
          mode: preflight.mode,
          sha256: preflight.sha256,
          binding: preflight.binding,
          sources: preflight.sources,
          cohort: preflight.cohort,
          diff_summary: preflight.diff_summary,
          canary: {
            sku: preflight.canary.sku,
            asin: preflight.canary.asin,
            assignment_sha256: preflight.canary.assignment_sha256,
            before: {
              minimum_price: preflight.canary.before_minimum_price,
              maximum_price: preflight.canary.before_maximum_price,
            },
            desired: {
              minimum_price: preflight.canary.desired_minimum_price,
              maximum_price: preflight.canary.desired_maximum_price,
            },
            mutation_execution_allowed:
              preflight.canary.mutation_execution_allowed,
          },
          rollback: {
            bounds_captured_rows: preflight.rollback.bounds_captured_rows,
            manual_model_restore_rows:
              preflight.rollback.manual_model_restore_rows,
            default_model_restore_rows:
              preflight.rollback.default_model_restore_rows,
            default_model_restore_status:
              preflight.rollback.default_model_restore_status,
            complete: preflight.rollback.complete,
          },
          ambiguity_policy: preflight.ambiguity_policy,
          blockers: preflight.blockers,
          mutation_execution_allowed: preflight.mutation_execution_allowed,
          },
      null,
      2,
    ),
  );

  if (!preflight.mutation_execution_allowed) process.exitCode = 3;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
