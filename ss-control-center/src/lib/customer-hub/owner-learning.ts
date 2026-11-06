import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
type Message = NonNullable<Awaited<ReturnType<typeof prisma.buyerMessage.findUnique>>>;
export const ownerExampleId = (messageId: string) => `cs-owner-${createHash('sha256').update(messageId).digest('hex').slice(0, 32)}`;
/** One current final answer per situation; retries and card versions cannot multiply examples. */
export async function learnOwnerReply(m: Message, reply: string, cardId: string, comment?: string | null, explicitlyCorrected = false) {
  if (!reply.trim() || !m.customerMessage) return null;
  const cards = await prisma.csCard.findMany({ where: { buyerMessageId: m.id }, select: { id: true } });
  const rules = await prisma.csOwnerRule.findMany({ where: { cardId: { in: cards.map(c => c.id) }, active: true }, orderBy: { createdAt: 'asc' } });
  const comments = [...new Set([...rules.map(r => r.text), comment].filter((s): s is string => Boolean(s?.trim())))];
  const corrected = explicitlyCorrected || rules.length > 0 || Boolean(m.editedResponse && m.editedResponse !== m.suggestedResponse);
  const tag = corrected ? 'owner-corrected' : 'owner-approved';
  const data = {
    problemType: m.problemType || 'T18', scenario: m.ownerBrief?.split('\n')[0]?.slice(0, 500) || m.problemTypeName || 'Owner support decision',
    customerSaid: m.customerMessage, productType: m.productType, channel: m.channel,
    correctAction: m.action || 'info', correctResponse: reply.trim(),
    reasoning: `${tag}. Owner comment: ${comments.join('\n') || '(none)'}`,
    tags: `${tag},card:${cardId},ord:${m.amazonOrderId},message:${m.id}`, source: 'owner_edit',
  };
  return prisma.knowledgeBaseEntry.upsert({ where: { id: ownerExampleId(m.id) }, create: { id: ownerExampleId(m.id), ...data }, update: data });
}
export const ownerRuleId = (cardId: string, kind: string, comment: string) => `cs-rule-${createHash('sha256').update(JSON.stringify([cardId, kind, comment.trim()])).digest('hex').slice(0, 32)}`;
