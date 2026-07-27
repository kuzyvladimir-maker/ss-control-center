#!/usr/bin/env node

/**
 * Offline/local-only disposition for the exact QX OFFER accepted by Amazon and
 * subsequently proven overwritten by ChannelMAX. This file deliberately has no
 * Amazon, ChannelMAX browser, network, dotenv, or credentials imports.
 *
 * Default mode creates an immutable proposal only. --apply-disposition appends
 * one terminal checkpoint after re-reading every exact evidence file; it does
 * not delete or release the pending mutation fence. --release-fence is a
 * separate exact-confirmation step with immutable armed/released checkpoints.
 */

import path from "node:path";

import {
  applyExternalOverwriteDisposition,
  buildExternalOverwriteDispositionProposal,
  releaseExternalOverwriteDispositionFence,
  writeExternalOverwriteDispositionProposal,
} from "@/lib/bundle-factory/repair/uncrustables-external-overwrite-disposition";
import {
  externalOverwriteFenceReleaseConfirmationToken,
} from "@/lib/bundle-factory/repair/uncrustables-external-overwrite-disposition-contract";

interface Options {
  planPath: string | null;
  selectionPath: string | null;
  settlementPath: string | null;
  channelmaxPostwritePath: string | null;
  checkpointRoot: string | null;
  coordinationDir: string | null;
  outputDir: string | null;
  applyDisposition: boolean;
  releaseFence: boolean;
  proposalPath: string | null;
  confirmation: string | null;
}

