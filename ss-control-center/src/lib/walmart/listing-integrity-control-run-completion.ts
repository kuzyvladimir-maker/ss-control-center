import {
  walmartListingIntegrityControlSha256,
  type WalmartListingIntegrityControlState,
} from "./listing-integrity-control-plane";

export const WALMART_LISTING_INTEGRITY_RUN_COMPLETION_SCHEMA =
  "walmart-listing-integrity-control-run-completion/v1" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const TERMINAL = new Set([
  "AUDITED_PASS",
  "QUALIFIED_PASS",
  "QUARANTINED_SOURCE_REQUIRED",
  "QUARANTINED_UNRESOLVED",
]);
const GALLERY_REQUIRED = new Set(["AUDITED_PASS", "QUALIFIED_PASS"]);

export interface WalmartListingIntegrityRunCompletionEvidence {
  schema_version: typeof WALMART_LISTING_INTEGRITY_RUN_COMPLETION_SCHEMA;
  completed_at: string;
  run: {
    run_id: string;
    pool_body_sha256: string;
    release_id_sha256: string;
    manifest_sha256: string;
  };
  terminal_items: Array<{
    ordinal: number;
    listing_key: string;
    sku: string;
    state: "AUDITED_PASS" | "QUALIFIED_PASS" | "QUARANTINED_SOURCE_REQUIRED" | "QUARANTINED_UNRESOLVED";
    state_body_sha256: string;
    gallery: null | {
      publication_status: "GALLERY_PUBLISHED" | "GALLERY_ALREADY_PUBLISHED";
      destination: string;
      verification_file_sha256: string;
      gallery_file_sha256: string;
    };
  }>;
  claims: {
    exact_run_fully_terminal: true;
    every_pass_gallery_published: true;
    next_epoch_requires_fresh_catalog: true;
    automatic_retry_allowed: false;
    automatic_replay_allowed: false;
  };
  external_effects: {
    walmart_reads: 0;
    walmart_writes: 0;
    model_calls: 0;
    paid_provider_calls: 0;
  };
  body_sha256: string;
}

type GalleryOutcome = {
  sku?: unknown;
  published?: {
    status?: unknown;
    destination?: unknown;
    verification_file_sha256?: unknown;
    gallery_file_sha256?: unknown;
  };
};

function fail(message: string): never {
  throw new Error(`WALMART_LISTING_RUN_COMPLETION_INVALID: ${message}`);
}

function exactText(value: unknown, label: string, maximum = 2_048): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const parsed = exactText(value, label, 64);
  if (!SHA256.test(parsed)) fail(`${label} is not SHA-256`);
  return parsed;
}

function instant(value: unknown, label: string): string {
  const parsed = exactText(value, label, 64);
  const date = new Date(parsed);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== parsed) {
    fail(`${label} is not canonical UTC`);
  }
  return parsed;
}

