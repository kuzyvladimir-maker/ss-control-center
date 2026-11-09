import { verifyJackieAuth } from "@/lib/jackie-mcp/registry";
import { closeManually } from "@/lib/customer-hub/manual-close";

export async function POST(request: Request) {
  const error = verifyJackieAuth(request.headers.get("authorization"));
  if (error) return Response.json({ error }, { status: 401 });
  try {
    return Response.json({ ok: true, ...await closeManually(await request.json()) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Manual closure failed" }, { status: 400 });
  }
}
