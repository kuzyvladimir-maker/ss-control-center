import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import {
  CHANNELMAX_VC_CANARY,
  CHANNELMAX_VC_CANARY_PRODUCTION_READY,
  channelMaxVcCanaryArtifact,
  type ChannelMaxVcAnalysisPreview,
  type ChannelMaxVcBrowserPort,
  type ChannelMaxVcCanaryDirection,
  type ChannelMaxVcLocalEvidence,
  type ChannelMaxVcRowSnapshot,
  type ChannelMaxVcTaskReceipt,
} from "./uncrustables-same-model-canary";

export const CHANNELMAX_VC_CDP_ADAPTER_SCHEMA =
  "channelmax-vc-finite-cdp-adapter/v1" as const;

/**
 * This is intentionally independent from the state-machine production flag.
 * Both gates must eventually be reviewed and enabled in separate changes.
 */
export const CHANNELMAX_VC_CDP_ADAPTER_RELEASED = false as const;

export const CHANNELMAX_VC_CDP_HELPER_PATH = "scripts/cdp_browser.py" as const;

export const CHANNELMAX_VC_CDP_BLOCKERS = [
  "FILE_UPLOADER_DOM_EVIDENCE_NOT_PINNED",
  "FILE_INPUT_SELECTOR_NOT_REVIEWED",
  "ANALYZE_CONTROL_AND_PREVIEW_PARSER_NOT_REVIEWED",
  "SUBMIT_CONTROL_AND_TASK_RECEIPT_PARSER_NOT_REVIEWED",
  "POSTWRITE_ROW_READBACK_NOT_REVIEWED",
  "ADAPTER_RELEASE_GATE_DISABLED",
] as const;

type ChannelMaxVcCdpInterfaceName =
  | "EXACT_CONTEXT"
  | "EXACT_FILE_INPUT"
  | "ANALYZE_PREVIEW"
  | "SINGLE_SUBMIT"
  | "TASK_RECEIPT"
  | "ROW_READBACK"
  | "SCREENSHOT";

export interface ChannelMaxVcReviewedDomContract {
  schema_version: "channelmax-vc-reviewed-dom-contract/v1";
  evidence_sha256: string;
  captured_at: string;
  reviewed_at: string;
  reviewed_by_id: string;
  origin: `https://${typeof CHANNELMAX_VC_CANARY.host}`;
  file_uploader_pathname: string;
  task_status_pathname: string;
  selectors: {
    file_input: string;
    analyze_button: string;
    analyze_preview_root: string;
    submit_button: string;
    task_receipt_root: string;
  };
  fixed_expression_sha256: {
    context: string;
    analyze_preview: string;
    task_receipt: string;
    row_readback: string;
  };
}

/**
 * No selector or DOM parser is compiled from screenshots or memory. The value
 * stays null until a read-only DOM capture from the exact account/site is
 * content-addressed and independently reviewed.
 */
export const CHANNELMAX_VC_REVIEWED_DOM_CONTRACT: ChannelMaxVcReviewedDomContract | null =
  null;

export const CHANNELMAX_VC_CDP_INTERFACE_PLAN = {
  exact_context: {
    cdp_commands: ["tabs", "get_text", "evaluate"] as const,
    expected_protocol: "https:",
    expected_host: CHANNELMAX_VC_CANARY.host,
    expected_site_id: CHANNELMAX_VC_CANARY.selected_site_id,
    expected_site_name: CHANNELMAX_VC_CANARY.selected_site_name,
    selector: null,
    fixed_expression_sha256: null,
  },
  exact_file_input: {
    cdp_commands: ["upload_file"] as const,
    selector: null,
    allowed_root: "per-invocation-isolated-temp-directory",
    required_cli_options: ["--allowed-root", "--expected-sha256"] as const,
    exact_byte_size: CHANNELMAX_VC_CANARY.assignment_byte_size,
    allowed_sha256: [
      CHANNELMAX_VC_CANARY.forward.assignment_sha256,
      CHANNELMAX_VC_CANARY.rollback.assignment_sha256,
    ] as const,
  },
  analyze_preview: {
    cdp_commands: ["wait_for", "click_sel", "evaluate"] as const,
    control_selector: null,
    preview_root_selector: null,
    fixed_expression_sha256: null,
    expected_rows: 1,
    expected_columns: [
      "SKU",
      "ASIN",
      "SellingVenue",
      "MinSellingPrice",
      "MaxSellingPrice",
    ] as const,
  },
  single_submit: {
    cdp_commands: ["wait_for", "click_sel"] as const,
    selector: null,
    maximum_calls: 1,
    required_precondition: "ANALYZED_AND_MUTATION_FENCE_ACKNOWLEDGED",
    retry_after_possible_click: false,
  },
  task_receipt: {
    cdp_commands: ["evaluate"] as const,
    root_selector: null,
    fixed_expression_sha256: null,
    expected_rows_processed: 1,
    expected_rows_succeeded: 1,
    expected_rows_failed: 0,
  },
  row_readback: {
    cdp_commands: ["evaluate"] as const,
    selector: null,
    fixed_expression_sha256: null,
    expected_sku: CHANNELMAX_VC_CANARY.sku,
    expected_asin: CHANNELMAX_VC_CANARY.asin,
    expected_model_id: CHANNELMAX_VC_CANARY.manual_model.id,
    expected_model_name: CHANNELMAX_VC_CANARY.manual_model.name,
  },
  screenshot: {
    cdp_commands: ["screenshot"] as const,
    labels: ["ANALYZED", "POSTWRITE", "AMBIGUOUS"] as const,
  },
} as const;

