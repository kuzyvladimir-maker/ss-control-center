import { NextRequest, NextResponse } from "next/server";
import { appendSkuRow } from "@/lib/google-sheets";

export async function POST(request: NextRequest) {
  try {
    const data = await request.json();

    const required = ["sku", "weight", "length", "width", "height"];
    for (const field of required) {
      if (data[field] === undefined || data[field] === null || data[field] === "") {
        return NextResponse.json(
          { error: `${field} is required` },
          { status: 400 }
        );
      }
    }

    try {
      await appendSkuRow({
        sku: data.sku,
        productTitle: data.productTitle || "",
        marketplace: data.marketplace || "Amazon",
        category: data.category || "Dry",
        length: parseFloat(data.length),
        width: parseFloat(data.width),
        height: parseFloat(data.height),
        weight: parseFloat(data.weight),
        weightFedex: parseFloat(data.weightFedex) || parseFloat(data.weight) * 1.25,
      });

      return NextResponse.json({ success: true, method: "sheets_api" });
    } catch (err) {
      return NextResponse.json({
        error:
          err instanceof Error
            ? err.message
            : `Failed to write SKU ${data.sku} to Google Sheets.`,
        manualRequired: true,
      }, { status: 502 });
    }
  } catch (error) {
    console.error("Fix SKU error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to save SKU data",
      },
      { status: 500 }
    );
  }
}
