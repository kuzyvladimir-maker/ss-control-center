#!/usr/bin/env node

/**
 * Offline/local-only disposition for a proven synchronous pre-request abort.
 * This module imports no Amazon, ChannelMAX, browser, network, dotenv, or
 * credential client. Proposal, terminalization, and fence release are three
 * separate steps with separate exact confirmations.
 */

import path from "node:path";

import {
  applyPreRequestAbortDisposition,
  buildPreRequestAbortDispositionProposal,
  releasePreRequestAbortDispositionFence,
  writePreRequestAbortDispositionProposal,
} from "@/lib/bundle-factory/repair/uncrustables-pre-request-abort-disposition";
import { preRequestAbortFenceReleaseConfirmationToken } from
  "@/lib/bundle-factory/repair/uncrustables-pre-request-abort-disposition-contract";

interface Options {
  planPath: string | null;
  selectionPath: string | null;
  armedPath: string | null;
  failedPath: string | null;
  recoveryPath: string | null;
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
    "Pre-request abort disposition (offline/local only)",
    "",
    "Build immutable proposal (default; journal/fence unchanged):",
    "  node --import tsx scripts/disposition-uncrustables-pre-request-abort.ts \\",
    "    --plan=PATH --execution-selection=PATH --armed-checkpoint=PATH \\",
    "    --failed-checkpoint=PATH --recovery-checkpoint=PATH --out=NEW_DIRECTORY",
    "",
    "Append terminal checkpoint only (fence preserved):",
    "  node --import tsx scripts/disposition-uncrustables-pre-request-abort.ts \\",
    "    --apply-disposition --proposal=PATH --confirm=EXACT_TOKEN",
    "",
    "Release already-terminal fence (separate confirmation):",
    "  node --import tsx scripts/disposition-uncrustables-pre-request-abort.ts \\",
    "    --release-fence --proposal=PATH --confirm=EXACT_RELEASE_TOKEN",
    "",
    "Optional isolated roots: --checkpoint-root=PATH --coordination-dir=PATH",
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    planPath: null,
    selectionPath: null,
    armedPath: null,
    failedPath: null,
    recoveryPath: null,
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
    } else if (arg.startsWith("--armed-checkpoint=")) {
      options.armedPath = arg.slice("--armed-checkpoint=".length).trim();
    } else if (arg.startsWith("--failed-checkpoint=")) {
      options.failedPath = arg.slice("--failed-checkpoint=".length).trim();
    } else if (arg.startsWith("--recovery-checkpoint=")) {
      options.recoveryPath = arg.slice("--recovery-checkpoint=".length).trim();
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
      options.armedPath ||
      options.failedPath ||
      options.recoveryPath ||
      options.checkpointRoot ||
      options.coordinationDir ||
      options.outputDir
    ) {
      throw new Error("Disposition/release mode forbids proposal-build inputs.");
    }
  } else if (
    !options.planPath ||
    !options.selectionPath ||
    !options.armedPath ||
    !options.failedPath ||
    !options.recoveryPath ||
    !options.outputDir
  ) {
    throw new Error(
      "Proposal mode requires plan, selection, armed, failed, recovery, and out paths.",
    );
  } else if (options.proposalPath || options.confirmation) {
    throw new Error("Proposal mode forbids --proposal and --confirm.");
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.releaseFence) {
    const result = await releasePreRequestAbortDispositionFence({
      proposalPath: path.resolve(options.proposalPath!),
      confirmation: options.confirmation!,
    });
    console.log(JSON.stringify({
      result: "FENCE_EXPLICITLY_RELEASED",
      armed_event_id: result.armed_event.event_id,
      released_event_id: result.released_event.event_id,
      amazon_calls: 0,
      channelmax_calls: 0,
      fence_released: true,
    }, null, 2));
    return;
  }
  if (options.applyDisposition) {
    const result = await applyPreRequestAbortDisposition({
      proposalPath: path.resolve(options.proposalPath!),
      confirmation: options.confirmation!,
    });
    const proposal = result.event.detail.proposal as { sha256: string };
    console.log(JSON.stringify({
      result: "PRE_REQUEST_ABORT_TERMINAL_APPENDED_NOT_VERIFIED",
      action_id: result.event.action_id,
      event_id: result.event.event_id,
      event_sha256: result.event.sha256,
      amazon_calls: 0,
      channelmax_calls: 0,
      fence_preserved: true,
      exact_release_confirmation_token:
        preRequestAbortFenceReleaseConfirmationToken(proposal.sha256),
    }, null, 2));
    return;
  }
  const proposal = await buildPreRequestAbortDispositionProposal({
    planPath: path.resolve(options.planPath!),
    executionSelectionPath: path.resolve(options.selectionPath!),
    armedCheckpointPath: path.resolve(options.armedPath!),
    failedCheckpointPath: path.resolve(options.failedPath!),
    recoveryCheckpointPath: path.resolve(options.recoveryPath!),
    ...(options.checkpointRoot
      ? { checkpointRoot: path.resolve(options.checkpointRoot) }
      : {}),
    ...(options.coordinationDir
      ? { coordinationDir: path.resolve(options.coordinationDir) }
      : {}),
  });
  const proposalFile = await writePreRequestAbortDispositionProposal(
    path.resolve(options.outputDir!),
    proposal,
  );
  console.log(JSON.stringify({
    result: "ELIGIBLE_PROPOSAL_ONLY",
    proposal: proposalFile,
    proposal_sha256: proposal.sha256,
    exact_action_id: proposal.action.action_id,
    stable_before_reads: proposal.recovery.consecutive_stable_reads,
    historical_amazon_patch_performed: false,
    amazon_calls: 0,
    channelmax_calls: 0,
    checkpoint_appended: false,
    fence_preserved: true,
    apply_confirmation_token: proposal.confirmation_token,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
