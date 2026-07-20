import { createHash } from "node:crypto";

import { sha256Json, stableJson } from "./contracts";

export const CHANNELMAX_BD_DEFAULT_MANUAL_CANARY_SCHEMA =
  "channelmax-bd-default-manual-roundtrip-canary-package/v1" as const;
export const CHANNELMAX_DEFAULT_ROLLBACK_EVIDENCE_SCHEMA =
  "channelmax-default-model-rollback-evidence-requirements/v1" as const;

export const CHANNELMAX_BD_DEFAULT_MANUAL_CANARY = {
  account_id: "channelmax:amznus:salutem-solutions",
  host: "selling.channelmax.net",
  seller_id: "A3A7A0RDFUSGBS",
  site_id: 300,
  site_name: "AmznUS [Salutem Solutions]",
  item_id: 171141050,
  sku: "BD-AS8P-XAW5",
  asin: "B0H85MXFH8",
  selling_venue: "AmazonUS",
  minimum_price: 66.95,
  maximum_price: 76.99,
  before_model: { id: null, name: "Default" },
  forward_model: { id: "59021", name: "Manual min/max" },
  documented_default_model_candidate: {
    id: "35218",
    name: "Default",
  },
} as const;

export const CHANNELMAX_BD_DEFAULT_MANUAL_CANARY_COLUMNS = [
  "SKU",
  "ASIN",
  "SellingVenue",
  "MinSellingPrice",
  "MaxSellingPrice",
  "RepricingModelID",
] as const;

export const CHANNELMAX_BD_DEFAULT_MANUAL_FORWARD_TSV =
  `${CHANNELMAX_BD_DEFAULT_MANUAL_CANARY_COLUMNS.join("\t")}\r\n` +
  [
    CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.sku,
    CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.asin,
    CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.selling_venue,
    CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.minimum_price.toFixed(2),
    CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.maximum_price.toFixed(2),
    CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.forward_model.id,
  ].join("\t") +
  "\r\n";

export const CHANNELMAX_BD_DEFAULT_MANUAL_PINNED_SOURCES = {
  safe_manual_manifest: {
    path:
      "data/repairs/channelmax-manual/" +
      "uncrustables-safe-base-offer-161-20260719-v1/manifest.json",
    file_sha256:
      "627c3c17b854801392864366e37617f7aa226e30835c6342c8b66c673660479e",
  },
  safe_manual_tsv: {
    path:
      "data/repairs/channelmax-manual/" +
      "uncrustables-safe-base-offer-161-20260719-v1/" +
      "uncrustables-channelmax-safe-manual-161-20260719T055000000Z-1475cf783747.txt",
    file_sha256:
      "1475cf7837478c91ec2b69be52b5da3e4ca58dfaacc69e8c81eadc133b8d0753",
  },
  bd_prewrite: {
    path:
      "data/repairs/rollback/channelmax-bd-default-canary-20260719/prewrite.json",
    file_sha256:
      "cbf1342660f785e86aa217c0265cea54124a7e50a9c465ccb314a0157edf08a9",
  },
  bd_postwrite: {
    path:
      "data/repairs/rollback/channelmax-bd-default-canary-20260719/postwrite.json",
    file_sha256:
      "2e4179e492357e6f9331315d094101d3efa9cf6c9b01883bb4b2d3a3a4df566c",
  },
  manual_model_discovery: {
    path: "data/audits/channelmax-manual-model-discovery-20260718T220023Z.json",
    file_sha256:
      "14124ed5f78d1d407911f02f2844da0ffdf2bb8c82f8ad4c470b262ee6e31815",
  },
  channelmax_guide: {
    path: "../docs/wiki/channelmax-guide.md",
    file_sha256:
      "28e37e2291c2d29b07de78021220f76d004937889548fcfcee23ec77bdc217a8",
  },
  automation_architecture: {
    path: "../docs/CHANNELMAX_AUTOMATION_ARCHITECTURE.md",
    file_sha256:
      "e154a9e64be23677a884ffe2356d9813024742fd1c51255f67d7f63bf0354f9e",
  },
  current_preflight_source: {
    path: "src/lib/channelmax-agent/uncrustables-mutation-preflight.ts",
    file_sha256:
      "a32baa3d243fe99e6e3786606b4133133b25ae8377d2b897e6e5b8f3b87e0ba3",
  },
} as const;

