import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
export async function createPromptAudit(data: Record<string, unknown> & { systemPrompt: string; userMessage: string }) {
  const id = `cs_prompt:${randomUUID()}`;
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  const value = { ...data, createdAt: new Date().toISOString(), systemSha256: hash(data.systemPrompt), userSha256: hash(data.userMessage), status: 'prepared', attempts: [] };
  await prisma.setting.create({ data: { key: id, value: JSON.stringify(value) } });
  return id;
}
export async function updatePromptAudit(id: string, patch: Record<string, unknown>) {
  const row = await prisma.setting.findUniqueOrThrow({ where: { key: id } });
  await prisma.setting.update({ where: { key: id }, data: { value: JSON.stringify({ ...JSON.parse(row.value), ...patch }) } });
}
