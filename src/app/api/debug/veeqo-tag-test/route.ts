import { NextRequest, NextResponse } from "next/server";
import { veeqoFetch } from "@/lib/veeqo/client";
import { getOrderTags } from "@/lib/veeqo/tags";

export const dynamic = "force-dynamic";

interface VeeqoOrder {
  id?: number | string;
  number?: string;
  tags?: unknown;
  [k: string]: unknown;
}

/**
 * Try ONE Veeqo tag-attach variant against a single order. Single
 * variant per request keeps us inside Vercel Hobby's 10s function
 * timeout (each variant = 3 Veeqo calls, plus the order PUT/POST).
 *
 * Usage:
 *   GET /api/debug/veeqo-tag-test?orderId=1668694461&tag=Placed&variant=G
 *
 * Returns the request body sent, before/after tag names, whether the
 * tag was actually persisted, and any API error.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const orderIdRaw = url.searchParams.get("orderId");
  const tagName = url.searchParams.get("tag") ?? "Placed";
  const variantKey = (url.searchParams.get("variant") ?? "B").toUpperCase();

  if (!orderIdRaw) {
    return NextResponse.json(
      { error: "?orderId=<numeric_veeqo_order_id> required" },
      { status: 400 }
    );
  }
  const orderId = orderIdRaw;

  // Resolve tag id
  const allTags = (await veeqoFetch(`/tags`)) as Array<{
    id: number;
    name: string;
  }>;
  const tagRecord = allTags.find((t) => t.name === tagName);
  if (!tagRecord) {
    return NextResponse.json(
      {
        error: `Tag '${tagName}' not found. Available: ${allTags
          .map((t) => t.name)
          .join(", ")}`,
      },
      { status: 404 }
    );
  }
  const tagId = tagRecord.id;

  type Variant = {
    label: string;
    method: "PUT" | "POST";
    path: string;
    body: unknown;
  };

  const VARIANTS: Record<string, Variant> = {
    A: {
      label: "tags_attributes [{name}]",
      method: "PUT",
      path: `/orders/${orderId}`,
      body: { order: { tags_attributes: [{ name: tagName }] } },
    },
    B: {
      label: "tags_attributes [{name, colour}]",
      method: "PUT",
      path: `/orders/${orderId}`,
      body: { order: { tags_attributes: [{ name: tagName, colour: "blue" }] } },
    },
    C: {
      label: "tag_list array",
      method: "PUT",
      path: `/orders/${orderId}`,
      body: { order: { tag_list: [tagName] } },
    },
    D: {
      label: "tag_list csv string",
      method: "PUT",
      path: `/orders/${orderId}`,
      body: { order: { tag_list: tagName } },
    },
    E: {
      label: "tags [{name}]",
      method: "PUT",
      path: `/orders/${orderId}`,
      body: { order: { tags: [{ name: tagName }] } },
    },
    F: {
      label: "tags [name]",
      method: "PUT",
      path: `/orders/${orderId}`,
      body: { order: { tags: [tagName] } },
    },
    G: {
      label: "tags_attributes [{id}]",
      method: "PUT",
      path: `/orders/${orderId}`,
      body: { order: { tags_attributes: [{ id: tagId }] } },
    },
    H: {
      label: "tag_ids [id]",
      method: "PUT",
      path: `/orders/${orderId}`,
      body: { order: { tag_ids: [tagId] } },
    },
    I: {
      label: "tags [{id}]",
      method: "PUT",
      path: `/orders/${orderId}`,
      body: { order: { tags: [{ id: tagId }] } },
    },
    K: {
      label: "POST /orders/{id}/tags body{tag:{id}}",
      method: "POST",
      path: `/orders/${orderId}/tags`,
      body: { tag: { id: tagId } },
    },
    L: {
      label: "POST /orders/{id}/tags body{id}",
      method: "POST",
      path: `/orders/${orderId}/tags`,
      body: { id: tagId },
    },
    M: {
      label: "POST /orders/{id}/tags body{tag_id}",
      method: "POST",
      path: `/orders/${orderId}/tags`,
      body: { tag_id: tagId },
    },
    N: {
      label: "POST /orders/{id}/tags body{name}",
      method: "POST",
      path: `/orders/${orderId}/tags`,
      body: { name: tagName },
    },
    O: {
      label: "PUT /orders/{id}/tags body{tag_ids:[id]}",
      method: "PUT",
      path: `/orders/${orderId}/tags`,
      body: { tag_ids: [tagId] },
    },
    P: {
      label: "POST /bulk_tagging body{order_ids,tag_ids}",
      method: "POST",
      path: `/bulk_tagging`,
      body: { order_ids: [Number(orderId)], tag_ids: [tagId] },
    },
    Q: {
      label: "PUT /bulk_tagging body{order_ids,tag_ids}",
      method: "PUT",
      path: `/bulk_tagging`,
      body: { order_ids: [Number(orderId)], tag_ids: [tagId] },
    },
  };

  const variant = VARIANTS[variantKey];
  if (!variant) {
    return NextResponse.json(
      {
        error: `Unknown variant ${variantKey}. Available: ${Object.keys(
          VARIANTS
        ).join(", ")}`,
      },
      { status: 400 }
    );
  }

  const beforeOrder = (await veeqoFetch(`/orders/${orderId}`)) as VeeqoOrder;
  const beforeNames = getOrderTags(beforeOrder as never).map((t) => t.name);

  let apiResponse: unknown = null;
  let errorMsg: string | undefined;
  try {
    apiResponse = await veeqoFetch(variant.path, {
      method: variant.method,
      body: JSON.stringify(variant.body),
    });
  } catch (e: unknown) {
    errorMsg = e instanceof Error ? e.message : String(e);
  }

  const afterOrder = (await veeqoFetch(`/orders/${orderId}`)) as VeeqoOrder;
  const afterNames = getOrderTags(afterOrder as never).map((t) => t.name);

  return NextResponse.json({
    variant: variantKey,
    label: variant.label,
    method: variant.method,
    path: variant.path,
    body: variant.body,
    before: beforeNames,
    after: afterNames,
    added: !beforeNames.includes(tagName) && afterNames.includes(tagName),
    error: errorMsg,
    apiResponseTags:
      (apiResponse as { tags?: unknown } | null)?.tags ?? null,
  });
}