type JsonRecord = Record<string, unknown>;

export interface ChannelMaxBdDefaultManualSource {
  path: string;
  bytes: Buffer;
}

export interface BuildChannelMaxBdDefaultManualCanaryInput {
  sources: {
    [K in keyof typeof CHANNELMAX_BD_DEFAULT_MANUAL_PINNED_SOURCES]: ChannelMaxBdDefaultManualSource;
  };
  createdAt: Date;
}

interface SourceBinding {
  path: string;
  file_sha256: string;
  byte_size: number;
}

export interface ChannelMaxDefaultRollbackEvidenceRequirements {
  schema_version: typeof CHANNELMAX_DEFAULT_ROLLBACK_EVIDENCE_SCHEMA;
  immutable: true;
  offline_only: true;
  external_mutations: 0;
  account: {
    account_id: typeof CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.account_id;
    host: typeof CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.host;
    seller_id: typeof CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.seller_id;
    site_id: typeof CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.site_id;
    site_name: typeof CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.site_name;
  };
  target: {
    item_id: typeof CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.item_id;
    sku: typeof CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.sku;
    asin: typeof CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.asin;
    minimum_price: typeof CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.minimum_price;
    maximum_price: typeof CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.maximum_price;
  };
  current_verdict: "DEFAULT_IMPORT_ENCODING_UNPROVEN";
  accepted_rollback_encoding: null;
  documented_candidate: {
    repricing_model_id: "35218";
    repricing_model_name: "Default";
    disposition: "DOCUMENTED_MODEL_ID_ONLY_NOT_PROVEN_IMPORT_ENCODING";
    may_be_emitted_in_rollback_tsv: false;
  };
  rejected_assumptions: readonly [
    {
      encoding: "OMIT_REPRICING_MODEL_ID_COLUMN";
      reason: string;
    },
    {
      encoding: "BLANK_REPRICING_MODEL_ID";
      reason: string;
    },
    {
      encoding: "NULL_LITERAL";
      reason: string;
    },
    {
      encoding: "35218";
      reason: string;
    },
  ];
  required_evidence: Array<{
    ordinal: number;
    code: string;
    mutation: boolean;
    exact_requirement: string;
  }>;
  terminal_success_state: {
    repricing_model_id: null;
    repricing_model_name: "Default";
    minimum_price: typeof CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.minimum_price;
    maximum_price: typeof CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.maximum_price;
    sku: typeof CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.sku;
    asin: typeof CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.asin;
    site_id: typeof CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.site_id;
  };
  next_safe_action: "CAPTURE_READ_ONLY_DEFAULT_MODEL_AND_ANALYZE_EVIDENCE_THEN_REBUILD_V2";
  body_sha256: string;
}

export interface ChannelMaxBdDefaultManualCanaryManifest {
  schema_version: typeof CHANNELMAX_BD_DEFAULT_MANUAL_CANARY_SCHEMA;
  immutable: true;
  offline_only: true;
  execution_authorized: false;
  uploaded: false;
  external_mutations: 0;
  created_at: string;
  verdict: "BLOCKED_DEFAULT_ROLLBACK_ENCODING_UNPROVEN";
  sources: {
    [K in keyof typeof CHANNELMAX_BD_DEFAULT_MANUAL_PINNED_SOURCES]: SourceBinding;
  };
  account: ChannelMaxDefaultRollbackEvidenceRequirements["account"];
  target: ChannelMaxDefaultRollbackEvidenceRequirements["target"] & {
    selling_venue: typeof CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.selling_venue;
    before_model_id: null;
    before_model_name: "Default";
    forward_model_id: "59021";
    forward_model_name: "Manual min/max";
  };
  forward_artifact: {
    file: "forward-to-manual-59021.tsv";
    sha256: string;
    byte_size: number;
    columns: typeof CHANNELMAX_BD_DEFAULT_MANUAL_CANARY_COLUMNS;
    exact_rows: 1;
    may_upload: false;
  };
  rollback_artifact: null;
  rollback_evidence_requirements: {
    file: "default-rollback-evidence-required.json";
    file_sha256: string;
    body_sha256: string;
  };
  protocol: {
    max_forward_uploads: 0;
    max_rollback_uploads: 0;
    forward_must_not_start_without_prearmed_exact_rollback: true;
    bounds_must_remain_unchanged_in_both_directions: true;
    fresh_prewrite_max_age_ms: 900_000;
    delayed_readback_minimum_ms: 3_900_000;
    ambiguity_policy: "TERMINAL_NO_RETRY";
  };
  blockers: readonly [
    {
      code: "DEFAULT_MODEL_IMPORT_ENCODING_UNPROVEN";
      detail: string;
    },
    {
      code: "EXACT_ROLLBACK_ARTIFACT_ABSENT";
      detail: string;
    },
    {
      code: "OWNER_APPROVAL_NOT_REQUESTED";
      detail: string;
    },
  ];
  body_sha256: string;
}

