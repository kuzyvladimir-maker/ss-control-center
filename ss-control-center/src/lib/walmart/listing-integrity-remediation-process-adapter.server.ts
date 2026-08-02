import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;

export type WalmartListingIntegrityRemediationProcessCommand =
  | {
      command: "build-non-image";
      product_truth: string;
      diagnosis: string;
      buyer_snapshot: string;
      buyer_pdp: string;
      output_dir: string;
    }
  | {
      command: "build-text";
      product_truth: string;
      diagnosis: string;
      buyer_snapshot: string;
      buyer_pdp: string;
      output_dir: string;
    }
  | {
      command: "review-text";
      proposal: string;
      diagnosis: string;
      buyer_snapshot: string;
      buyer_pdp: string;
      donor_audit: string;
      asset_root: string;
      output: string;
    }
  | {
      command: "compile-text";
      proposal: string;
      diagnosis: string;
      buyer_snapshot: string;
      buyer_pdp: string;
      donor_audit: string;
      certification: string;
      asset_root: string;
      output: string;
    }
  | {
      command: "build-image-set";
      product_truth: string;
      diagnosis: string;
      main_candidate_dir: string;
      output_dir: string;
    }
  | {
      command: "qualify-image-set";
      candidate_dir: string;
      diagnosis: string;
      output_dir: string;
    }
  | {
      command: "curate-image-set";
      candidate_dir: string;
      qualification_dir: string;
      diagnosis: string;
      output_dir: string;
    }
  | {
      command: "preview-image-set";
      product_truth: string;
      diagnosis: string;
      buyer_snapshot: string;
      buyer_pdp: string;
      curated_candidate_dir: string;
      r2_staging: string;
      output_dir: string;
    }
  | {
      command: "compile-image-set";
      preview: string;
      diagnosis: string;
      buyer_snapshot: string;
      buyer_pdp: string;
      seller_item: string;
      product_truth: string;
      main_candidate_dir: string;
      source_candidate_dir: string;
      qualification_dir: string;
      curated_dir: string;
      r2_staging: string;
      output_dir: string;
    }
  | {
      command: "build-main";
      product_truth: string;
      diagnosis: string;
      output_dir: string;
    }
  | {
      command: "qualify-main";
      candidate_dir: string;
      diagnosis: string;
      output_dir: string;
    }
  | {
      command: "preview-main";
      product_truth: string;
      diagnosis: string;
      buyer_snapshot: string;
      buyer_pdp: string;
      candidate_dir: string;
      candidate_qualification: string;
      output_dir: string;
    }
  | {
      command: "stage-main";
      candidate_dir: string;
      qualification: string;
      output_dir: string;
    }
  | {
      command: "compile-main";
      preview: string;
      diagnosis: string;
      buyer_snapshot: string;
      buyer_pdp: string;
      seller_item: string;
      product_truth: string;
      candidate_dir: string;
      qualification_dir: string;
      r2_staging: string;
      output_dir: string;
    }
  | {
      command: "build-live-gallery";
      before_dir: string;
      after_dir: string;
      execution_package: string;
      qualification_receipt: string;
      output_dir: string;
    }
  | {
      command: "package";
      compilation_request: string;
      owner_confirmation: string;
      private_key: string;
      custody_root: string;
      output_dir: string;
      verifier_release_sha256: string;
      apply_release_sha256: string;
      approved_by: string;
    };

export interface WalmartListingIntegrityRemediationProcessConfig {
  node_path: string;
  env_file: string;
  workspace_engine_root: string;
  frozen_engine_root: string;
}

function fail(message: string): never {
  throw new Error(`WALMART_REMEDIATION_PROCESS_INVALID: ${message}`);
}

function exactPath(value: string, label: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.includes("\u0000")) {
    fail(`${label} must be an absolute normalized path`);
  }
  return value;
}

