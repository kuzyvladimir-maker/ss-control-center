import { createHash } from "node:crypto";

import {
  launchPricingRowsBySku,
  verifyUncrustablesLaunchPricingManifest,
  type UncrustablesLaunchPricingManifest,
} from "./uncrustables-launch-pricing";

export const UNCRUSTABLES_CHANNELMAX_MANUAL_ASSIGNMENT_SCHEMA =
  "uncrustables-channelmax-manual-assignment/v1" as const;

export const CHANNELMAX_MANUAL_ASSIGNMENT_COLUMNS = [
  "SKU",
  "ASIN",
  "SellingVenue",
  "MinSellingPrice",
  "MaxSellingPrice",
  "RepricingModelID",
] as const;

export interface UncrustablesChannelMaxManualAssignmentManifest {
  schema_version: typeof UNCRUSTABLES_CHANNELMAX_MANUAL_ASSIGNMENT_SCHEMA;
  immutable: true;
  created_at: string;
  source_launch_pricing: {
    path: string;
    sha256: string;
    body_sha256: string;
  };
  manual_model: {
    id: string;
    name: string;
    runtime_rules_must_be_verified_after_upload: ["44a", "44b"];
  };
  authorities: {
    channelmax_bounds_are_guardrails_only: true;
    base_price: "AMAZON_SP_API";
    sale_price: "AMAZON_SP_API";
  };
  columns: typeof CHANNELMAX_MANUAL_ASSIGNMENT_COLUMNS;
  active_rows: number;
  tsv_file: string;
  tsv_sha256: string;
  uploaded: false;
  body_sha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function channelMaxManualAssignmentBodySha256(
  manifest:
    | Omit<UncrustablesChannelMaxManualAssignmentManifest, "body_sha256">
    | UncrustablesChannelMaxManualAssignmentManifest,
): string {
  const body = { ...(manifest as unknown as Record<string, unknown>) };
  delete body.body_sha256;
  return sha256(stableJson(body));
}

export function buildUncrustablesChannelMaxManualAssignment(input: {
  launchPricingManifest: UncrustablesLaunchPricingManifest;
  launchPricingPath: string;
  launchPricingSha256: string;
  manualModelId: string;
  manualModelName: string;
  createdAt: Date;
}): {
  tsv: string;
  manifest: UncrustablesChannelMaxManualAssignmentManifest;
} {
  const launch = verifyUncrustablesLaunchPricingManifest(
    input.launchPricingManifest,
  );
  if (
    launch.decision.revision_status !== "OWNER_APPROVED" ||
    launch.decision.owner_approved_at == null
  ) {
    throw new Error(
      "ChannelMAX Manual assignment requires the exact owner-approved launch revision.",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(input.launchPricingSha256)) {
    throw new Error("ChannelMAX assignment launch source SHA-256 is invalid.");
  }
  if (!/^\d+$/.test(input.manualModelId)) {
    throw new Error("ChannelMAX Manual RepricingModelID must be numeric.");
  }
  if (!input.manualModelName.trim()) {
    throw new Error("ChannelMAX Manual model name is missing.");
  }
  const rows = [...launchPricingRowsBySku(launch).values()].sort((left, right) =>
    left.sku.localeCompare(right.sku),
  );
  const lines = [CHANNELMAX_MANUAL_ASSIGNMENT_COLUMNS.join("\t")];
  for (const row of rows) {
    lines.push(
      [
        row.sku,
        row.asin,
        "AmazonUS",
        row.floor_price.toFixed(2),
        row.base_price.toFixed(2),
        input.manualModelId,
      ].join("\t"),
    );
  }
  const tsv = `${lines.join("\r\n")}\r\n`;
  const timestamp = input.createdAt.toISOString().replace(/[-:.]/g, "");
  const tsvFile = `uncrustables-channelmax-manual-${timestamp}-${sha256(tsv).slice(0, 12)}.txt`;
  const withoutDigest: Omit<
    UncrustablesChannelMaxManualAssignmentManifest,
    "body_sha256"
  > = {
    schema_version: UNCRUSTABLES_CHANNELMAX_MANUAL_ASSIGNMENT_SCHEMA,
    immutable: true,
    created_at: input.createdAt.toISOString(),
    source_launch_pricing: {
      path: input.launchPricingPath,
      sha256: input.launchPricingSha256,
      body_sha256: launch.body_sha256,
    },
    manual_model: {
      id: input.manualModelId,
      name: input.manualModelName,
      runtime_rules_must_be_verified_after_upload: ["44a", "44b"],
    },
    authorities: {
      channelmax_bounds_are_guardrails_only: true,
      base_price: "AMAZON_SP_API",
      sale_price: "AMAZON_SP_API",
    },
    columns: CHANNELMAX_MANUAL_ASSIGNMENT_COLUMNS,
    active_rows: rows.length,
    tsv_file: tsvFile,
    tsv_sha256: sha256(tsv),
    uploaded: false,
  };
  return {
    tsv,
    manifest: {
      ...withoutDigest,
      body_sha256: channelMaxManualAssignmentBodySha256(withoutDigest),
    },
  };
}

export function verifyUncrustablesChannelMaxManualAssignmentManifest(
  raw: unknown,
): UncrustablesChannelMaxManualAssignmentManifest {
  if (!isRecord(raw)) {
    throw new Error("ChannelMAX Manual assignment manifest must be an object.");
  }
  const manifest = raw as unknown as UncrustablesChannelMaxManualAssignmentManifest;
  if (
    manifest.schema_version !== UNCRUSTABLES_CHANNELMAX_MANUAL_ASSIGNMENT_SCHEMA ||
    manifest.immutable !== true ||
    manifest.uploaded !== false ||
    !/^\d+$/.test(manifest.manual_model?.id ?? "") ||
    !manifest.manual_model?.name?.trim() ||
    stableJson(manifest.manual_model.runtime_rules_must_be_verified_after_upload) !==
      stableJson(["44a", "44b"]) ||
    manifest.authorities?.channelmax_bounds_are_guardrails_only !== true ||
    manifest.authorities.base_price !== "AMAZON_SP_API" ||
    manifest.authorities.sale_price !== "AMAZON_SP_API" ||
    stableJson(manifest.columns) !==
      stableJson(CHANNELMAX_MANUAL_ASSIGNMENT_COLUMNS) ||
    !Number.isInteger(manifest.active_rows) ||
    manifest.active_rows <= 0 ||
    !/^[a-f0-9]{64}$/.test(manifest.tsv_sha256) ||
    !/^[a-f0-9]{64}$/.test(manifest.source_launch_pricing?.sha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(
      manifest.source_launch_pricing?.body_sha256 ?? "",
    ) ||
    manifest.body_sha256 !== channelMaxManualAssignmentBodySha256(manifest)
  ) {
    throw new Error("ChannelMAX Manual assignment manifest is invalid or weakened.");
  }
  return manifest;
}
