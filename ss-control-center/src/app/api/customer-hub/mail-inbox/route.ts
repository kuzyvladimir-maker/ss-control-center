import { verifyJackieAuth } from '@/lib/jackie-mcp/registry';
import { acceptMailSnapshot, mailOpenThreads, mailHistory } from '@/lib/customer-hub/mail-inbox';
export async function GET(request: Request) {
  return Response.json(await (new URL(request.url).searchParams.get("view") === "all" ? mailHistory() : mailOpenThreads()), { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(request: Request) {
  const error = verifyJackieAuth(request.headers.get('authorization'));
  if (error) return Response.json({ error }, { status: 401 });
  try { return Response.json(await acceptMailSnapshot(await request.json())); }
  catch (e) { return Response.json({ error: e instanceof Error ? e.message : 'Mail snapshot failed' }, { status: 400 }); }
}
