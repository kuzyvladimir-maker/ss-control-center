import { NextResponse } from "next/server";
import { veeqoFetch } from "@/lib/veeqo/client";

export const dynamic = "force-dynamic";

/**
 * Probe several documented and undocumented Veeqo tag endpoints to see
 * (a) which return data, and (b) what shape the tag records take. The
 * goal is to find the existing tag IDs ("Placed", "Need More" etc.)
 * so we can attach them to orders by id rather than name.
 */
export async function GET() {
  const probes = [
    "/tags",
    "/tags?page_size=100",
    "/orders/tags",
    "/order_tags",
  ];

  const results: Array<{
    path: string;
    status: "ok" | "error";
    sample?: unknown;
    error?: string;
  }> = [];

  for (const path of probes) {
    try {
      const data = await veeqoFetch(path);
      // Trim very large payloads to first 5 entries
      let sample: unknown = data;
      if (Array.isArray(data)) sample = data.slice(0, 10);
      results.push({ path, status: "ok", sample });
    } catch (e: unknown) {
      results.push({
        path,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return NextResponse.json({ probes: results });
}
