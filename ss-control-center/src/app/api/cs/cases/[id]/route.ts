import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { status } = body;

    if (!status || !["open", "responded", "resolved"].includes(status)) {
      return NextResponse.json(
        { error: "Invalid status. Must be: open, responded, or resolved" },
        { status: 400 }
      );
    }

    const data: Record<string, unknown> = { status };
    if (status === "resolved") {
      data.resolvedAt = new Date();
    }

    const updated = await prisma.csCase.update({
      where: { id },
      data,
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("CS case update error:", error);
    return NextResponse.json(
      { error: "Failed to update case" },
      { status: 500 }
    );
  }
}