export function buildWalmartListingIntegrityRunCompletionEvidence(input: {
  run: {
    run_id: string;
    pool_body_sha256: string;
    release_id_sha256: string;
    manifest_sha256: string;
    status: string;
    items: readonly WalmartListingIntegrityControlState[];
  };
  galleries: readonly GalleryOutcome[];
  completed_at: string;
}): WalmartListingIntegrityRunCompletionEvidence {
  if (input.run.status !== "ACTIVE" || input.run.items.length < 1
    || input.run.items.some((item) => !TERMINAL.has(item.state))) {
    fail("run is not one fully terminal ACTIVE epoch");
  }
  const galleryBySku = new Map<string, GalleryOutcome>();
  for (const outcome of input.galleries) {
    const sku = exactText(outcome.sku, "gallery sku", 512);
    if (galleryBySku.has(sku)) fail(`duplicate gallery outcome for ${sku}`);
    galleryBySku.set(sku, outcome);
  }
  const terminalItems = [...input.run.items]
    .sort((left, right) => left.identity.ordinal - right.identity.ordinal)
    .map((item) => {
      const raw = galleryBySku.get(item.identity.sku);
      if (!GALLERY_REQUIRED.has(item.state)) {
        if (raw) fail(`quarantined item has a completion gallery: ${item.identity.sku}`);
        return {
          ordinal: item.identity.ordinal,
          listing_key: item.identity.listing_key,
          sku: item.identity.sku,
          state: item.state as "QUARANTINED_SOURCE_REQUIRED" | "QUARANTINED_UNRESOLVED",
          state_body_sha256: digest(item.body_sha256, "terminal state body SHA"),
          gallery: null,
        };
      }
      const published = raw?.published;
      if (!published || !["GALLERY_PUBLISHED", "GALLERY_ALREADY_PUBLISHED"].includes(
        String(published.status),
      )) {
        fail(`PASS item lacks a published factual gallery: ${item.identity.sku}`);
      }
      galleryBySku.delete(item.identity.sku);
      return {
        ordinal: item.identity.ordinal,
        listing_key: item.identity.listing_key,
        sku: item.identity.sku,
        state: item.state as "AUDITED_PASS" | "QUALIFIED_PASS",
        state_body_sha256: digest(item.body_sha256, "terminal state body SHA"),
        gallery: {
          publication_status: published.status as "GALLERY_PUBLISHED" | "GALLERY_ALREADY_PUBLISHED",
          destination: exactText(published.destination, "gallery destination", 8_192),
          verification_file_sha256: digest(
            published.verification_file_sha256,
            "gallery verification file SHA",
          ),
          gallery_file_sha256: digest(published.gallery_file_sha256, "gallery HTML file SHA"),
        },
      };
    });
  if (galleryBySku.size !== 0) fail("gallery outcomes include a non-PASS run item");
  const body = {
    schema_version: WALMART_LISTING_INTEGRITY_RUN_COMPLETION_SCHEMA,
    completed_at: instant(input.completed_at, "completed_at"),
    run: {
      run_id: exactText(input.run.run_id, "run_id", 512),
      pool_body_sha256: digest(input.run.pool_body_sha256, "pool body SHA"),
      release_id_sha256: digest(input.run.release_id_sha256, "release SHA"),
      manifest_sha256: digest(input.run.manifest_sha256, "manifest SHA"),
    },
    terminal_items: terminalItems,
    claims: {
      exact_run_fully_terminal: true as const,
      every_pass_gallery_published: true as const,
      next_epoch_requires_fresh_catalog: true as const,
      automatic_retry_allowed: false as const,
      automatic_replay_allowed: false as const,
    },
    external_effects: {
      walmart_reads: 0 as const,
      walmart_writes: 0 as const,
      model_calls: 0 as const,
      paid_provider_calls: 0 as const,
    },
  };
  return Object.freeze({
    ...body,
    body_sha256: walmartListingIntegrityControlSha256(body),
  });
}

export function verifyWalmartListingIntegrityRunCompletionEvidence(
  evidence: WalmartListingIntegrityRunCompletionEvidence,
): void {
  const body = { ...evidence };
  delete (body as Partial<WalmartListingIntegrityRunCompletionEvidence>).body_sha256;
  if (evidence.schema_version !== WALMART_LISTING_INTEGRITY_RUN_COMPLETION_SCHEMA
    || walmartListingIntegrityControlSha256(body) !== evidence.body_sha256
    || evidence.terminal_items.length < 1
    || evidence.claims.exact_run_fully_terminal !== true
    || evidence.claims.every_pass_gallery_published !== true
    || evidence.claims.next_epoch_requires_fresh_catalog !== true
    || evidence.claims.automatic_retry_allowed !== false
    || evidence.claims.automatic_replay_allowed !== false
    || Object.values(evidence.external_effects).some((value) => value !== 0)) {
    fail("completion evidence seal or policy differs");
  }
  const ordinals = new Set<number>();
  const listings = new Set<string>();
  for (const item of evidence.terminal_items) {
    if (!Number.isSafeInteger(item.ordinal) || item.ordinal < 1
      || ordinals.has(item.ordinal) || listings.has(item.listing_key)
      || !TERMINAL.has(item.state)
      || (GALLERY_REQUIRED.has(item.state)) !== (item.gallery !== null)) {
      fail("terminal item sequence or gallery boundary differs");
    }
    ordinals.add(item.ordinal);
    listings.add(item.listing_key);
    digest(item.state_body_sha256, "terminal state body SHA");
    if (item.gallery) {
      digest(item.gallery.verification_file_sha256, "gallery verification file SHA");
      digest(item.gallery.gallery_file_sha256, "gallery HTML file SHA");
    }
  }
}