function usage(): string {
  return [
    "QX external-overwrite disposition (offline/local only)",
    "",
    "Build immutable proposal (default; journal and fence remain unchanged):",
    "  node --import tsx scripts/disposition-uncrustables-qx-external-overwrite.ts \\",
    "    --plan=PATH --execution-selection=PATH --settlement-checkpoint=PATH \\",
    "    --channelmax-postwrite=PATH --out=NEW_DIRECTORY",
    "",
    "Explicitly append terminal checkpoint (still zero network; fence preserved):",
    "  node --import tsx scripts/disposition-uncrustables-qx-external-overwrite.ts \\",
    "    --apply-disposition --proposal=PATH --confirm=EXACT_TOKEN",
    "",
    "Explicitly release the already-terminal fence (separate confirmation):",
    "  node --import tsx scripts/disposition-uncrustables-qx-external-overwrite.ts \\",
    "    --release-fence --proposal=PATH --confirm=EXACT_RELEASE_TOKEN",
    "",
    "Optional test/isolated roots:",
    "  --checkpoint-root=PATH --coordination-dir=PATH",
    "",
    "Fence release is impossible in proposal/apply mode and always writes armed/released evidence.",
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    planPath: null,
    selectionPath: null,
    settlementPath: null,
    channelmaxPostwritePath: null,
    checkpointRoot: null,
    coordinationDir: null,
    outputDir: null,
    applyDisposition: false,
    releaseFence: false,
    proposalPath: null,
    confirmation: null,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--apply-disposition") {
      options.applyDisposition = true;
    } else if (arg === "--release-fence") {
      options.releaseFence = true;
    } else if (arg.startsWith("--plan=")) {
      options.planPath = arg.slice("--plan=".length).trim();
    } else if (arg.startsWith("--execution-selection=")) {
      options.selectionPath = arg.slice("--execution-selection=".length).trim();
    } else if (arg.startsWith("--settlement-checkpoint=")) {
      options.settlementPath = arg.slice("--settlement-checkpoint=".length).trim();
    } else if (arg.startsWith("--channelmax-postwrite=")) {
      options.channelmaxPostwritePath = arg.slice("--channelmax-postwrite=".length).trim();
    } else if (arg.startsWith("--checkpoint-root=")) {
      options.checkpointRoot = arg.slice("--checkpoint-root=".length).trim();
    } else if (arg.startsWith("--coordination-dir=")) {
      options.coordinationDir = arg.slice("--coordination-dir=".length).trim();
    } else if (arg.startsWith("--out=")) {
      options.outputDir = arg.slice("--out=".length).trim();
    } else if (arg.startsWith("--proposal=")) {
      options.proposalPath = arg.slice("--proposal=".length).trim();
    } else if (arg.startsWith("--confirm=")) {
      options.confirmation = arg.slice("--confirm=".length).trim();
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  if (options.applyDisposition && options.releaseFence) {
    throw new Error("--apply-disposition and --release-fence are mutually exclusive.");
  }
  if (options.applyDisposition || options.releaseFence) {
    if (!options.proposalPath || !options.confirmation) {
      throw new Error(
        "--apply-disposition/--release-fence requires --proposal and --confirm.",
      );
    }
    if (
      options.planPath ||
      options.selectionPath ||
      options.settlementPath ||
      options.channelmaxPostwritePath ||
      options.checkpointRoot ||
      options.coordinationDir ||
      options.outputDir
    ) {
      throw new Error(
        "Disposition/release mode re-reads paths sealed in --proposal and forbids build inputs.",
      );
    }
  } else if (
    !options.planPath ||
    !options.selectionPath ||
    !options.settlementPath ||
    !options.channelmaxPostwritePath ||
    !options.outputDir
  ) {
    throw new Error(
      "Proposal mode requires --plan, --execution-selection, --settlement-checkpoint, --channelmax-postwrite, and --out.",
    );
  } else if (options.proposalPath || options.confirmation) {
    throw new Error("Proposal mode forbids --proposal and --confirm.");
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.releaseFence) {
    const result = await releaseExternalOverwriteDispositionFence({
      proposalPath: path.resolve(options.proposalPath!),
      confirmation: options.confirmation!,
    });
    console.log(
      JSON.stringify(
        {
          result: "FENCE_EXPLICITLY_RELEASED",
          armed_event_id: result.armed_event.event_id,
          released_event_id: result.released_event.event_id,
          amazon_calls: 0,
          channelmax_calls: 0,
          fence_released: result.fence_released,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (options.applyDisposition) {
    const result = await applyExternalOverwriteDisposition({
      proposalPath: path.resolve(options.proposalPath!),
      confirmation: options.confirmation!,
    });
    console.log(
      JSON.stringify(
        {
          result: "TERMINAL_CHECKPOINT_APPENDED",
          action_id: result.event.action_id,
          event_id: result.event.event_id,
          event_sha256: result.event.sha256,
          amazon_calls: 0,
          channelmax_calls: 0,
          fence_preserved: result.fence_preserved,
          fence_release_authorized: false,
          explicit_fence_release_confirmation_token:
            externalOverwriteFenceReleaseConfirmationToken(
              (result.event.detail.proposal as { sha256: string }).sha256,
            ),
        },
        null,
        2,
      ),
    );
    return;
  }

  const proposal = await buildExternalOverwriteDispositionProposal({
    planPath: path.resolve(options.planPath!),
    executionSelectionPath: path.resolve(options.selectionPath!),
    settlementCheckpointPath: path.resolve(options.settlementPath!),
    channelmaxPostwritePath: path.resolve(options.channelmaxPostwritePath!),
    ...(options.checkpointRoot
      ? { checkpointRoot: path.resolve(options.checkpointRoot) }
      : {}),
    ...(options.coordinationDir
      ? { coordinationDir: path.resolve(options.coordinationDir) }
      : {}),
  });
  const proposalFile = await writeExternalOverwriteDispositionProposal(
    path.resolve(options.outputDir!),
    proposal,
  );
  console.log(
    JSON.stringify(
      {
        result: "ELIGIBLE_PROPOSAL_ONLY",
        proposal: proposalFile,
        proposal_sha256: proposal.sha256,
        exact_action_id: proposal.action.action_id,
        stable_non_desired_reads: proposal.settlement.consecutive_stable_reads,
        channelmax_postwrite_sha256: proposal.channelmax_postwrite.file_sha256,
        amazon_calls: 0,
        channelmax_calls: 0,
        checkpoint_appended: false,
        fence_preserved: true,
        apply_confirmation_token: proposal.confirmation_token,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
