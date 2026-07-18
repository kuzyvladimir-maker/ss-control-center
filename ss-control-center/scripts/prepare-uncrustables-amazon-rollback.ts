/**
 * Prepare the immutable safety set required before an Uncrustables Amazon
 * repair. Default mode is offline and diagnostic-only. `--capture-live` makes
 * read-only SP-API GETs for all exact 164 listings; it never PATCHes Amazon and
 * never writes R2 or the database.
 *
 * Examples:
 *   npx tsx scripts/prepare-uncrustables-amazon-rollback.ts
 *   npx tsx scripts/prepare-uncrustables-amazon-rollback.ts \
 *     --capture-live --repair-plan=data/repairs/generated/URP-....json
 */

import { createHash } from "node:crypto";
import { config } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getListing } from "@/lib/amazon-sp-api/listings";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import {
  buildLedgerBootstrapSnapshot,
  buildRollbackPlan,
  captureLivePreChangeSnapshot,
  writeImmutablePreChangeSnapshot,
  writeImmutableRollbackPlan,
  type SnapshotImageEvidence,
  type SnapshotImageLoader,
  type SnapshotReadGateway,
} from "@/lib/bundle-factory/repair/uncrustables-amazon-rollback";
import {
  readRepairExecutionSelection,
  readRepairPlan,
} from "@/lib/bundle-factory/repair/uncrustables-surgical";

config({ path: ".env.local" });
config({ path: ".env" });

const DEFAULT_LEDGER =
  "data/audits/uncrustables-ledger-20260717T232140568Z-offline.json";
const DEFAULT_OVERRIDES =
  "data/repairs/uncrustables-reviewed-overrides-20260717.json";
const DEFAULT_OUTPUT_DIR = "data/repairs/rollback";

interface CliOptions {
  ledgerPath: string;
  overridesPath: string;
  repairPlanPath: string | null;
  executionSelectionPath: string | null;
  outputDir: string;
  captureLive: boolean;
  downloadImages: boolean;
  requestDelayMs: number;
  canarySize: number;
  maxImageBytes: number;
}

function usage(): string {
  return [
    "Usage: npx tsx scripts/prepare-uncrustables-amazon-rollback.ts [options]",
    "",
    "Offline diagnostic bootstrap (default; zero API/DB calls):",
    `  --ledger=PATH          Exact sealed 164-live-row ledger (default ${DEFAULT_LEDGER}).`,
    `  --overrides=PATH       Sealed reviewed overrides (default ${DEFAULT_OVERRIDES}).`,
    `  --output-dir=PATH      Immutable local artifacts (default ${DEFAULT_OUTPUT_DIR}).`,
    "",
    "Read-only pre-change capture:",
    "  --capture-live         GET exact current JSON/offers/images for all 164; no mutations.",
    "  --no-download-images   Keep image URLs but skip local binary evidence.",
    "  --request-delay-ms=N   SP-API pacing, >=200 (default 250).",
    "  --max-image-bytes=N    Per-image safety cap (default 26214400).",
    "",
    "Inverse plan:",
    "  --repair-plan=PATH     Bind snapshot to an existing reviewed repair plan.",
    "  --execution-selection=PATH Bind inverse operations to this exact sealed action selection.",
    "  --canary-size=N        Deterministic representative canary size (default 3).",
    "  --help                 Show this help.",
    "",
    "This command contains no Amazon PATCH/PUT, R2 upload, or database write path.",
  ].join("\n");
}

