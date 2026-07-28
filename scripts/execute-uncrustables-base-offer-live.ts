#!/usr/bin/env node

/**
 * Default-offline operational entrypoint for the isolated Uncrustables base
 * offer executor. Preview/apply are unreachable without the exact CLI token
 * and independently armed environment variable. This script never creates an
 * owner authorization.
 */

import { config } from "dotenv";
import { readFile } from "node:fs/promises";

import {
  getListing,
  patchListing as patchAmazonListing,
  type ListingPatch,
} from "../src/lib/amazon-sp-api/listings";
import { getMerchantToken } from "../src/lib/amazon-sp-api/sellers";
import type {
  BaseOfferPreservePlan,
  BaseOfferPreserveSelection,
} from "../src/lib/bundle-factory/repair/uncrustables-base-offer-preserve";
import { stableJson } from "../src/lib/bundle-factory/repair/uncrustables-base-offer-preserve";
import type {
  BaseOfferLiveAuthorization,
  BaseOfferLiveMode,
  BaseOfferLiveSelection,
  BaseOfferRollbackBinding,
} from "../src/lib/bundle-factory/repair/uncrustables-base-offer-live-contract";
import {
  ImmutableBaseOfferCheckpointStore,
  assertNoForbiddenBaseOfferPatchMembers,
  baseOfferExecutionBindingSha256,
  executeBaseOfferLive,
  type BaseOfferAmazonGateway,
  type BaseOfferAmazonGatewayResponse,
  type BaseOfferPhysicalAccountContext,
} from "../src/lib/bundle-factory/repair/uncrustables-base-offer-live-executor";
import type { UncrustablesPreChangeSnapshot } from "../src/lib/bundle-factory/repair/uncrustables-amazon-rollback";

config({ path: ".env.local" });
config({ path: ".env" });

const DEFAULT_PLAN =
  "data/repairs/base-offer-preserve/" +
  "uncrustables-base-offer-preserve-20260719-v3/base-offer-preserve-plan.json";
const DEFAULT_FULL_SELECTION =
  "data/repairs/base-offer-preserve/" +
  "uncrustables-base-offer-preserve-20260719-v3/base-offer-preserve-selection.json";
const DEFAULT_LIVE_SELECTION =
  "data/repairs/base-offer-preserve/" +
  "uncrustables-base-offer-lk-first-canary-20260719-v1/live-selection.json";

interface Options {
  mode: BaseOfferLiveMode;
  plan: string;
  fullSelection: string;
  liveSelection: string;
  snapshot: string | null;
  rollbackBinding: string | null;
  authorization: string | null;
  checkpointDir: string | null;
  confirmation: string | null;
  readbackAttempts: number | null;
  readbackDelayMs: number | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    mode: "OFFLINE_VALIDATE",
    plan: DEFAULT_PLAN,
    fullSelection: DEFAULT_FULL_SELECTION,
    liveSelection: DEFAULT_LIVE_SELECTION,
    snapshot: null,
    rollbackBinding: null,
    authorization: null,
    checkpointDir: null,
    confirmation: null,
      readbackAttempts: null,
    readbackDelayMs: null,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: node --import tsx scripts/execute-uncrustables-base-offer-live.ts --snapshot=PATH --rollback-binding=PATH [options]",
          "",
          "  --mode=offline|preview|apply  Default offline",
          `  --plan=PATH                   Default ${DEFAULT_PLAN}`,
          `  --full-selection=PATH         Default ${DEFAULT_FULL_SELECTION}`,
          `  --live-selection=PATH         Default ${DEFAULT_LIVE_SELECTION}`,
          "  --snapshot=PATH               Fresh exact 164-row snapshot (required)",
          "  --rollback-binding=PATH       Exact sealed binding (required)",
          "  --authorization=PATH          Separate current owner authorization (APPLY only)",
          "  --checkpoint-dir=PATH         Immutable journal root (live modes only)",
          "  --confirm=TOKEN               Exact run-bound token (live modes only)",
          "  --readback-attempts=N         Readback polls per action (engine bounds 2..20; default 6)",
          "  --readback-delay-ms=N         Delay before each readback poll (>=200; default 5000)",
          "",
          "Live modes also require BF_UNCRUSTABLES_AMAZON_BASE_OFFER_PRESERVE_LIVE_ARM",
          "to equal the exact --confirm token. This command never creates authorization.",
        ].join("\n") + "\n",
      );
      process.exit(0);
    } else if (arg.startsWith("--mode=")) {
      const raw = arg.slice("--mode=".length);
      const modes: Record<string, BaseOfferLiveMode> = {
        offline: "OFFLINE_VALIDATE",
        preview: "VALIDATION_PREVIEW",
        apply: "APPLY",
      };
      if (!modes[raw]) throw new Error(`Unsupported --mode=${raw}.`);
      options.mode = modes[raw];
    } else if (arg.startsWith("--plan=")) {
      options.plan = arg.slice("--plan=".length).trim();
    } else if (arg.startsWith("--full-selection=")) {
      options.fullSelection = arg.slice("--full-selection=".length).trim();
    } else if (arg.startsWith("--live-selection=")) {
      options.liveSelection = arg.slice("--live-selection=".length).trim();
    } else if (arg.startsWith("--snapshot=")) {
      options.snapshot = arg.slice("--snapshot=".length).trim();
    } else if (arg.startsWith("--rollback-binding=")) {
      options.rollbackBinding = arg.slice("--rollback-binding=".length).trim();
    } else if (arg.startsWith("--authorization=")) {
      options.authorization = arg.slice("--authorization=".length).trim();
    } else if (arg.startsWith("--checkpoint-dir=")) {
      options.checkpointDir = arg.slice("--checkpoint-dir=".length).trim();
    } else if (arg.startsWith("--confirm=")) {
      options.confirmation = arg.slice("--confirm=".length);
    } else if (arg.startsWith("--readback-attempts=")) {
      options.readbackAttempts = Number(arg.slice("--readback-attempts=".length));
    } else if (arg.startsWith("--readback-delay-ms=")) {
      options.readbackDelayMs = Number(arg.slice("--readback-delay-ms=".length));
    } else {
      throw new Error(`Unknown argument ${arg}.`);
    }
  }
  if (!options.snapshot || !options.rollbackBinding) {
    throw new Error("--snapshot and --rollback-binding are required.");
  }
  if (options.mode === "OFFLINE_VALIDATE") {
    if (options.authorization || options.checkpointDir || options.confirmation) {
      throw new Error("Offline mode rejects authorization/checkpoint/confirmation inputs.");
    }
  } else if (!options.checkpointDir || !options.confirmation) {
    throw new Error("Live mode requires --checkpoint-dir and --confirm.");
  }
  if (options.mode === "APPLY" && !options.authorization) {
    throw new Error("APPLY requires --authorization.");
  }
  if (options.mode !== "APPLY" && options.authorization) {
    throw new Error("Only APPLY accepts --authorization.");
  }
  return options;
}