export interface ChannelMaxVcCdpAdapterReadiness {
  schema_version: typeof CHANNELMAX_VC_CDP_ADAPTER_SCHEMA;
  production_ready: false;
  state_machine_release_gate: boolean;
  adapter_release_gate: false;
  helper_path: typeof CHANNELMAX_VC_CDP_HELPER_PATH;
  reviewed_dom_contract_sha256: null;
  target: {
    account_id: typeof CHANNELMAX_VC_CANARY.account_id;
    host: typeof CHANNELMAX_VC_CANARY.host;
    selected_site_id: typeof CHANNELMAX_VC_CANARY.selected_site_id;
    selected_site_name: typeof CHANNELMAX_VC_CANARY.selected_site_name;
    sku: typeof CHANNELMAX_VC_CANARY.sku;
    asin: typeof CHANNELMAX_VC_CANARY.asin;
  };
  blockers: typeof CHANNELMAX_VC_CDP_BLOCKERS;
}

export function channelMaxVcCdpAdapterReadiness(): ChannelMaxVcCdpAdapterReadiness {
  return {
    schema_version: CHANNELMAX_VC_CDP_ADAPTER_SCHEMA,
    production_ready: false,
    state_machine_release_gate: CHANNELMAX_VC_CANARY_PRODUCTION_READY,
    adapter_release_gate: CHANNELMAX_VC_CDP_ADAPTER_RELEASED,
    helper_path: CHANNELMAX_VC_CDP_HELPER_PATH,
    reviewed_dom_contract_sha256: null,
    target: {
      account_id: CHANNELMAX_VC_CANARY.account_id,
      host: CHANNELMAX_VC_CANARY.host,
      selected_site_id: CHANNELMAX_VC_CANARY.selected_site_id,
      selected_site_name: CHANNELMAX_VC_CANARY.selected_site_name,
      sku: CHANNELMAX_VC_CANARY.sku,
      asin: CHANNELMAX_VC_CANARY.asin,
    },
    blockers: CHANNELMAX_VC_CDP_BLOCKERS,
  };
}

export class ChannelMaxVcCdpAdapterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly interfaceName?: ChannelMaxVcCdpInterfaceName,
  ) {
    super(message);
    this.name = "ChannelMaxVcCdpAdapterError";
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertExactArtifact(input: {
  bytes: Uint8Array;
  sha256: string;
  direction: ChannelMaxVcCanaryDirection;
}): Buffer {
  const sealed = channelMaxVcCanaryArtifact(input.direction);
  const bytes = Buffer.from(input.bytes);
  if (
    input.sha256 !== sealed.sha256 ||
    bytes.byteLength !== sealed.byteSize ||
    sha256(bytes) !== sealed.sha256 ||
    !bytes.equals(sealed.bytes)
  ) {
    throw new ChannelMaxVcCdpAdapterError(
      "SEALED_ARTIFACT_MISMATCH",
      "The adapter accepts only the exact compiled one-row VC forward or rollback bytes.",
      "EXACT_FILE_INPUT",
    );
  }
  return bytes;
}

function assertCanonicalTaskId(uploadTaskId: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(uploadTaskId)) {
    throw new ChannelMaxVcCdpAdapterError(
      "UPLOAD_TASK_ID_INVALID",
      "ChannelMAX upload task ID is invalid.",
      "TASK_RECEIPT",
    );
  }
}

function failUnreviewed(interfaceName: ChannelMaxVcCdpInterfaceName): never {
  throw new ChannelMaxVcCdpAdapterError(
    "PINNED_DOM_CONTRACT_MISSING",
    `Finite ${interfaceName} CDP execution is disabled because no reviewed File Uploader DOM contract is pinned.`,
    interfaceName,
  );
}

export interface PreparedChannelMaxVcArtifact {
  direction: ChannelMaxVcCanaryDirection;
  root: string;
  path: string;
  sha256: string;
  byteSize: typeof CHANNELMAX_VC_CANARY.assignment_byte_size;
}

