/** Live MP_ITEM schema retrieval and validation.
 *
 * Walmart changes required/conditional attributes by spec version and product
 * type. A locally plausible payload is therefore not publication-safe. Every
 * real new-item submission must validate against the schema returned by Get
 * Spec immediately before the multipart feed is sent.
 */

import Ajv from "ajv";

import type { WalmartRequestOptions } from "@/lib/walmart/client";
import {
  sha256WalmartJson,
  type WalmartPublicListingContract,
} from "../walmart-listing-contract";
import { getConfiguredWalmartSpecVersion } from "./walmart-item-contract";

export interface WalmartItemApiResponse {
  status: number;
  ok: boolean;
  body: unknown;
  correlationId: string;
}

export interface WalmartItemApiClient {
  requestRaw(
    method: string,
    path: string,
    options?: WalmartRequestOptions,
  ): Promise<WalmartItemApiResponse>;
}

export interface WalmartSpecIssue {
  code: string;
  path?: string;
  message: string;
}

export interface WalmartLiveSpecValidation {
  valid: boolean;
  spec_version: string;
  schema_sha256: string | null;
  fetched_at: string;
  issues: WalmartSpecIssue[];
}

export interface WalmartFetchedItemSpecSchema {
  schema: Record<string, unknown>;
  schema_sha256: string;
  fetched_at: string;
  /** Unconditional JSON-data paths found in draft-07 `required` arrays. */
  required_paths: string[];
  /** Paths required only inside oneOf/anyOf/then/else/dependent branches. */
  conditional_required_paths: string[];
}

export class WalmartItemSpecFetchError extends Error {
  readonly issue: WalmartSpecIssue;
  readonly fetched_at: string;

