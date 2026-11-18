import { verifyJackieAuth } from '@/lib/jackie-mcp/registry';
import { acceptMailSnapshot, mailHistory } from '@/lib/customer-hub/mail-inbox';
export async function GET() {
  return Response.json({...await mailHistory(), historyOnly:true, isCurrentQueue:false}, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(request: Request) {
  const error = verifyJackieAuth(request.headers.get('authorization'));
  if (error) return Response.json({ error }, { status: 401 });
  try { return Response.json(await acceptMailSnapshot(await request.json())); }
  catch (e) { return Response.json({ error: e instanceof Error ? e.message : 'Mail snapshot failed' }, { status: 400 }); }
}
