import { FAULT_ADMISSION_RE } from './autosend-policy';
import { REFUND_OFFER_RE } from './refund-rule';
export const CUSTOMER_SIGN_OFF = 'Salutem Solutions';
export const APOLOGY_RE = /\b(sorry|apolog(?:y|ies|ize|ise|izing|ising|ized|ised))\b|lo sentimos|lamentamos/iu;
export const OWNER_REPLY_RULES = 'CURRENT OWNER RULES (2026-11-06), override older examples and voice guides: No apologies, no admission of fault. Sign every buyer reply Salutem Solutions. Refunds over $50 require an explicit owner decision; otherwise ask the owner in the internal brief and do not promise money. Drafting or correcting never authorizes sending; only an explicit owner send instruction does.';
export function removeApologies(text: string) {
  return text.replace(/[^.!?;\n]*(?:\bsorry\b|\bapolog(?:y|ies|ize|ise|izing|ising|ized|ised)\b|lo sentimos|lamentamos)[^.!?;\n]*[.!?;]?\s*/giu, '').trim();
}
export function salutemClosing(text: string) {
  const clean = text.trim().replace(/(?:best regards|kind regards|sincerely|atentamente|saludos|cordialmente),?\s*\n[^\n]*\s*$/i, '').replace(/(?:Customer Support Team|Customer Service Team|Salutem Solutions)\s*$/i, '').trim();
  return `${clean}\n\nBest regards,\n${CUSTOMER_SIGN_OFF}`;
}
export function assertSendPolicy(text: string, total: number | null, ownerRefundAuthorized = false) {
  if (APOLOGY_RE.test(text)) throw new Error('Buyer reply contains an apology; revise before sending');
  if (FAULT_ADMISSION_RE.test(text) || /something (went|has gone) wrong/i.test(text)) throw new Error('Buyer reply admits fault; revise before sending');
  if (!/Salutem Solutions\s*$/.test(text)) throw new Error('Buyer reply must end with Salutem Solutions');
  if (REFUND_OFFER_RE.test(text) && (total === null || total > 50) && !ownerRefundAuthorized) throw new Error('Ask the owner to authorize this refund over $50 (or unknown total) before promising it');
}
