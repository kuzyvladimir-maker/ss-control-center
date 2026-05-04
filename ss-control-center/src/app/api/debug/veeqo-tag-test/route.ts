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
 * Try multiple Veeqo PUT shapes for adding a tag to an order, and report
 * which (if any) actually persists. Use:
 *   GET /api/debug/veeqo-tag-test?number=113-5805021-2730651&tag=Placed
 *
 * Each variant runs in isolation:
 *   1. Re-fetches the order
 *   2. Snapshots current tag names
 *   3. Sends a single PUT with that variant's shape
 *   4. Re-fetches and compares
 *   5. Records whether the tag was added (and if not, surfaces the API
 *      response so we can see what Veeqo actually accepted)
 *
 * If a variant adds the tag, we DON'T remove it (we want to see at the
 * end which variant won). Subsequent variants will see the tag already
 * present and report "already-present, skipped".
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const number = url.searchParams.get("number");
  const tagName = url.searchParams.get("tag") ?? "Placed";
  if (!number) {
    return NextResponse.json(
      { error: "?number=<order_number> required" },
      { status: 400 }
    );
  }

  // Resolve order
  let order: VeeqoOrder | null = null;
  let page = 1;
  while (page <= 50 && !order) {
    const orders = (await veeqoFetch(
      `/orders?status=awaiting_fulfillment&page_size=100&page=${page}`
    )) as VeeqoOrder[];
    if (!Array.isArray(orders) || orders.length === 0) break;
    order = orders.find((o) => o.number === number) ?? null;
    if (orders.length < 100) break;
    page++;
  }
  if (!order) {
    return NextResponse.json(
      { error: `No awaiting_fulfillment order found with number=${number}` },
      { status: 404 }
    );
  }
  const orderId = order.id!;

  type Variant = {
    label: string;
    body: () => unknown;
  };

  // Resolve tag id from /tags
  const allTags = (await veeqoFetch(`/tags`)) as Array<{
    id: number;
    name: string;
  }>;
  const tagRecord = allTags.find((t) => t.name === tagName);
  if (!tagRecord) {
    return NextResponse.json(
      {
        error: `Tag '${tagName}' not found in /tags. Available: ${allTags
          .map((t) => t.name)
          .join(", ")}`,
      },
      { status: 404 }
    );
  }
  const tagId = tagRecord.id;

  const variants: Variant[] = [
    {
      label: "G. tags_attributes_id",
      body: () => ({ order: { tags_attributes: [{ id: tagId }] } }),
    },
    {
      label: "H. tag_ids_array",
      body: () => ({ order: { tag_ids: [tagId] } }),
    },
    {
      label: "I. tags_array_id_objects",
      body: () => ({ order: { tags: [{ id: tagId }] } }),
    },
    {
      label: "J. tag_list_with_id_lookup_then_name",
      body: () => ({ order: { tag_list: [tagName] } }),
    },
  ];

  const results: Array<{
    label: string;
    method?: string;
    path?: string;
    body: unknown;
    before: string[];
    after: string[];
    added: boolean;
    error?: string;
    apiResponseTags?: unknown;
  }> = [];

  // Helper to try one PUT/POST variant in isolation and record result.
  async function runVariant(
    label: string,
    method: "PUT" | "POST",
    path: string,
    body: unknown
  ) {
    const beforeOrder = (await veeqoFetch(`/orders/${orderId}`)) as VeeqoOrder;
    const beforeNames = getOrderTags(beforeOrder as never).map((t) => t.name);

    let apiResponse: unknown = null;
    let errorMsg: string | undefined;
    try {
      apiResponse = await veeqoFetch(path, {
        method,
        body: JSON.stringify(body),
      });
    } catch (e: unknown) {
      errorMsg = e instanceof Error ? e.message : String(e);
    }

    const afterOrder = (await veeqoFetch(`/orders/${orderId}`)) as VeeqoOrder;
    const afterNames = getOrderTags(afterOrder as never).map((t) => t.name);

    const apiTagsField =
      (apiResponse as { tags?: unknown } | null)?.tags ?? null;

    results.push({
      label,
      method,
      path,
      body,
      before: beforeNames,
      after: afterNames,
      added: !beforeNames.includes(tagName) && afterNames.includes(tagName),
      ...(errorMsg ? { error: errorMsg } : {}),
      apiResponseTags: apiTagsField,
    });
  }

  // 1. PUT /orders/{id} with the order-wrapping shapes from `variants`.
  for (const v of variants) {
    await runVariant(v.label, "PUT", `/orders/${orderId}`, v.body());
  }

  // 2. Direct sub-resource attempts.
  await runVariant(
    "K. POST /orders/{id}/tags  body{tag:{id}}",
    "POST",
    `/orders/${orderId}/tags`,
    { tag: { id: tagId } }
  );
  await runVariant(
    "L. POST /orders/{id}/tags  body{id}",
    "POST",
    `/orders/${orderId}/tags`,
    { id: tagId }
  );
  await runVariant(
    "M. POST /orders/{id}/tags  body{tag_id}",
    "POST",
    `/orders/${orderId}/tags`,
    { tag_id: tagId }
  );
  await runVariant(
    "N. POST /orders/{id}/tags  body{name}",
    "POST",
    `/orders/${orderId}/tags`,
    { name: tagName }
  );
  await runVariant(
    "O. PUT /orders/{id}/tags  body{tag_ids:[id]}",
    "PUT",
    `/orders/${orderId}/tags`,
    { tag_ids: [tagId] }
  );

  return NextResponse.json({ orderId, number, tag: tagName, results });
}
