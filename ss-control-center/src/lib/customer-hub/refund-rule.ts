/**
 * Owner REFUND RULE (2026-10-27, topic 42) — pure, no DB.
 *
 * Money back only when the problem is on OUR line:
 *   (a) the product arrived thawed / spoiled / damaged / expired, or the
 *       wrong / missing item (buyer says so or the facts confirm it), or
 *   (b) there is no first carrier scan (label only — we did not ship).
 * Even then a REPLACEMENT is offered first. Dislike / pet won't eat /
 * changed mind / didn't expect the cost / carrier delay / late ship on an
 * intact order → no refund. Never tell the buyer to refuse the delivery.
 * First case: Lin, 114-4815954-1015457 ("my dog will not eat this food" →
 * the engine offered a full refund because the label was 2 days late).
 */
import { transitFacts, type TransitEvent } from "./transit";

/** Buyer says the product arrived in bad condition. */
export const SPOILAGE_RE =
  /\b(thaw(ed|ing)?|melt(ed|ing)?|defrost(ed)?|(arrived|came|was|were|is|are|very|all) (all |completely |very )?(warm|hot|room temp(erature)?)|not (cold|frozen|refrigerated)|without (any )?(ice|ice packs|gel packs|cooler)|no (ice|ice packs|gel packs)|spoil(ed|t)?|rotten|rancid|mo(u)?ld(y)?|smell(s|ed|y)?|stink(s|ing)?|sour|leak(ed|ing|s)?|damaged|crushed|smashed|smushed|squished|broken|torn|punctured|soggy|swollen|bloated|ruined|expired|no expiration date|wrong (item|product|flavor|flavour|size)|(was |were )?(sent|shipped|received|got) (me )?(the )?wrong|instead of|missing|only (got|received)|not (sent |send |receive |get )?what (i|we) ordered|ordered\b[^.]{0,80}\b(got|received|was (sent|shipped)|shipped))\b/i;

/** The reply offers / announces money back. */
export const REFUND_OFFER_RE =
  /\b((we|i)( will|'ll| have| can| would be (happy|glad) to| are happy to)? (issue|process|arrange|provide|initiate|give)( you)?( a)?( full| partial)? refund|refund (has been|will be|was) (issued|processed|initiated)|(issued|processed)( you)?( a)?( full| partial)? refund|(a|your) (full|partial) refund|refund (you|your order|the (full|shipping))|refund for (this|your) order)\b/i;

/** Telling the buyer to refuse the delivery (owner ban). */
export const REFUSE_DELIVERY_RE =
  /\b(refus(e|ing) (the |your )?(delivery|package|shipment|parcel|order)|decline (the )?delivery|return(ed)? to sender)\b/i;

/**
 * Hinting which reasons WOULD qualify ("as there is no issue with the
 * condition", "unless it arrived damaged") — owner 27.10 15:50: the buyer
 * will simply claim that reason next.
 */
export const REFUND_REASON_HINT_RE =
  /\b((as|since|because) there (is|was) no (issue|problem) with the (condition|quality|product|item)|unless (it|the (item|product|food)) (arrived|was|is) (damaged|thawed|spoiled|defective|warm)|only (eligible|refundable|qualif\w*) (for a refund )?(if|when)|(would|could) (qualify|be eligible) for a refund (if|when)|if (it|the (item|product|food)) (had )?(arrived|was) (damaged|thawed|spoiled|warm))\b/i;

export const REFUND_ACTIONS = new Set(["full_refund", "partial_refund"]);

export interface RefundBasisInput {
  customerMessage: string | null | undefined;
  trackingEvents?: TransitEvent[] | null;
  /** Owner's correction for this case (an explicit refund decision wins). */
  extraInstruction?: string | null;
  conversationHistory?: Array<{ direction: string; text: string }>;
}

export interface RefundBasis {
  allowed: boolean;
  spoilageClaimed: boolean;
  noFirstScan: boolean;
  ownerOrderedRefund: boolean;
  /** We already offered a replacement earlier on this order. */
  replacementOffered: boolean;
  why: string;
}

export function refundBasis(i: RefundBasisInput): RefundBasis {
  const spoilageClaimed = SPOILAGE_RE.test(i.customerMessage || "");
  const events = i.trackingEvents || [];
  const noFirstScan = events.length > 0 && transitFacts(events).firstCarrierScan === null;
  const ownerOrderedRefund = /\b(refund|возврат денег|верни(те)? деньги|рефанд)\b/i.test(i.extraInstruction || "");
  const replacementOffered = (i.conversationHistory || []).some(
    (h) => h.direction === "outgoing" && /\b(replacement|resend|re-ship|send (you )?(a new|another|it again))\b/i.test(h.text)
  );
  const allowed = spoilageClaimed || noFirstScan || ownerOrderedRefund;
  const why = ownerOrderedRefund
    ? "owner ordered a refund"
    : spoilageClaimed
      ? "buyer reports the product arrived in bad condition"
      : noFirstScan
        ? "no first carrier scan (not shipped)"
        : "no our-fault basis (dislike / changed mind / delay / late ship on an intact order)";
  return { allowed, spoilageClaimed, noFirstScan, ownerOrderedRefund, replacementOffered, why };
}
