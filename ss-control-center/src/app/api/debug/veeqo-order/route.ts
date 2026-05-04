import { NextRequest, NextResponse } from "next/server";
import { veeqoFetch } from "@/lib/veeqo/client";
import { getOrderTags } from "@/lib/veeqo/tags";
import { getInternalNotes } from "@/lib/veeqo/notes";

export const dynamic = "force-dynamic";

interface VeeqoOrderShape {
  id?: string | number;
  number?: string;
  tags?: unknown;
  status?: string;
  channel?: { name?: string };
  [k: string]: unknown;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const number = url.searchParams.get("number");
  if (!number) {
    return NextResponse.json(
      { error: "Pass ?number=<order_number> (e.g. 113-5805021-2730651)" },
      { status: 400 }
    );
  }

  try {
    const matches: VeeqoOrderShape[] = [];
    let page = 1;
    while (page <= 50) {
      const orders = (await veeqoFetch(
        `/orders?status=awaiting_fulfillment&page_size=100&page=${page}`
      )) as VeeqoOrderShape[];
      if (!Array.isArray(orders) || orders.length === 0) break;
      for (const o of orders) {
        if (o.number === number) matches.push(o);
      }
      if (orders.length < 100) break;
      page++;
    }

    if (matches.length === 0) {
      page = 1;
      while (page <= 20) {
        const orders = (await veeqoFetch(
          `/orders?status=shipped&page_size=100&page=${page}`
        )) as VeeqoOrderShape[];
        if (!Array.isArray(orders) || orders.length === 0) break;
        for (const o of orders) {
          if (o.number === number) matches.push(o);
        }
        if (orders.length < 100) break;
        page++;
      }
    }

    if (matches.length === 0) {
      return NextResponse.json(
        { error: `No order found with number=${number}` },
        { status: 404 }
      );
    }

    const out = matches.map((o) => {
      const r = o as Record<string, unknown>;
      return {
        id: o.id,
        number: o.number,
        status: o.status,
        channel: o.channel?.name,
        tags: getOrderTags(o as never),
        deliver_by: r.deliver_by ?? null,
        dispatch_date: r.dispatch_date ?? null,
        expected_dispatch_date: r.expected_dispatch_date ?? null,
        due_date: r.due_date ?? null,
        internalNotes: getInternalNotes(r),
      };
    });
    return NextResponse.json({ matches: out });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
