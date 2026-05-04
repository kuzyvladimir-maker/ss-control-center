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

  const variants: Variant[] = [
    {
      label: "A. tags_attributes_only_name",
      body: () => ({ order: { tags_attributes: [{ name: tagName }] } }),
    },
    {
      label: "B. tags_attributes_name_colour",
      body: () => ({
        order: { tags_attributes: [{ name: tagName, colour: "blue" }] },
      }),
    },
    {
      label: "C. tag_list_array",
      body: () => ({ order: { tag_list: [tagName] } }),
    },
    {
      label: "D. tag_list_string_csv",
      body: () => ({ order: { tag_list: tagName } }),
    },
    {
      label: "E. tags_array_objects",
      body: () => ({ order: { tags: [{ name: tagName }] } }),
    },
    {
      label: "F. tags_array_strings",
      body: () => ({ order: { tags: [tagName] } }),
    },
  ];

  const results: Array<{
    label: string;
    body: unknown;
    before: string[];
    after: string[];
    added: boolean;
    error?: string;
    apiResponseTags?: unknown;
  }> = [];

  for (const v of variants) {
    const beforeOrder = (await veeqoFetch(`/orders/${orderId}`)) as VeeqoOrder;
    const beforeNames = getOrderTags(beforeOrder as never).map((t) => t.name);

    const body = v.body();
    let apiResponse: unknown = null;
    let errorMsg: string | undefined;
    try {
      apiResponse = await veeqoFetch(`/orders/${orderId}`, {
        method: "PUT",
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
      label: v.label,
      body,
      before: beforeNames,
      after: afterNames,
      added: !beforeNames.includes(tagName) && afterNames.includes(tagName),
      ...(errorMsg ? { error: errorMsg } : {}),
      apiResponseTags: apiTagsField,
    });

    // If a variant succeeded in adding the tag, no need to keep banging
    // — but DO record the next variants' "already-present" status so we
    // can see consistent state.
  }

  return NextResponse.json({ orderId, number, tag: tagName, results });
}