function positiveInt(flag: string, raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    ledgerPath: DEFAULT_LEDGER,
    overridesPath: DEFAULT_OVERRIDES,
    repairPlanPath: null,
    executionSelectionPath: null,
    outputDir: DEFAULT_OUTPUT_DIR,
    captureLive: false,
    downloadImages: true,
    requestDelayMs: 250,
    canarySize: 3,
    maxImageBytes: 25 * 1024 * 1024,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--capture-live") {
      options.captureLive = true;
    } else if (arg === "--no-download-images") {
      options.downloadImages = false;
    } else if (arg.startsWith("--ledger=")) {
      options.ledgerPath = arg.slice("--ledger=".length).trim();
    } else if (arg.startsWith("--overrides=")) {
      options.overridesPath = arg.slice("--overrides=".length).trim();
    } else if (arg.startsWith("--repair-plan=")) {
      options.repairPlanPath = arg.slice("--repair-plan=".length).trim();
    } else if (arg.startsWith("--execution-selection=")) {
      options.executionSelectionPath = arg
        .slice("--execution-selection=".length)
        .trim();
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length).trim();
    } else if (arg.startsWith("--request-delay-ms=")) {
      options.requestDelayMs = positiveInt(
        "--request-delay-ms",
        arg.split("=", 2)[1],
      );
    } else if (arg.startsWith("--canary-size=")) {
      options.canarySize = positiveInt("--canary-size", arg.split("=", 2)[1]);
    } else if (arg.startsWith("--max-image-bytes=")) {
      options.maxImageBytes = positiveInt(
        "--max-image-bytes",
        arg.split("=", 2)[1],
      );
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  if (options.requestDelayMs < 200) {
    throw new Error("--request-delay-ms must be >=200.");
  }
  if (options.canarySize > 20) {
    throw new Error("--canary-size must be <=20.");
  }
  if (!options.ledgerPath || !options.overridesPath || !options.outputDir) {
    throw new Error("Ledger, overrides, and output paths must be non-empty.");
  }
  if (options.executionSelectionPath && !options.repairPlanPath) {
    throw new Error("--execution-selection requires --repair-plan.");
  }
  return options;
}

class LiveReadGateway implements SnapshotReadGateway {
  private readonly sellerIds = new Map<number, string>();

  private async sellerId(storeIndex: number): Promise<string> {
    let sellerId = this.sellerIds.get(storeIndex);
    if (!sellerId) {
      sellerId = await getMerchantToken(storeIndex);
      this.sellerIds.set(storeIndex, sellerId);
    }
    return sellerId;
  }

  async getListing(storeIndex: number, sku: string) {
    return getListing(storeIndex, await this.sellerId(storeIndex), sku, {
      includedData: [
        "summaries",
        "attributes",
        "issues",
        "offers",
        "fulfillmentAvailability",
        "procurement",
      ],
    });
  }
}

function safeImageUrl(raw: string): URL {
  const url = new URL(raw);
  const hostname = url.hostname.toLowerCase();
  const allowed =
    hostname === "m.media-amazon.com" ||
    hostname.endsWith(".media-amazon.com") ||
    hostname.endsWith(".ssl-images-amazon.com") ||
    hostname.endsWith(".r2.dev");
  if (
    url.protocol !== "https:" ||
    !allowed ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error(`Image URL host is not approved for read-only capture: ${raw}`);
  }
  return url;
}

function extensionFor(contentType: string): string {
  if (/png/i.test(contentType)) return "png";
  if (/webp/i.test(contentType)) return "webp";
  if (/gif/i.test(contentType)) return "gif";
  return "jpg";
}

class LocalImageLoader implements SnapshotImageLoader {
  constructor(
    private readonly assetDir: string,
    private readonly maxBytes: number,
  ) {}

