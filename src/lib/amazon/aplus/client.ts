/**
 * Amazon A+ Content Management API (2020-11-01) client.
 *
 * Read + write wrappers for the A+ Content Factory. Write access is confirmed
 * (role "Product Listing — includes A+ content"; validation returns 400 not 403).
 *
 * Flow to publish: validate → create document → associate ASIN(s) → submit for
 * approval. Always validate before create; nothing is auto-published without the
 * human approve step (see the factory's approve UI).
 *
 * Rules the generated documents must satisfy live in:
 *   docs/wiki/aplus-content-knowledge-base.md  (technical + policy)
 *   docs/wiki/aplus-ip-giftset-rules.md        (IP / gift-set gate)
 */

import { spApiGet, spApiPost, MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";

const BASE = "/aplus/2020-11-01";

export interface AplusMetadataRecord {
  contentReferenceKey: string;
  contentMetadata?: { name?: string; marketplaceId?: string; status?: string; badgeSet?: string[]; updateTime?: string };
}
export interface AplusContentModule {
  contentModuleType: string;
  [k: string]: unknown;
}
export interface AplusContentDocument {
  name?: string;
  contentType?: string;
  contentSubType?: string;
  locale?: string;
  contentModuleList?: AplusContentModule[];
}

function storeId(storeIndex: number) {
  return `store${storeIndex}`;
}

/** List all A+ content documents for a store (paginates). */
export async function listContentDocuments(storeIndex: number): Promise<AplusMetadataRecord[]> {
  const out: AplusMetadataRecord[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, string> = { marketplaceId: MARKETPLACE_ID, pageSize: "20" };
    if (pageToken) params.pageToken = pageToken;
    const res = (await spApiGet(`${BASE}/contentDocuments`, { storeId: storeId(storeIndex), params })) as {
      contentMetadataRecords?: AplusMetadataRecord[];
      nextPageToken?: string;
    };
    out.push(...(res.contentMetadataRecords ?? []));
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}

/** Fetch one content document's full content + metadata. */
export async function getContentDocument(storeIndex: number, key: string): Promise<AplusContentDocument | null> {
  const res = (await spApiGet(`${BASE}/contentDocuments/${encodeURIComponent(key)}`, {
    storeId: storeId(storeIndex),
    params: { marketplaceId: MARKETPLACE_ID, includedDataSet: "METADATA,CONTENTS" },
  })) as { contentRecord?: { contentDocument?: AplusContentDocument } };
  return res.contentRecord?.contentDocument ?? null;
}

/** ASINs a content document is associated with. */
export async function listAsinRelations(storeIndex: number, key: string): Promise<string[]> {
  const res = (await spApiGet(`${BASE}/contentDocuments/${encodeURIComponent(key)}/asins`, {
    storeId: storeId(storeIndex),
    params: { marketplaceId: MARKETPLACE_ID, includedDataSet: "METADATA" },
  })) as { asinMetadataSet?: Array<{ asin?: string }> };
  return (res.asinMetadataSet ?? []).map((a) => a.asin ?? "").filter(Boolean);
}

export interface AplusIssue { code?: string; message?: string; severity?: string }
export interface ValidationResult { valid: boolean; issues: AplusIssue[]; raw: unknown }

/** Validate a content document against ASIN(s) — non-mutating; gate before create. */
export async function validateContent(
  storeIndex: number, contentDocument: AplusContentDocument, asins: string[],
): Promise<ValidationResult> {
  const res = (await spApiPost(`${BASE}/contentAsinValidations`, { contentDocument }, {
    storeId: storeId(storeIndex),
    params: { marketplaceId: MARKETPLACE_ID, asinSet: asins.join(",") },
  })) as { errors?: AplusIssue[]; warnings?: AplusIssue[] };
  const issues = [...(res.errors ?? []), ...(res.warnings ?? [])];
  return { valid: (res.errors ?? []).length === 0, issues, raw: res };
}

/** Create a new A+ content document (draft). Returns its contentReferenceKey. */
export async function createContentDocument(storeIndex: number, contentDocument: AplusContentDocument): Promise<string> {
  const res = (await spApiPost(`${BASE}/contentDocuments`, { contentDocument }, {
    storeId: storeId(storeIndex),
    params: { marketplaceId: MARKETPLACE_ID },
  })) as { contentReferenceKey?: string };
  if (!res.contentReferenceKey) throw new Error("create returned no contentReferenceKey");
  return res.contentReferenceKey;
}

/** Associate a content document with ASIN(s). */
export async function associateAsins(storeIndex: number, key: string, asins: string[]): Promise<void> {
  await spApiPost(`${BASE}/contentDocuments/${encodeURIComponent(key)}/asins`, { asinSet: asins }, {
    storeId: storeId(storeIndex),
    params: { marketplaceId: MARKETPLACE_ID },
  });
}

/** Submit a content document for Amazon approval/publishing. */
export async function submitForApproval(storeIndex: number, key: string): Promise<unknown> {
  return spApiPost(`${BASE}/contentDocuments/${encodeURIComponent(key)}/approvalSubmissions`, {}, {
    storeId: storeId(storeIndex),
    params: { marketplaceId: MARKETPLACE_ID },
  });
}
