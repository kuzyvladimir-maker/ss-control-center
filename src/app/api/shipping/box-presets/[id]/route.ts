/**
 * DELETE /api/shipping/box-presets/:id
 *
 * Removes a custom box-size preset. Builtin presets (XS..XL + the seeded
 * numeric set) are protected — they return 403 so a stray click in the
 * picker can't wipe out the defaults.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const row = await prisma.boxSizePreset.findUnique({ where: { id } });
  if (!row) {
    return NextResponse.json({ error: "Preset not found" }, { status: 404 });
  }
  if (row.builtin) {
    return NextResponse.json(
      { error: "Builtin presets can't be deleted" },
      { status: 403 },
    );
  }
  await prisma.boxSizePreset.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
