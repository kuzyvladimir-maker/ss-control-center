import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { verifyJackieAuth } from '@/lib/jackie-mcp/registry';
const KEY = 'cs_mail_refresh_request';
export async function GET() {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  return Response.json(row ? JSON.parse(row.value) : { status: 'idle' }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST() {
  // Session/API authentication is enforced by proxy. This queues mail reads only.
  const result = await prisma.$transaction(async tx => {
    const row = await tx.setting.findUnique({ where: { key: KEY } });
    const previous = row ? JSON.parse(row.value) : null;
    if (previous && ['pending','running'].includes(previous.status) && Date.now() - Date.parse(previous.requestedAt) < 15 * 60_000) return previous;
    const next = { id: randomUUID(), requestedAt: new Date().toISOString(), status: 'pending' };
    await tx.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
    return next;
  });
  return Response.json(result, { status: 202 });
}
export async function PATCH(request: Request) {
  const error = verifyJackieAuth(request.headers.get('authorization'));
  if (error) return Response.json({ error }, { status: 401 });
  const body = await request.json();
  if (!['running','completed','failed'].includes(body.status)) return Response.json({ error: 'Invalid refresh state' }, { status: 400 });
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  if (!row) return Response.json({ error: 'No refresh request' }, { status: 409 });
  const previous = JSON.parse(row.value);
  if (previous.id !== body.id) return Response.json({ error: 'Refresh request changed' }, { status: 409 });
  const next = { ...previous, status: body.status, updatedAt: new Date().toISOString(), error: typeof body.error === 'string' ? body.error.slice(0,500) : null };
  const updated = await prisma.setting.updateMany({ where: { key: KEY, value: row.value }, data: { value: JSON.stringify(next) } });
  if (!updated.count) return Response.json({ error: "Refresh request changed" }, { status: 409 });
  return Response.json(next);
}