  async load(rawUrl: string): Promise<SnapshotImageEvidence> {
    const url = safeImageUrl(rawUrl);
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
      headers: { accept: "image/*" },
    });
    if (!response.ok) throw new Error(`Image GET returned HTTP ${response.status}.`);
    safeImageUrl(response.url);
    const contentType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (!contentType.startsWith("image/")) {
      throw new Error(`Image GET returned unsupported content type ${contentType || "missing"}.`);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      throw new Error(`Image exceeds ${this.maxBytes} byte cap.`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > this.maxBytes) {
      throw new Error(`Image payload size ${bytes.length} is outside the safety bounds.`);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    await mkdir(this.assetDir, { recursive: true });
    const file = path.join(this.assetDir, `${digest}.${extensionFor(contentType)}`);
    try {
      await writeFile(file, bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(file);
      const existingDigest = createHash("sha256").update(existing).digest("hex");
      if (existingDigest !== digest) {
        throw new Error(`Existing content-addressed image is corrupted: ${file}`);
      }
    }
    return {
      url: rawUrl,
      sha256: digest,
      bytes: bytes.length,
      content_type: contentType,
      local_path: path.resolve(file),
      error: null,
    };
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const ledgerBytes = await readFile(options.ledgerPath);
  const overridesBytes = await readFile(options.overridesPath);
  const repairPlan = options.repairPlanPath
    ? await readRepairPlan(options.repairPlanPath)
    : null;
  const executionSelection =
    options.executionSelectionPath && repairPlan
      ? await readRepairExecutionSelection(
          options.executionSelectionPath,
          repairPlan,
        )
      : null;
  if (
    repairPlan?.desired_manifest_source &&
    (path.resolve(options.overridesPath) !==
      path.resolve(repairPlan.desired_manifest_source.path) ||
      createHash("sha256").update(overridesBytes).digest("hex") !==
        repairPlan.desired_manifest_source.sha256)
  ) {
    throw new Error(
      "--overrides must be the exact reviewed desired-state manifest sealed in --repair-plan; refusing live capture.",
    );
  }
  const common = {
    ledgerPath: options.ledgerPath,
    ledgerBytes,
    overridesPath: options.overridesPath,
    overridesBytes,
  };
  const snapshot = options.captureLive
    ? await captureLivePreChangeSnapshot({
        ...common,
        gateway: new LiveReadGateway(),
        imageLoader: options.downloadImages
          ? new LocalImageLoader(
              path.join(options.outputDir, "assets"),
              options.maxImageBytes,
            )
          : undefined,
        requestDelayMs: options.requestDelayMs,
      })
    : buildLedgerBootstrapSnapshot(common);
  const snapshotPath = await writeImmutablePreChangeSnapshot(
    options.outputDir,
    snapshot,
  );
  let rollbackPath: string | null = null;
  let rollbackSummary: Record<string, unknown> | null = null;
  if (options.repairPlanPath && repairPlan) {
    const rollback = buildRollbackPlan({
      snapshotPath,
      snapshot,
      repairPlanPath: options.repairPlanPath,
      repairPlan,
      executionSelectionPath: options.executionSelectionPath,
      executionSelection,
      canarySize: options.canarySize,
    });
    rollbackPath = await writeImmutableRollbackPlan(options.outputDir, rollback);
    rollbackSummary = {
      rollback_plan_id: rollback.rollback_plan_id,
      rollback_plan_sha256: rollback.sha256,
      apply_eligible: rollback.apply_eligible,
      canary_skus: rollback.canary.skus,
      rollback_entries: rollback.scope.rollback_entries,
      inverse_operations: rollback.scope.inverse_operations,
      missing_media_binary_evidence:
        rollback.scope.missing_media_binary_evidence,
      source_execution_selection: rollback.source_execution_selection,
    };
  }
  console.log(
    JSON.stringify(
      {
        mode: options.captureLive
          ? "READ_ONLY_LIVE_SP_API_CAPTURE"
          : "OFFLINE_LEDGER_BOOTSTRAP",
        snapshot_path: snapshotPath,
        snapshot_id: snapshot.snapshot_id,
        snapshot_sha256: snapshot.sha256,
        exact_scope: snapshot.scope,
        image_capture: {
          unique_urls: snapshot.image_capture.unique_urls,
          captured: snapshot.image_capture.captured,
          failed: snapshot.image_capture.failed,
          complete: snapshot.image_capture.complete,
        },
        snapshot_apply_eligible: snapshot.apply_eligible,
        rollback_path: rollbackPath,
        rollback: rollbackSummary,
        external_mutations: {
          amazon_writes: 0,
          r2_writes: 0,
          database_writes: 0,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