async function load<T>(filePath: string): Promise<{ bytes: Buffer; value: T }> {
  const bytes = await readFile(filePath);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) as T };
}

class LiveGateway implements BaseOfferAmazonGateway {
  readonly physicalMutationGuardContract =
    "CALL_IMMEDIATELY_BEFORE_REQUEST_V1" as const;
  private readonly sellers = new Map<number, string>();

  private async sellerId(storeIndex: number, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    let seller = this.sellers.get(storeIndex);
    if (!seller) {
      seller = await getMerchantToken(storeIndex, signal);
      signal?.throwIfAborted();
      this.sellers.set(storeIndex, seller);
    }
    return seller;
  }

  async getListing(storeIndex: number, sku: string, signal?: AbortSignal) {
    return getListing(storeIndex, await this.sellerId(storeIndex, signal), sku, {
      includedData: [
        "summaries",
        "attributes",
        "issues",
        "offers",
        "fulfillmentAvailability",
      ],
      signal,
    });
  }

  async patchListing(
    storeIndex: number,
    sku: string,
    productType: string,
    patches: ListingPatch[],
    options: {
      validationPreview: boolean;
      signal?: AbortSignal;
      beforeRequest?: (context: BaseOfferPhysicalAccountContext) => void;
    },
  ): Promise<BaseOfferAmazonGatewayResponse> {
    const bytes = stableJson(patches);
    if (bytes.includes("discounted_price") || bytes.includes("list_price")) {
      throw new Error("Gateway rejected promo/list member before Amazon.");
    }
    if (options.validationPreview) {
      if (
        patches.length !== 1 ||
        patches[0].op !== "replace" ||
        patches[0].path !== "/attributes/purchasable_offer"
      ) {
        throw new Error("Gateway rejected non-canonical validation preview.");
      }
    } else {
      assertNoForbiddenBaseOfferPatchMembers(patches);
    }
    const seller = await this.sellerId(storeIndex, options.signal);
    return patchAmazonListing(storeIndex, seller, sku, productType, patches, {
      validationPreview: options.validationPreview,
      retries: options.validationPreview ? undefined : 1,
      signal: options.signal,
      beforeRequest: options.beforeRequest
        ? () =>
            options.beforeRequest?.({
              store_index: storeIndex,
              marketplace_id: "ATVPDKIKX0DER",
              amazon_merchant_id: seller,
            })
        : undefined,
    }) as Promise<BaseOfferAmazonGatewayResponse>;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const [plan, fullSelection, liveSelection, snapshot, rollbackBinding] =
    await Promise.all([
      load<BaseOfferPreservePlan>(options.plan),
      load<BaseOfferPreserveSelection>(options.fullSelection),
      load<BaseOfferLiveSelection>(options.liveSelection),
      load<UncrustablesPreChangeSnapshot>(options.snapshot!),
      load<BaseOfferRollbackBinding>(options.rollbackBinding!),
    ]);
  const authorization = options.authorization
    ? (await load<BaseOfferLiveAuthorization>(options.authorization)).value
    : null;
  const common = {
    plan: plan.value,
    fullSelection: fullSelection.value,
    liveSelection: liveSelection.value,
    rollbackBinding: rollbackBinding.value,
    snapshot: snapshot.value,
    snapshotBytes: snapshot.bytes,
    authorization,
    mode: options.mode,
    confirmation: options.confirmation,
    environment: process.env,
  };
  const executionBinding = baseOfferExecutionBindingSha256(common);
  const result =
    options.mode === "OFFLINE_VALIDATE"
      ? await executeBaseOfferLive(common)
      : await executeBaseOfferLive({
          ...common,
          gateway: new LiveGateway(),
          ...(options.readbackAttempts != null
            ? { readbackAttempts: options.readbackAttempts }
            : {}),
          ...(options.readbackDelayMs != null
            ? { readbackDelayMs: options.readbackDelayMs }
            : {}),
          checkpointStore: new ImmutableBaseOfferCheckpointStore(
            options.checkpointDir!,
            executionBinding,
          ),
        });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
