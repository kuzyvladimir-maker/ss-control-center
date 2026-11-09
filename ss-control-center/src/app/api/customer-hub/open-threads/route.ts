import { verifyJackieAuth } from "@/lib/jackie-mcp/registry";
import { openThreads } from "@/lib/customer-hub/inbox-watch";

export async function GET(request: Request) {
  const error = verifyJackieAuth(request.headers.get("authorization"));
  if (error) return Response.json({ error }, { status: 401 });
  return Response.json(await openThreads(), { headers: { "Cache-Control": "no-store" } });
}