function exactText(value: string, label: string, maximum = 2_000): string {
  if (!value || value !== value.trim() || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be bounded exact text`);
  }
  return value;
}

function exactSha(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) fail(`${label} must be lowercase SHA-256`);
  return value;
}

function pairs(values: Record<string, string>): string[] {
  return Object.entries(values).map(([key, value]) => `--${key}=${value}`);
}

export function buildWalmartListingIntegrityRemediationInvocation(
  config: WalmartListingIntegrityRemediationProcessConfig,
  command: WalmartListingIntegrityRemediationProcessCommand,
): { cwd: string; script: string; argv: string[] } {
  const workspace = exactPath(config.workspace_engine_root, "workspace_engine_root");
  const frozen = exactPath(config.frozen_engine_root, "frozen_engine_root");
  if (command.command === "build-non-image") {
    return {
      cwd: workspace,
      script: resolve(workspace, "scripts/build-walmart-listing-non-image-repair-candidate.ts"),
      argv: pairs({
        "product-truth": exactPath(command.product_truth, "product_truth"),
        diagnosis: exactPath(command.diagnosis, "diagnosis"),
        "buyer-snapshot": exactPath(command.buyer_snapshot, "buyer_snapshot"),
        "buyer-pdp": exactPath(command.buyer_pdp, "buyer_pdp"),
        "output-dir": exactPath(command.output_dir, "output_dir"),
      }),
    };
  }
  if (command.command === "build-text") {
    return {
      cwd: workspace,
      script: resolve(workspace, "scripts/build-walmart-listing-text-review-candidate.ts"),
      argv: pairs({
        "product-truth": exactPath(command.product_truth, "product_truth"),
        diagnosis: exactPath(command.diagnosis, "diagnosis"),
        "buyer-snapshot": exactPath(command.buyer_snapshot, "buyer_snapshot"),
        "buyer-pdp": exactPath(command.buyer_pdp, "buyer_pdp"),
        "output-dir": exactPath(command.output_dir, "output_dir"),
      }),
    };
  }
  if (command.command === "review-text" || command.command === "compile-text") {
    return {
      cwd: workspace,
      script: resolve(workspace, "scripts/walmart-listing-integrity-process.ts"),
      argv: [
        command.command === "review-text" ? "review" : "prepare-repair",
        ...pairs({
          proposal: exactPath(command.proposal, "proposal"),
          diagnosis: exactPath(command.diagnosis, "diagnosis"),
          "buyer-snapshot": exactPath(command.buyer_snapshot, "buyer_snapshot"),
          "buyer-pdp": exactPath(command.buyer_pdp, "buyer_pdp"),
          "donor-audit": exactPath(command.donor_audit, "donor_audit"),
          ...(command.command === "compile-text" ? {
            certification: exactPath(command.certification, "certification"),
          } : {}),
          "asset-root": exactPath(command.asset_root, "asset_root"),
          output: exactPath(command.output, "output"),
        }),
      ],
    };
  }
  if (command.command === "build-image-set") {
    return {
      cwd: workspace,
      script: resolve(workspace, "scripts/build-walmart-listing-image-set-candidate.ts"),
      argv: pairs({
        "product-truth": exactPath(command.product_truth, "product_truth"),
        diagnosis: exactPath(command.diagnosis, "diagnosis"),
        "main-candidate-dir": exactPath(command.main_candidate_dir, "main_candidate_dir"),
        "output-dir": exactPath(command.output_dir, "output_dir"),
      }),
    };
  }
  if (command.command === "qualify-image-set") {
    return {
      cwd: workspace,
      script: resolve(workspace, "scripts/verify-walmart-listing-image-set-candidate.ts"),
      argv: pairs({
        "candidate-dir": exactPath(command.candidate_dir, "candidate_dir"),
        diagnosis: exactPath(command.diagnosis, "diagnosis"),
        "output-dir": exactPath(command.output_dir, "output_dir"),
      }),
    };
  }
  if (command.command === "curate-image-set") {
    return {
      cwd: workspace,
      script: resolve(workspace, "scripts/curate-walmart-listing-image-set-candidate.ts"),
      argv: pairs({
        "candidate-dir": exactPath(command.candidate_dir, "candidate_dir"),
        "qualification-dir": exactPath(command.qualification_dir, "qualification_dir"),
        diagnosis: exactPath(command.diagnosis, "diagnosis"),
        "output-dir": exactPath(command.output_dir, "output_dir"),
      }),
    };
  }
  if (command.command === "preview-image-set") {
    return {
      cwd: workspace,
      script: resolve(workspace, "scripts/build-walmart-listing-image-set-repair-preview.ts"),
      argv: pairs({
        "product-truth": exactPath(command.product_truth, "product_truth"),
        diagnosis: exactPath(command.diagnosis, "diagnosis"),
        "buyer-snapshot": exactPath(command.buyer_snapshot, "buyer_snapshot"),
        "buyer-pdp": exactPath(command.buyer_pdp, "buyer_pdp"),
        "curated-candidate-dir": exactPath(
          command.curated_candidate_dir,
          "curated_candidate_dir",
        ),
        "r2-staging": exactPath(command.r2_staging, "r2_staging"),
        "output-dir": exactPath(command.output_dir, "output_dir"),
      }),
    };
  }
  if (command.command === "compile-image-set") {
    return {
      cwd: workspace,
      script: resolve(workspace, "scripts/build-walmart-listing-image-set-compilation-request.ts"),
      argv: pairs({
        preview: exactPath(command.preview, "preview"),
        diagnosis: exactPath(command.diagnosis, "diagnosis"),
        "buyer-snapshot": exactPath(command.buyer_snapshot, "buyer_snapshot"),
        "buyer-pdp": exactPath(command.buyer_pdp, "buyer_pdp"),
        "seller-item": exactPath(command.seller_item, "seller_item"),
        "product-truth": exactPath(command.product_truth, "product_truth"),
        "main-candidate-dir": exactPath(command.main_candidate_dir, "main_candidate_dir"),
        "source-candidate-dir": exactPath(command.source_candidate_dir, "source_candidate_dir"),
        "qualification-dir": exactPath(command.qualification_dir, "qualification_dir"),
        "curated-dir": exactPath(command.curated_dir, "curated_dir"),
        "r2-staging": exactPath(command.r2_staging, "r2_staging"),
        "output-dir": exactPath(command.output_dir, "output_dir"),
      }),
    };
  }
  if (command.command === "build-main") {
    return {
      cwd: workspace,
      script: resolve(workspace, "scripts/build-walmart-listing-main-candidate.ts"),
      argv: pairs({
        "product-truth": exactPath(command.product_truth, "product_truth"),
        diagnosis: exactPath(command.diagnosis, "diagnosis"),
        "output-dir": exactPath(command.output_dir, "output_dir"),
      }),
    };
  }
  if (command.command === "qualify-main") {
    return {
      cwd: workspace,
      script: resolve(workspace, "scripts/verify-walmart-listing-main-candidate.ts"),
      argv: pairs({
        "candidate-dir": exactPath(command.candidate_dir, "candidate_dir"),
        diagnosis: exactPath(command.diagnosis, "diagnosis"),
        "output-dir": exactPath(command.output_dir, "output_dir"),
      }),
    };
  }
  if (command.command === "preview-main") {
    return {
      cwd: workspace,
      script: resolve(workspace, "scripts/build-walmart-listing-repair-preview.ts"),
      argv: pairs({
        "product-truth": exactPath(command.product_truth, "product_truth"),
        diagnosis: exactPath(command.diagnosis, "diagnosis"),
        "buyer-snapshot": exactPath(command.buyer_snapshot, "buyer_snapshot"),
        "buyer-pdp": exactPath(command.buyer_pdp, "buyer_pdp"),
        "candidate-dir": exactPath(command.candidate_dir, "candidate_dir"),
        "candidate-qualification": exactPath(
          command.candidate_qualification,
          "candidate_qualification",
        ),
        "output-dir": exactPath(command.output_dir, "output_dir"),
      }),
    };
  }
  if (command.command === "stage-main") {
    return {
      cwd: workspace,
      script: resolve(workspace, "scripts/stage-walmart-listing-main-candidate-r2.ts"),
      argv: pairs({
        "candidate-dir": exactPath(command.candidate_dir, "candidate_dir"),
        qualification: exactPath(command.qualification, "qualification"),
        "output-dir": exactPath(command.output_dir, "output_dir"),
      }),
    };
  }
  if (command.command === "compile-main") {
    return {
      cwd: workspace,
      script: resolve(workspace, "scripts/build-walmart-listing-main-compilation-request.ts"),
      argv: pairs({
        preview: exactPath(command.preview, "preview"),
        diagnosis: exactPath(command.diagnosis, "diagnosis"),
        "buyer-snapshot": exactPath(command.buyer_snapshot, "buyer_snapshot"),
        "buyer-pdp": exactPath(command.buyer_pdp, "buyer_pdp"),
        "seller-item": exactPath(command.seller_item, "seller_item"),
        "product-truth": exactPath(command.product_truth, "product_truth"),
        "candidate-dir": exactPath(command.candidate_dir, "candidate_dir"),
        "qualification-dir": exactPath(command.qualification_dir, "qualification_dir"),
        "r2-staging": exactPath(command.r2_staging, "r2_staging"),
        "output-dir": exactPath(command.output_dir, "output_dir"),
      }),
    };
  }
  if (command.command === "build-live-gallery") {
    return {
      cwd: workspace,
      script: resolve(workspace, "scripts/build-walmart-listing-integrity-live-gallery.mjs"),
      argv: pairs({
        "before-dir": exactPath(command.before_dir, "before_dir"),
        "after-dir": exactPath(command.after_dir, "after_dir"),
        "execution-package": exactPath(command.execution_package, "execution_package"),
        "qualification-receipt": exactPath(
          command.qualification_receipt,
          "qualification_receipt",
        ),
        "output-dir": exactPath(command.output_dir, "output_dir"),
      }),
    };
  }
  return {
    cwd: frozen,
    script: resolve(frozen, "scripts/walmart-listing-repair-owner-package.ts"),
    argv: [
      "package",
      ...pairs({
        "compilation-request": exactPath(
          command.compilation_request,
          "compilation_request",
        ),
        "owner-confirmation": exactText(command.owner_confirmation, "owner_confirmation"),
        "private-key": exactPath(command.private_key, "private_key"),
        "custody-root": exactPath(command.custody_root, "custody_root"),
        "output-dir": exactPath(command.output_dir, "output_dir"),
        "verifier-release-sha256": exactSha(
          command.verifier_release_sha256,
          "verifier_release_sha256",
        ),
        "apply-release-sha256": exactSha(
          command.apply_release_sha256,
          "apply_release_sha256",
        ),
        "approved-by": exactText(command.approved_by, "approved_by", 256),
      }),
    ],
  };
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "production" };
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || [
      "NODE_OPTIONS",
      "NODE_PATH",
      "NODE_REPL_EXTERNAL_MODULE",
      "NODE_INSPECT_RESUME_ON_START",
    ].includes(key)) continue;
    env[key] = value;
  }
  return env;
}

export async function invokeWalmartListingIntegrityRemediationProcess(input: {
  config: WalmartListingIntegrityRemediationProcessConfig;
  command: WalmartListingIntegrityRemediationProcessCommand;
  timeout_ms?: number;
}): Promise<Record<string, unknown>> {
  const invocation = buildWalmartListingIntegrityRemediationInvocation(
    input.config,
    input.command,
  );
  const child = spawn(exactPath(input.config.node_path, "node_path"), [
    `--env-file=${exactPath(input.config.env_file, "env_file")}`,
    "--import",
    "tsx",
    invocation.script,
    ...invocation.argv,
  ], {
    cwd: invocation.cwd,
    env: safeEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= MAX_STDOUT_BYTES) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= MAX_STDERR_BYTES) stderr.push(chunk);
  });
  const timeoutMs = input.timeout_ms ?? (
    input.command.command === "qualify-main" ? 20 * 60_000
      : input.command.command === "package" ? 10 * 60_000
        : 5 * 60_000
  );
  const exitCode = await new Promise<number | null>((accept, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("WALMART_REMEDIATION_PROCESS_TIMEOUT"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      accept(code);
    });
  });
  if (stdoutBytes < 2 || stdoutBytes > MAX_STDOUT_BYTES || stderrBytes > MAX_STDERR_BYTES) {
    fail("bounded process output was empty or exceeded its limit");
  }
  let result: unknown;
  try {
    result = JSON.parse(Buffer.concat(stdout).toString("utf8"));
  } catch {
    fail(`process stdout is not one JSON value: ${Buffer.concat(stderr).toString("utf8").slice(-2_000)}`);
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    fail("process result must be one object");
  }
  if (exitCode !== 0) {
    fail(`process exited ${exitCode}: ${Buffer.concat(stderr).toString("utf8").slice(-2_000)}`);
  }
  return result as Record<string, unknown>;
}
