import { NextRequest, NextResponse } from "next/server";
import { translateText } from "@/lib/customer-hub/translator";

/**
 * POST /api/customer-hub/messages/[id]/translate
 *
 * Body: { text: string, direction: "en-ru" | "ru-en" }
 * Returns: { translation: string }
 *
 * Stateless translation helper used by the bilingual response editor in
 * MessageDetail. When the operator edits one column and blurs the
 * textarea, the other column is refreshed via this endpoint. Caller is
 * responsible for persisting the result through PATCH.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const text = typeof body.text === "string" ? body.text : "";
    const direction = body.direction;

    if (!text.trim()) {
      return NextResponse.json({ translation: "" });
    }
    if (direction !== "en-ru" && direction !== "ru-en") {
      return NextResponse.json(
        { error: "direction must be 'en-ru' or 'ru-en'" },
        { status: 400 }
      );
    }

    const translation = await translateText(text, direction);
    if (translation === null) {
      return NextResponse.json(
        { error: "Translation failed — see server logs" },
        { status: 502 }
      );
    }

    return NextResponse.json({ translation });
  } catch (err) {
    console.error("[translate] POST failed:", err);
    return NextResponse.json(
      { error: "Failed to translate" },
      { status: 500 }
    );
  }
}