export interface ChannelMaxBdDefaultManualCanaryPackage {
  forwardTsv: string;
  evidenceRequirements: ChannelMaxDefaultRollbackEvidenceRequirements;
  evidenceRequirementsBytes: Buffer;
  manifest: ChannelMaxBdDefaultManualCanaryManifest;
}

export class ChannelMaxBdDefaultManualCanaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelMaxBdDefaultManualCanaryError";
  }
}

function fail(message: string): never {
  throw new ChannelMaxBdDefaultManualCanaryError(message);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown, label: string): JsonRecord {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function json(bytes: Buffer, label: string): JsonRecord {
  try {
    return record(JSON.parse(bytes.toString("utf8")), label);
  } catch {
    return fail(`${label} must contain valid JSON.`);
  }
}

function sourceBindings(
  input: BuildChannelMaxBdDefaultManualCanaryInput["sources"],
): ChannelMaxBdDefaultManualCanaryManifest["sources"] {
  const result = {} as ChannelMaxBdDefaultManualCanaryManifest["sources"];
  for (const key of Object.keys(
    CHANNELMAX_BD_DEFAULT_MANUAL_PINNED_SOURCES,
  ) as Array<keyof typeof CHANNELMAX_BD_DEFAULT_MANUAL_PINNED_SOURCES>) {
    const expected = CHANNELMAX_BD_DEFAULT_MANUAL_PINNED_SOURCES[key];
    const actual = input[key];
    if (
      actual.path !== expected.path ||
      sha256(actual.bytes) !== expected.file_sha256
    ) {
      return fail(`${key} is not the exact pinned source.`);
    }
    result[key] = {
      path: expected.path,
      file_sha256: expected.file_sha256,
      byte_size: actual.bytes.byteLength,
    };
  }
  return result;
}

function assertPinnedEvidence(
  input: BuildChannelMaxBdDefaultManualCanaryInput["sources"],
): void {
  const safeManifest = json(
    input.safe_manual_manifest.bytes,
    "safe Manual manifest",
  );
  const safeRows = Array.isArray(safeManifest.rows) ? safeManifest.rows : [];
  const bdSafeRow = safeRows
    .map((row, index) => record(row, `safe Manual row ${index + 1}`))
    .find((row) => row.sku === CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.sku);
  if (
    safeManifest.schema_version !==
      "uncrustables-channelmax-safe-base-offer-manual-assignment/v1" ||
    record(safeManifest.scope, "safe Manual scope").safe_assignment_rows !== 161 ||
    record(safeManifest.manual_model, "safe Manual model").id !== "59021" ||
    !bdSafeRow ||
    bdSafeRow.asin !== CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.asin ||
    bdSafeRow.minimum_selling_price !==
      CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.minimum_price ||
    bdSafeRow.maximum_selling_price !==
      CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.maximum_price ||
    bdSafeRow.target_repricing_model_id !== "59021"
  ) {
    return fail("The exact 161-row Manual assignment does not bind the BD canary.");
  }
  const safeTsv = input.safe_manual_tsv.bytes.toString("utf8");
  const safeTsvLines = safeTsv.split("\r\n").filter(Boolean);
  if (
    safeTsvLines[0] !== CHANNELMAX_BD_DEFAULT_MANUAL_CANARY_COLUMNS.join("\t") ||
    safeTsvLines.filter((line) => line.startsWith(`${CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.sku}\t`))
      .length !== 1 ||
    !safeTsvLines.includes(
      CHANNELMAX_BD_DEFAULT_MANUAL_FORWARD_TSV.split("\r\n")[1],
    )
  ) {
    return fail("The exact 161-row TSV does not contain one exact BD forward row.");
  }

  const prewrite = json(input.bd_prewrite.bytes, "BD prewrite");
  const prewriteAccount = record(prewrite.account, "BD prewrite account");
  const prewriteRow = record(prewrite.row, "BD prewrite row");
  const prewriteResult = record(
    prewrite.channelmax_result,
    "BD prewrite result",
  );
  if (
    prewrite.schema_version !== "channelmax-bd-default-inline-canary-prewrite/v1" ||
    prewriteAccount.host !== CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.host ||
    prewriteAccount.selected_site_id !== CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.site_id ||
    prewriteAccount.selected_site_name !== CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.site_name ||
    prewriteAccount.seller_id !== CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.seller_id ||
    prewriteRow.item_id !== CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.item_id ||
    prewriteRow.sku !== CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.sku ||
    prewriteRow.asin !== CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.asin ||
    prewriteRow.repricing_model_id !== null ||
    prewriteRow.repricing_model_name !== "Default" ||
    prewriteResult.persisted_minimum_price !==
      CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.minimum_price ||
    prewriteResult.persisted_maximum_price !==
      CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.maximum_price ||
    prewriteResult.repricing_model_changed !== false ||
    prewriteResult.result !== "PASS"
  ) {
    return fail("BD inline canary prewrite does not prove canonical Default bounds.");
  }

  const postwrite = json(input.bd_postwrite.bytes, "BD postwrite");
  const postwriteRow = record(postwrite.row, "BD postwrite row");
  const after = record(postwrite.after, "BD postwrite after");
  const independentReadback = record(
    postwrite.independent_readback,
    "BD independent readback",
  );
  if (
    postwrite.schema_version !== "channelmax-bd-default-inline-canary-postwrite/v1" ||
    postwrite.result !== "PASS" ||
    postwriteRow.item_id !== CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.item_id ||
    postwriteRow.sku !== CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.sku ||
    postwriteRow.asin !== CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.asin ||
    postwriteRow.site_id !== CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.site_id ||
    after.minimum_price !== CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.minimum_price ||
    after.maximum_price !== CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.maximum_price ||
    after.repricing_model_name !== "Default" ||
    independentReadback.minimum_price !==
      CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.minimum_price ||
    independentReadback.maximum_price !==
      CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.maximum_price
  ) {
    return fail("BD postwrite does not prove the exact canonical Default state.");
  }

  const discovery = json(
    input.manual_model_discovery.bytes,
    "Manual model discovery",
  );
  const observation = record(discovery.observation, "Manual discovery observation");
  const modelDiscovery = record(
    observation.manual_model_discovery,
    "Manual discovery result",
  );
  const models = Array.isArray(modelDiscovery.models)
    ? modelDiscovery.models.map((model, index) =>
        record(model, `Manual discovery model ${index + 1}`),
      )
    : [];
  if (
    discovery.schema_version !== "channelmax-manual-model-discovery/v1" ||
    observation.account_id !== CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.account_id ||
    record(modelDiscovery.canonical_manual_model, "canonical Manual model").id !==
      "59021" ||
    models.some((model) => model.id === "35218" || model.name === "Default")
  ) {
    return fail(
      "Current authenticated model discovery must prove Manual 59021 without pretending to prove Default encoding.",
    );
  }

  const guide = input.channelmax_guide.bytes.toString("utf8");
  const architecture = input.automation_architecture.bytes.toString("utf8");
  const preflightSource = input.current_preflight_source.bytes.toString("utf8");
  if (
    !guide.includes("`35218 Default`") ||
    !architecture.includes("no finite, tested operation restores `Default`") ||
    !preflightSource.includes("default_model_restore_mechanism: null") ||
    !preflightSource.includes('default_model_restore_status: "UNPROVEN"')
  ) {
    return fail("Pinned code/docs no longer support the fail-closed Default verdict.");
  }
}

function requirementsBody(): Omit<
  ChannelMaxDefaultRollbackEvidenceRequirements,
  "body_sha256"
> {
  const canary = CHANNELMAX_BD_DEFAULT_MANUAL_CANARY;
  return {
    schema_version: CHANNELMAX_DEFAULT_ROLLBACK_EVIDENCE_SCHEMA,
    immutable: true,
    offline_only: true,
    external_mutations: 0,
    account: {
      account_id: canary.account_id,
      host: canary.host,
      seller_id: canary.seller_id,
      site_id: canary.site_id,
      site_name: canary.site_name,
    },
    target: {
      item_id: canary.item_id,
      sku: canary.sku,
      asin: canary.asin,
      minimum_price: canary.minimum_price,
      maximum_price: canary.maximum_price,
    },
    current_verdict: "DEFAULT_IMPORT_ENCODING_UNPROVEN",
    accepted_rollback_encoding: null,
    documented_candidate: {
      repricing_model_id: "35218",
      repricing_model_name: "Default",
      disposition: "DOCUMENTED_MODEL_ID_ONLY_NOT_PROVEN_IMPORT_ENCODING",
      may_be_emitted_in_rollback_tsv: false,
    },
    rejected_assumptions: [
      {
        encoding: "OMIT_REPRICING_MODEL_ID_COLUMN",
        reason:
          "Existing bound-only writes preserve the current model; omission does not prove Manual-to-Default reassignment.",
      },
      {
        encoding: "BLANK_REPRICING_MODEL_ID",
        reason:
          "No reviewed Analyze preview or round-trip evidence proves that a blank clears the model instead of preserving or rejecting it.",
      },
      {
        encoding: "NULL_LITERAL",
        reason:
          "No ChannelMAX artifact or code contract accepts the literal NULL as a Default-model assignment.",
      },
      {
        encoding: "35218",
        reason:
          "The wiki documents 35218 as a Default model ID, but current authenticated discovery did not capture it and no upload/readback proves its rollback semantics.",
      },
    ],
    required_evidence: [
      {
        ordinal: 1,
        code: "FRESH_EXACT_DEFAULT_PREWRITE",
        mutation: false,
        exact_requirement:
          "Within 15 minutes of any canary, read the exact account/site/item/SKU/ASIN and prove model_id=null, model_name=Default, Min=66.95, Max=76.99.",
      },
      {
        ordinal: 2,
        code: "AUTHENTICATED_DEFAULT_MODEL_REGISTRY",
        mutation: false,
        exact_requirement:
          "Capture immutable authenticated raw DOM/API evidence from site 300 mapping the actual Default model name to its exact internal ID; the old wiki statement alone is insufficient.",
      },
      {
        ordinal: 3,
        code: "ROLLBACK_ANALYZE_PREVIEW",
        mutation: false,
        exact_requirement:
          "Analyze one exact rollback TSV without submitting it and capture the six-column mapping, one BD row, candidate model value/name, zero errors, and existing-SKU update disposition.",
      },
      {
        ordinal: 4,
        code: "PREARMED_EXACT_ROLLBACK",
        mutation: false,
        exact_requirement:
          "Only after steps 1-3, seal a one-row rollback TSV that preserves Min=66.95 and Max=76.99, bind its SHA/bytes, and obtain a separate current owner approval before forward is claimable.",
      },
      {
        ordinal: 5,
        code: "FORWARD_RECEIPT_AND_READBACK",
        mutation: true,
        exact_requirement:
          "Submit the exact forward artifact once; require one processed/one succeeded/zero failed and independent readback of model 59021 Manual min/max with unchanged bounds.",
      },
      {
        ordinal: 6,
        code: "ROLLBACK_RECEIPT_AND_READBACK",
        mutation: true,
        exact_requirement:
          "Submit the separately approved rollback artifact once; require one processed/one succeeded/zero failed and independent readback normalized to model_id=null, model_name=Default with unchanged bounds.",
      },
      {
        ordinal: 7,
        code: "DELAYED_DEFAULT_HOLD",
        mutation: false,
        exact_requirement:
          "After at least 65 minutes, repeat the exact ChannelMAX readback and prove the row remains null/Default at 66.95/76.99; any ambiguity is terminal and forbids rollout.",
      },
    ],
    terminal_success_state: {
      repricing_model_id: null,
      repricing_model_name: "Default",
      minimum_price: canary.minimum_price,
      maximum_price: canary.maximum_price,
      sku: canary.sku,
      asin: canary.asin,
      site_id: canary.site_id,
    },
    next_safe_action:
      "CAPTURE_READ_ONLY_DEFAULT_MODEL_AND_ANALYZE_EVIDENCE_THEN_REBUILD_V2",
  };
}

function manifestBody(
  manifest: ChannelMaxBdDefaultManualCanaryManifest,
): Omit<ChannelMaxBdDefaultManualCanaryManifest, "body_sha256"> {
  const body = { ...manifest } as Partial<ChannelMaxBdDefaultManualCanaryManifest>;
  delete body.body_sha256;
  return body as Omit<ChannelMaxBdDefaultManualCanaryManifest, "body_sha256">;
}

function requirementsWithoutSha(
  requirements: ChannelMaxDefaultRollbackEvidenceRequirements,
): Omit<ChannelMaxDefaultRollbackEvidenceRequirements, "body_sha256"> {
  const body = {
    ...requirements,
  } as Partial<ChannelMaxDefaultRollbackEvidenceRequirements>;
  delete body.body_sha256;
  return body as Omit<
    ChannelMaxDefaultRollbackEvidenceRequirements,
    "body_sha256"
  >;
}

export function buildChannelMaxBdDefaultManualCanaryPackage(
  input: BuildChannelMaxBdDefaultManualCanaryInput,
): ChannelMaxBdDefaultManualCanaryPackage {
  if (!Number.isFinite(input.createdAt.getTime())) {
    return fail("createdAt must be a valid canonical instant.");
  }
  const sources = sourceBindings(input.sources);
  assertPinnedEvidence(input.sources);

  const requirementsBodyValue = requirementsBody();
  const evidenceRequirements: ChannelMaxDefaultRollbackEvidenceRequirements = {
    ...requirementsBodyValue,
    body_sha256: sha256Json(requirementsBodyValue),
  };
  const evidenceRequirementsBytes = Buffer.from(
    `${JSON.stringify(evidenceRequirements, null, 2)}\n`,
    "utf8",
  );
  const canary = CHANNELMAX_BD_DEFAULT_MANUAL_CANARY;
  const body: Omit<ChannelMaxBdDefaultManualCanaryManifest, "body_sha256"> = {
    schema_version: CHANNELMAX_BD_DEFAULT_MANUAL_CANARY_SCHEMA,
    immutable: true,
    offline_only: true,
    execution_authorized: false,
    uploaded: false,
    external_mutations: 0,
    created_at: input.createdAt.toISOString(),
    verdict: "BLOCKED_DEFAULT_ROLLBACK_ENCODING_UNPROVEN",
    sources,
    account: evidenceRequirements.account,
    target: {
      ...evidenceRequirements.target,
      selling_venue: canary.selling_venue,
      before_model_id: null,
      before_model_name: "Default",
      forward_model_id: "59021",
      forward_model_name: "Manual min/max",
    },
    forward_artifact: {
      file: "forward-to-manual-59021.tsv",
      sha256: sha256(CHANNELMAX_BD_DEFAULT_MANUAL_FORWARD_TSV),
      byte_size: Buffer.byteLength(
        CHANNELMAX_BD_DEFAULT_MANUAL_FORWARD_TSV,
        "utf8",
      ),
      columns: CHANNELMAX_BD_DEFAULT_MANUAL_CANARY_COLUMNS,
      exact_rows: 1,
      may_upload: false,
    },
    rollback_artifact: null,
    rollback_evidence_requirements: {
      file: "default-rollback-evidence-required.json",
      file_sha256: sha256(evidenceRequirementsBytes),
      body_sha256: evidenceRequirements.body_sha256,
    },
    protocol: {
      max_forward_uploads: 0,
      max_rollback_uploads: 0,
      forward_must_not_start_without_prearmed_exact_rollback: true,
      bounds_must_remain_unchanged_in_both_directions: true,
      fresh_prewrite_max_age_ms: 900_000,
      delayed_readback_minimum_ms: 3_900_000,
      ambiguity_policy: "TERMINAL_NO_RETRY",
    },
    blockers: [
      {
        code: "DEFAULT_MODEL_IMPORT_ENCODING_UNPROVEN",
        detail:
          "No existing authenticated artifact proves the exact RepricingModelID encoding that restores ChannelMAX null/Default.",
      },
      {
        code: "EXACT_ROLLBACK_ARTIFACT_ABSENT",
        detail:
          "A rollback TSV is intentionally not emitted until the required read-only model-registry and Analyze evidence exists.",
      },
      {
        code: "OWNER_APPROVAL_NOT_REQUESTED",
        detail:
          "This offline package is diagnostic only and cannot be used as a mutation approval request.",
      },
    ],
  };
  const manifest: ChannelMaxBdDefaultManualCanaryManifest = {
    ...body,
    body_sha256: sha256Json(body),
  };
  verifyChannelMaxBdDefaultManualCanaryPackage({
    forwardTsv: CHANNELMAX_BD_DEFAULT_MANUAL_FORWARD_TSV,
    evidenceRequirements,
    evidenceRequirementsBytes,
    manifest,
  });
  return {
    forwardTsv: CHANNELMAX_BD_DEFAULT_MANUAL_FORWARD_TSV,
    evidenceRequirements,
    evidenceRequirementsBytes,
    manifest,
  };
}

export function verifyChannelMaxBdDefaultManualCanaryPackage(
  pkg: ChannelMaxBdDefaultManualCanaryPackage,
): void {
  const { manifest, evidenceRequirements } = pkg;
  if (
    manifest.schema_version !== CHANNELMAX_BD_DEFAULT_MANUAL_CANARY_SCHEMA ||
    manifest.immutable !== true ||
    manifest.offline_only !== true ||
    manifest.execution_authorized !== false ||
    manifest.uploaded !== false ||
    manifest.external_mutations !== 0 ||
    manifest.verdict !== "BLOCKED_DEFAULT_ROLLBACK_ENCODING_UNPROVEN" ||
    manifest.rollback_artifact !== null ||
    manifest.forward_artifact.may_upload !== false ||
    manifest.forward_artifact.exact_rows !== 1 ||
    manifest.forward_artifact.sha256 !== sha256(pkg.forwardTsv) ||
    manifest.forward_artifact.byte_size !== Buffer.byteLength(pkg.forwardTsv) ||
    pkg.forwardTsv !== CHANNELMAX_BD_DEFAULT_MANUAL_FORWARD_TSV ||
    manifest.body_sha256 !== sha256Json(manifestBody(manifest))
  ) {
    return fail("Canary manifest is invalid or execution-weakened.");
  }
  if (
    evidenceRequirements.schema_version !==
      CHANNELMAX_DEFAULT_ROLLBACK_EVIDENCE_SCHEMA ||
    evidenceRequirements.current_verdict !==
      "DEFAULT_IMPORT_ENCODING_UNPROVEN" ||
    evidenceRequirements.accepted_rollback_encoding !== null ||
    evidenceRequirements.documented_candidate.may_be_emitted_in_rollback_tsv !==
      false ||
    evidenceRequirements.required_evidence.length !== 7 ||
    evidenceRequirements.body_sha256 !==
      sha256Json(requirementsWithoutSha(evidenceRequirements)) ||
    pkg.evidenceRequirementsBytes.toString("utf8") !==
      `${JSON.stringify(evidenceRequirements, null, 2)}\n` ||
    manifest.rollback_evidence_requirements.file_sha256 !==
      sha256(pkg.evidenceRequirementsBytes) ||
    manifest.rollback_evidence_requirements.body_sha256 !==
      evidenceRequirements.body_sha256 ||
    manifest.protocol.max_forward_uploads !== 0 ||
    manifest.protocol.max_rollback_uploads !== 0 ||
    !manifest.protocol.forward_must_not_start_without_prearmed_exact_rollback ||
    !manifest.protocol.bounds_must_remain_unchanged_in_both_directions ||
    manifest.protocol.ambiguity_policy !== "TERMINAL_NO_RETRY"
  ) {
    return fail("Default rollback evidence gate is invalid or weakened.");
  }
  if (
    stableJson(manifest.target) !==
      stableJson({
        ...evidenceRequirements.target,
        selling_venue: CHANNELMAX_BD_DEFAULT_MANUAL_CANARY.selling_venue,
        before_model_id: null,
        before_model_name: "Default",
        forward_model_id: "59021",
        forward_model_name: "Manual min/max",
      }) ||
    evidenceRequirements.terminal_success_state.repricing_model_id !== null ||
    evidenceRequirements.terminal_success_state.repricing_model_name !==
      "Default" ||
    evidenceRequirements.terminal_success_state.minimum_price !== 66.95 ||
    evidenceRequirements.terminal_success_state.maximum_price !== 76.99
  ) {
    return fail("Canary identity, bounds, or terminal Default state drifted.");
  }
}
