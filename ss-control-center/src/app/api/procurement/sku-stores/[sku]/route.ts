import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isMissingTableError } from "@/lib/procurement/store-list";

export const dynamic = "force-dynamic";

interface PriorityEntry {
  storeName: string;
  priority: number;
}

/**
 * GET /api/procurement/sku-stores/:sku
 * Returns the ordered list of stores Vladimir buys this SKU from.
 *
 * Response shape:
 *   { priorities: [{storeName, priority}, ...], dbReady: true }
 *
 * If the SKUStorePriority table does not exist (Turso not migrated yet),
 * we still return 200 with an empty list and dbReady=false so the UI can
 * show a helpful "DB needs migration" message instead of an opaque 500.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sku: string }> }
) {
  const { sku } = await params;
  if (!sku) {
    return NextResponse.json({ error: "sku required" }, { status: 400 });
  }

  try {
    const rows = await prisma.sKUStorePriority.findMany({
      where: { sku },
      orderBy: { priority: "asc" },
      select: { storeName: true, priority: true },
    });
    return NextResponse.json({ priorities: rows, dbReady: true });
  } catch (e: unknown) {
    if (isMissingTableError(e)) {
      return NextResponse.json({ priorities: [], dbReady: false });
    }
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[procurement/sku-stores GET]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

interface PutBody {
  priorities?: PriorityEntry[];
}

/**
 * PUT /api/procurement/sku-stores/:sku
 * Replaces the full priority list for this SKU. Body:
 *   { priorities: [{storeName: "Publix", priority: 1}, ...] }
 *
 * The list is treated as authoritative — anything not in the body gets
 * deleted. Order in the array implicitly becomes the priority (1, 2, 3,...)
 * but we honour explicit `priority` numbers if present.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ sku: string }> }
) {
  const { sku } = await params;
  if (!sku) {
    return NextResponse.json({ error: "sku required" }, { status: 400 });
  }

  let body: PutBody = {};
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json(
      { error: "body must be JSON: { priorities: [...] }" },
      { status: 400 }
    );
  }

  const incoming = body.priorities ?? [];
  if (!Array.isArray(incoming)) {
    return NextResponse.json(
      { error: "priorities must be an array" },
      { status: 400 }
    );
  }

  // Normalise + validate: keep only entries with a non-empty storeName.
  // Re-number priorities by array position so the caller doesn't have to
  // worry about gaps.
  const cleaned = incoming
    .filter(
      (e): e is PriorityEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as PriorityEntry).storeName === "string" &&
        (e as PriorityEntry).storeName.trim().length > 0
    )
    .map((e, i) => ({
      storeName: e.storeName.trim(),
      priority:
        typeof e.priority === "number" && Number.isFinite(e.priority)
          ? e.priority
          : i + 1,
    }));

  // De-duplicate by storeName (last-write-wins inside this request).
  const seen = new Set<string>();
  const finalList: PriorityEntry[] = [];
  for (const entry of cleaned) {
    const key = entry.storeName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    finalList.push(entry);
  }

  try {
    // Replace-all: delete what's there, insert the new list. One
    // transaction so a partial failure leaves the old list intact.
    await prisma.$transaction([
      prisma.sKUStorePriority.deleteMany({ where: { sku } }),
      ...finalList.map((entry) =>
        prisma.sKUStorePriority.create({
          data: {
            sku,
            storeName: entry.storeName,
            priority: entry.priority,
          },
        })
      ),
    ]);
    return NextResponse.json({ priorities: finalList, dbReady: true });
  } catch (e: unknown) {
    if (isMissingTableError(e)) {
      return NextResponse.json(
        {
          error:
            "Turso DB schema not migrated yet — run `npx prisma db push` against the Turso database to create the SKUStorePriority table.",
          dbReady: false,
        },
        { status: 503 }
      );
    }
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[procurement/sku-stores PUT]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
