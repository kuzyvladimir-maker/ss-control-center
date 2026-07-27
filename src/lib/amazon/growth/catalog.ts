/**
 * Amazon Catalog Items API (2022-04-01) — fetch an ASIN's current catalog content
 * even when our own offer is inactive/gone. Used by recovery to source the content
 * to restore a lost winner with (when we have no snapshot of our own).
 */

import { spApiGet, MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";

export interface CatalogContent {
  asin: string;
  title: string | null;
  brand: string | null;
  mainImageUrl: string | null;
  imageCount: number;
  bullets: string[];
  productType: string | null;
}

export async function getCatalogContent(storeIndex: number, asin: string): Promise<CatalogContent | null> {
  try {
    const res = (await spApiGet(`/catalog/2022-04-01/items/${encodeURIComponent(asin)}`, {
      storeId: `store${storeIndex}`,
      params: { marketplaceIds: MARKETPLACE_ID, includedData: "attributes,images,summaries,productTypes" },
    })) as {
      summaries?: Array<{ marketplaceId?: string; itemName?: string; brand?: string }>;
      images?: Array<{ marketplaceId?: string; images?: Array<{ link?: string; variant?: string; height?: number }> }>;
      attributes?: Record<string, Array<{ value?: string }>>;
      productTypes?: Array<{ productType?: string }>;
    };
    const summary = res.summaries?.find((s) => s.marketplaceId === MARKETPLACE_ID) ?? res.summaries?.[0];
    const imgSet = res.images?.find((i) => i.marketplaceId === MARKETPLACE_ID) ?? res.images?.[0];
    const main = imgSet?.images?.find((im) => im.variant === "MAIN") ?? imgSet?.images?.[0];
    const bullets = (res.attributes?.bullet_point ?? []).map((b) => b.value ?? "").filter(Boolean);
    return {
      asin,
      title: summary?.itemName ?? null,
      brand: summary?.brand ?? null,
      mainImageUrl: main?.link ?? null,
      imageCount: imgSet?.images?.length ?? 0,
      bullets,
      productType: res.productTypes?.[0]?.productType ?? null,
    };
  } catch {
    return null;
  }
}