  constructor(issue: WalmartSpecIssue, fetchedAt: string) {
    super(issue.message);
    this.name = "WalmartItemSpecFetchError";
    this.issue = issue;
    this.fetched_at = fetchedAt;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractSchema(value: unknown): Record<string, unknown> | null {
  const response = record(value);
  if (!response) return null;
  const candidate = response.schema ?? response;
  if (typeof candidate === "string") {
    try {
      return record(JSON.parse(candidate));
    } catch {
      return null;
    }
  }
  return record(candidate);
}

function dataPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function localSchemaRef(
  root: Record<string, unknown>,
  ref: string,
): Record<string, unknown> | null {
  if (!ref.startsWith("#/")) return null;
  let current: unknown = root;
  for (const rawPart of ref.slice(2).split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    current = record(current)?.[part];
  }
  return record(current);
}

function collectRequiredDataPaths(schema: Record<string, unknown>): {
  required: string[];
  conditional: string[];
} {
  const required = new Set<string>();
  const conditional = new Set<string>();
  const visitedRefs = new Set<string>();

  const walk = (
    nodeValue: unknown,
    currentPath: string,
    isConditional: boolean,
  ): void => {
    const node = record(nodeValue);
    if (!node) return;

    if (typeof node.$ref === "string") {
      const key = `${node.$ref}\u0000${currentPath}\u0000${isConditional}`;
      if (!visitedRefs.has(key)) {
        visitedRefs.add(key);
        const target = localSchemaRef(schema, node.$ref);
        if (target) walk(target, currentPath, isConditional);
      }
    }

    if (Array.isArray(node.required)) {
      for (const key of node.required) {
        if (typeof key !== "string" || !key) continue;
        (isConditional ? conditional : required).add(dataPath(currentPath, key));
      }
    }

    const properties = record(node.properties);
    if (properties) {
      for (const [key, child] of Object.entries(properties)) {
        walk(child, dataPath(currentPath, key), isConditional);
      }
    }
    if (record(node.items)) walk(node.items, `${currentPath}[*]`, isConditional);

    if (Array.isArray(node.allOf)) {
      node.allOf.forEach((child) => walk(child, currentPath, isConditional));
    }
    for (const keyword of ["anyOf", "oneOf"] as const) {
      const branches = node[keyword];
      if (Array.isArray(branches)) {
        branches.forEach((child) => walk(child, currentPath, true));
      }
    }
    for (const keyword of ["then", "else"] as const) {
      if (node[keyword] != null) walk(node[keyword], currentPath, true);
    }
    for (const keyword of [
      "dependencies",
      "dependentSchemas",
      "dependentRequired",
    ] as const) {
      const dependencyMap = record(node[keyword]);
      if (!dependencyMap) continue;
      for (const dependency of Object.values(dependencyMap)) {
        if (Array.isArray(dependency)) {
          for (const key of dependency) {
            if (typeof key === "string" && key) {
              conditional.add(dataPath(currentPath, key));
            }
          }
        } else {
          walk(dependency, currentPath, true);
        }
      }
    }
    // `if.required` is a predicate, not an unconditional data requirement.
  };

  walk(schema, "$", false);
  return {
    required: [...required].sort(),
    conditional: [...conditional].sort(),
  };
}

function createWalmartAjv(): Ajv.Ajv {
  // Walmart's consolidated schemas are JSON Schema draft-07 compatible but
  // include formats that do not affect payload truth. Unknown formats are
  // ignored; structural, required, conditional and enum rules remain active.
  const ajv = new Ajv({
    allErrors: true,
    jsonPointers: true,
    unknownFormats: "ignore",
    verbose: true,
  });
  // Walmart augments draft-07 with minEntries/maxEntries on image arrays.
  // Ajv otherwise treats those annotations as unknown and silently skips the
  // image-count rule, which would make a locally "valid" item fail ingestion.
  ajv.addKeyword("minEntries", {
    type: "array",
    metaSchema: { type: "integer", minimum: 0 },
    validate: (minimum: number, data: unknown) =>
      Array.isArray(data) && data.length >= minimum,
    errors: false,
  });
  ajv.addKeyword("maxEntries", {
    type: "array",
    metaSchema: { type: "integer", minimum: 0 },
    validate: (maximum: number, data: unknown) =>
      Array.isArray(data) && data.length <= maximum,
    errors: false,
  });
  return ajv;
}

/** Read-only bootstrap for a product type that does not yet have a persisted
 * Walmart public contract. The caller pins the returned hash/timestamp before
 * building and validating a candidate payload. */
export async function fetchWalmartItemSpecSchema(
  client: WalmartItemApiClient,
  input: { version: string; productType: string; now?: Date },
): Promise<WalmartFetchedItemSpecSchema> {
  const fetchedAt = (input.now ?? new Date()).toISOString();
  const version = input.version.trim();
  const productType = input.productType.trim();
  const configuredVersion = getConfiguredWalmartSpecVersion();
  if (version !== configuredVersion) {
    throw new WalmartItemSpecFetchError(
      {
        code: "WALMART_SPEC_VERSION_NOT_CURRENT",
        message: `Get Spec version ${version || "<empty>"} is not configured current version ${configuredVersion}`,
      },
      fetchedAt,
    );
  }
  if (!productType) {
    throw new WalmartItemSpecFetchError(
      {
        code: "WALMART_PRODUCT_TYPE_MISSING",
        message: "Get Spec requires an exact Walmart product type",
      },
      fetchedAt,
    );
  }

  let response: WalmartItemApiResponse;
  try {
    response = await client.requestRaw("POST", "/items/spec", {
      body: {
        feedType: "MP_ITEM",
        version,
        productTypes: [productType],
      },
      noRetryOn429: true,
    });
  } catch (error) {
    throw new WalmartItemSpecFetchError(
      {
        code: "WALMART_GET_SPEC_FAILED",
        message: `Get Spec request failed: ${error instanceof Error ? error.message : String(error)}`,
      },
      fetchedAt,
    );
  }

  if (response.status !== 200 || !response.ok) {
    throw new WalmartItemSpecFetchError(
      {
        code: "WALMART_GET_SPEC_HTTP_ERROR",
        message: `Get Spec returned HTTP ${response.status} (cid=${response.correlationId || "unknown"})`,
      },
      fetchedAt,
    );
  }
  const schema = extractSchema(response.body);
  if (!schema) {
    throw new WalmartItemSpecFetchError(
      {
        code: "WALMART_GET_SPEC_MALFORMED",
        message: "Get Spec response did not contain a JSON schema",
      },
      fetchedAt,
    );
  }
  try {
    createWalmartAjv().compile(schema);
  } catch (error) {
    throw new WalmartItemSpecFetchError(
      {
        code: "WALMART_SPEC_COMPILE_FAILED",
        message: `Could not compile Walmart schema: ${error instanceof Error ? error.message : String(error)}`,
      },
      fetchedAt,
    );
  }
  const paths = collectRequiredDataPaths(schema);
  return {
    schema,
    schema_sha256: sha256WalmartJson(schema),
    fetched_at: fetchedAt,
    required_paths: paths.required,
    conditional_required_paths: paths.conditional,
  };
}

/** Validate a complete MP_ITEM payload against an already fetched schema.
 *
 * This function is deliberately network-free. Certification can fetch Get Spec
 * once, pin the returned schema hash in the public contract, build the complete
 * payload, and validate that payload without consuming a second Get Spec request.
 * The mutation path must still use `validateWalmartPayloadAgainstLiveSpec`
 * immediately before the feed POST so schema drift remains fail-closed.
 */
export function validateWalmartPayloadAgainstFetchedSpec(args: {
  fetchedSpec: WalmartFetchedItemSpecSchema;
  contract: WalmartPublicListingContract;
  payload: Record<string, unknown>;
}): WalmartLiveSpecValidation {
  const computedDigest = sha256WalmartJson(args.fetchedSpec.schema);
  if (computedDigest !== args.fetchedSpec.schema_sha256) {
    return {
      valid: false,
      spec_version: args.contract.spec_version,
      schema_sha256: computedDigest,
      fetched_at: args.fetchedSpec.fetched_at,
      issues: [
        {
          code: "WALMART_FETCHED_SPEC_HASH_MISMATCH",
          message:
            `Fetched schema bytes hash to ${computedDigest}, not the envelope hash ` +
            args.fetchedSpec.schema_sha256,
        },
      ],
    };
  }

  if (
    args.contract.spec_schema_hash &&
    args.contract.spec_schema_hash !== computedDigest
  ) {
    return {
      valid: false,
      spec_version: args.contract.spec_version,
      schema_sha256: computedDigest,
      fetched_at: args.fetchedSpec.fetched_at,
      issues: [
        {
          code: "WALMART_SPEC_HASH_MISMATCH",
          message:
            `Fetched schema hash ${computedDigest} does not match pinned contract hash ` +
            args.contract.spec_schema_hash,
        },
      ],
    };
  }

  try {
    const validate = createWalmartAjv().compile(args.fetchedSpec.schema);
    const valid = Boolean(validate(args.payload));
    const issues: WalmartSpecIssue[] = valid
      ? []
      : (validate.errors ?? []).map((error) => ({
          code: "WALMART_SPEC_VALIDATION_FAILED",
          path: error.dataPath || error.schemaPath,
          message: error.message || "Payload failed Walmart item schema validation",
        }));
    return {
      valid,
      spec_version: args.contract.spec_version,
      schema_sha256: computedDigest,
      fetched_at: args.fetchedSpec.fetched_at,
      issues,
    };
  } catch (error) {
    return {
      valid: false,
      spec_version: args.contract.spec_version,
      schema_sha256: computedDigest,
      fetched_at: args.fetchedSpec.fetched_at,
      issues: [
        {
          code: "WALMART_SPEC_COMPILE_FAILED",
          message: `Could not compile Walmart schema: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

/** Fetch the exact product-type schema and validate the complete feed. This is
 * intentionally fail-closed: authentication, throttling, malformed schema,
 * unsupported schema keywords, and validation failures all prevent a feed
 * mutation rather than falling back to stale local assumptions. */
export async function validateWalmartPayloadAgainstLiveSpec(args: {
  client: WalmartItemApiClient;
  contract: WalmartPublicListingContract;
  payload: Record<string, unknown>;
  now?: Date;
}): Promise<WalmartLiveSpecValidation> {
  const fetchedAt = (args.now ?? new Date()).toISOString();
  let fetched: WalmartFetchedItemSpecSchema;
  try {
    fetched = await fetchWalmartItemSpecSchema(args.client, {
      version: args.contract.spec_version,
      productType: args.contract.product_type,
      now: args.now,
    });
  } catch (error) {
    const issue = error instanceof WalmartItemSpecFetchError
      ? error.issue
      : {
          code: "WALMART_GET_SPEC_FAILED",
          message: `Get Spec request failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    return {
      valid: false,
      spec_version: args.contract.spec_version,
      schema_sha256: null,
      fetched_at:
        error instanceof WalmartItemSpecFetchError
          ? error.fetched_at
          : fetchedAt,
      issues: [issue],
    };
  }
  return validateWalmartPayloadAgainstFetchedSpec({
    fetchedSpec: fetched,
    contract: args.contract,
    payload: args.payload,
  });
}