/**
 * Prepare the only file shape accepted by the future finite adapter. This is a
 * filesystem-only primitive: it does not invoke CDP, a browser, the network,
 * or the control plane. The isolated directory is always removed.
 */
export async function withPreparedChannelMaxVcArtifact<T>(
  input: {
    bytes: Uint8Array;
    sha256: string;
    direction: ChannelMaxVcCanaryDirection;
  },
  consume: (artifact: Readonly<PreparedChannelMaxVcArtifact>) => Promise<T> | T,
): Promise<T> {
  const bytes = assertExactArtifact(input);
  const root = await mkdtemp(join(tmpdir(), "channelmax-vc-canary-"));
  const sealed = channelMaxVcCanaryArtifact(input.direction);
  const path = join(
    root,
    `assignment-${input.direction.toLowerCase()}-${sealed.sha256}.txt`,
  );
  try {
    const handle = await open(
      path,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    const rootReal = await realpath(root);
    const pathStat = await lstat(path);
    const pathReal = await realpath(path);
    if (
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      pathStat.size !== sealed.byteSize ||
      dirname(pathReal) !== rootReal ||
      relative(rootReal, pathReal).startsWith("..")
    ) {
      throw new ChannelMaxVcCdpAdapterError(
        "UNSAFE_ARTIFACT_WORKSPACE",
        "Prepared canary artifact escaped or changed inside its isolated workspace.",
        "EXACT_FILE_INPUT",
      );
    }

    const readHandle = await open(
      pathReal,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    let readback: Buffer;
    try {
      readback = await readHandle.readFile();
    } finally {
      await readHandle.close();
    }
    if (
      readback.byteLength !== sealed.byteSize ||
      sha256(readback) !== sealed.sha256 ||
      !readback.equals(sealed.bytes)
    ) {
      throw new ChannelMaxVcCdpAdapterError(
        "PREPARED_ARTIFACT_MISMATCH",
        "Prepared canary artifact failed exact local readback.",
        "EXACT_FILE_INPUT",
      );
    }

    return await consume(
      Object.freeze({
        direction: input.direction,
        root: rootReal,
        path: pathReal,
        sha256: sealed.sha256,
        byteSize: sealed.byteSize,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Deterministic ChannelMaxVcBrowserPort skeleton. It deliberately has no
 * ExecFile/CDP dependency, so a missing reviewed contract cannot accidentally
 * fall through to a browser command. Once evidence exists, a separate reviewed
 * change must replace these fail-closed boundaries with fixed, non-callable-
 * selector implementations backed by cdp_browser.py.
 */
export class ChannelMaxVcCdpBrowserAdapter implements ChannelMaxVcBrowserPort {
  readonly readiness = channelMaxVcCdpAdapterReadiness();

  async assertExactContext(): Promise<{
    protocol: "https:";
    host: typeof CHANNELMAX_VC_CANARY.host;
    selectedSiteId: typeof CHANNELMAX_VC_CANARY.selected_site_id;
    selectedSiteName: typeof CHANNELMAX_VC_CANARY.selected_site_name;
  }> {
    return failUnreviewed("EXACT_CONTEXT");
  }

  async snapshot(
    direction: ChannelMaxVcCanaryDirection,
    phase: "PREWRITE" | "POSTWRITE",
    uploadTaskId: string | null,
  ): Promise<ChannelMaxVcRowSnapshot> {
    channelMaxVcCanaryArtifact(direction);
    if (
      (phase === "PREWRITE" && uploadTaskId !== null) ||
      (phase === "POSTWRITE" && uploadTaskId === null)
    ) {
      throw new ChannelMaxVcCdpAdapterError(
        "ROW_READBACK_BINDING_INVALID",
        "Prewrite readback cannot carry a TaskID and postwrite readback must carry one.",
        "ROW_READBACK",
      );
    }
    if (uploadTaskId !== null) assertCanonicalTaskId(uploadTaskId);
    return failUnreviewed("ROW_READBACK");
  }

  async captureScreenshot(
    label: "ANALYZED" | "POSTWRITE" | "AMBIGUOUS",
  ): Promise<ChannelMaxVcLocalEvidence> {
    void label;
    return failUnreviewed("SCREENSHOT");
  }

  async analyzeExactArtifact(input: {
    bytes: Uint8Array;
    sha256: string;
    direction: ChannelMaxVcCanaryDirection;
  }): Promise<ChannelMaxVcAnalysisPreview> {
    assertExactArtifact(input);
    return failUnreviewed("ANALYZE_PREVIEW");
  }

  async submitAnalyzedFileOnce(): Promise<{ uploadTaskId: string }> {
    return failUnreviewed("SINGLE_SUBMIT");
  }

  async verifyUploadTask(
    uploadTaskId: string,
  ): Promise<ChannelMaxVcTaskReceipt> {
    assertCanonicalTaskId(uploadTaskId);
    return failUnreviewed("TASK_RECEIPT");
  }
}
