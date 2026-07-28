/**
 * Box size presets — list + add.
 *
 *   GET  /api/shipping/box-presets
 *     → { presets: Array<{id, label, length, width, height, builtin}> }
 *   POST /api/shipping/box-presets
 *     body: { label?, length, width, height }
 *     → { preset: { ... } }
 *
 * Powers the dropdown in PackingProfileDialog / SkuDataDialog. The picker
 * auto-POSTs here when the operator types a new "LxWxH" that doesn't match
 * any existing preset, so anything used once survives for next time.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/** "12×12×8" / "12X12X8" / "12 x 12 x 8" → "12x12x8" so the unique index
 *  doesn't trip on cosmetic variants of the same physical size. */
function normalizeLabel(raw: string): string {
  return raw
    .replace(/×/g, "x")
    .replace(/\s+/g, "")
    .toLowerCase()
    .trim();
}

function isValidDim(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 200;
}

export async function GET() {
  // Sort: builtin first (by the original conceptual order: XS,S,M,L,XL then
  // numeric), custom rows after, both alphabetically within their group.
  const presets = await prisma.boxSizePreset.findMany({
    orderBy: [{ builtin: "desc" }, { createdAt: "asc" }],
  });
  return NextResponse.json({ presets });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  if (!isValidDim(b.length) || !isValidDim(b.width) || !isValidDim(b.height)) {
    return NextResponse.json(
      { error: "length / width / height must be positive numbers" },
      { status: 400 },
    );
  }

  const length = b.length;
  const width = b.width;
  const height = b.height;

  const labelRaw =
    typeof b.label === "string" && b.label.trim()
      ? b.label
      : `${length}x${width}x${height}`;
  const label = normalizeLabel(labelRaw);

  // If a preset with this label already exists, return it (no duplicate).
  const existing = await prisma.boxSizePreset.findUnique({ where: { label } });
  if (existing) {
    return NextResponse.json({ preset: existing, existed: true });
  }

  const preset = await prisma.boxSizePreset.create({
    data: { label, length, width, height, builtin: false },
  });
  return NextResponse.json({ preset, existed: false });
}
