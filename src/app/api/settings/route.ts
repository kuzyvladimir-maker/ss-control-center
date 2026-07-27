import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const ALLOWED_SETTINGS_KEYS = new Set([
  "cogs_percent",
  "replacement_label_cost",
  "ai_primary_provider",
  "ai_claude_model",
  "ai_openai_model",
]);

// GET /api/settings?keys=cogs_percent,replacement_label_cost
// Returns { values: { key: value, ... } } for the requested keys. Missing
// keys are omitted (caller provides fallbacks).
export async function GET(request: NextRequest) {
  try {
    const keysParam = request.nextUrl.searchParams.get("keys") || "";
    const keys = keysParam
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    if (keys.length === 0) {
      return NextResponse.json({ values: {} });
    }
    const invalidKeys = keys.filter((key) => !ALLOWED_SETTINGS_KEYS.has(key));
    if (invalidKeys.length > 0) {
      return NextResponse.json(
        { error: `Unsupported setting key(s): ${invalidKeys.join(", ")}` },
        { status: 400 }
      );
    }
    const rows = await prisma.setting.findMany({
      where: { key: { in: keys } },
    });
    const values: Record<string, string> = {};
    for (const r of rows) values[r.key] = r.value;
    return NextResponse.json({ values });
  } catch (err) {
    console.error("[settings] GET failed:", err);
    return NextResponse.json(
      { error: "Failed to load settings" },
      { status: 500 }
    );
  }
}

// PUT /api/settings
// Body: { values: { key: value, ... } }
// Upserts each key/value pair. Values are always stored as strings.
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const values = body?.values;
    if (!values || typeof values !== "object") {
      return NextResponse.json(
        { error: "Missing values object" },
        { status: 400 }
      );
    }

    const entries = Object.entries(values as Record<string, unknown>);
    if (entries.length === 0) {
      return NextResponse.json({ saved: 0 });
    }

    // Reject obviously-unsafe keys (only allow [a-z0-9_])
    for (const [key] of entries) {
      if (!/^[a-z0-9_]+$/.test(key)) {
        return NextResponse.json(
          { error: `Invalid key "${key}"` },
          { status: 400 }
        );
      }
      if (!ALLOWED_SETTINGS_KEYS.has(key)) {
        return NextResponse.json(
          { error: `Unsupported setting key "${key}"` },
          { status: 403 }
        );
      }
    }

    for (const [key, value] of entries) {
      const str = value == null ? "" : String(value);
      await prisma.setting.upsert({
        where: { key },
        create: { key, value: str },
        update: { value: str },
      });
    }

    return NextResponse.json({ saved: entries.length });
  } catch (err) {
    console.error("[settings] PUT failed:", err);
    return NextResponse.json(
      { error: "Failed to save settings" },
      { status: 500 }
    );
  }
}
