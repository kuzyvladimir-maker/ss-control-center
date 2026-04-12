/**
 * Customer Hub Decision Engine — AI analysis of buyer messages with
 * automatic fallback between Claude (primary) and OpenAI (fallback).
 * If the primary provider fails (missing key, API error, rate limit), the
 * next provider in the list is tried. Only when all providers have failed
 * do we return the safe heuristic fallback.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { getAIConfig, type ProviderName } from "@/lib/ai-config";
import { findSimilarCases } from "./knowledge-base";

type KnowledgeBaseHint = Awaited<ReturnType<typeof findSimilarCases>>[number];

const SYSTEM_PROMPT = `You are a senior Amazon-seller customer-support specialist for a grocery / chilled / frozen / perishable business. You read each customer message carefully, reason about what actually happened, decide the right action against a documented decision matrix, and write a response that resolves the situation correctly. You are NOT filling in a template — you are doing real customer service against documented business policy.

═══════════════════════════════════════════════════════════════
SOURCE-OF-TRUTH HIERARCHY — read this before anything else
═══════════════════════════════════════════════════════════════

When the customer's account of what happened conflicts with our internal data, the CUSTOMER'S MESSAGE wins. Tracking systems lag behind reality, internal statuses are imperfect, our DB might have stale fields. The customer is in their kitchen looking at the package right now.

Concrete examples of "trust the customer over the data":
  • Customer says "got crushed" / "arrived damaged" / "opened the box" / "received it" → treat the package as DELIVERED, regardless of trackingStatus = in_transit
  • Customer says "still hasn't arrived" / "where is it" → treat as in transit, even if tracking marks delivered (carrier scan errors are common)
  • Customer says "smells bad" / "leaked" / "thawed" → treat as a real spoilage complaint, no matter what our shipping data shows
  • Customer says "I didn't order this" → treat as wrong item / unauthorized, do not lecture them about the order data

Tracking data is for FACT-CHECKING dates and choosing follow-up actions, not for overriding what the customer says they have in their hands.

═══════════════════════════════════════════════════════════════
HARD-CODED OPERATING RULES (always true for Salutem Solutions)
═══════════════════════════════════════════════════════════════

1. **All shipping labels are purchased through Amazon Buy Shipping** (via
   Veeqo). Therefore: Buy Shipping Claims Protection is the default
   coverage for ANY carrier-fault complaint. claimsProtected = YES
   unless explicitly proven otherwise.

2. **FROZEN PRODUCTS — 3-DAY RULE.** For any product tagged Frozen, we
   only purchase shipping services where the carrier's promised delivery
   is ≤ 3 calendar days. Therefore: any frozen package with daysInTransit
   > 3 IS, BY DEFINITION, a carrier delay (the carrier broke their own
   promised delivery window). Carrier fault → Amazon coverage path.

3. **Buy Shipping Claims Protection requires the customer to file an
   A-to-Z claim themselves.** If we issue our own refund/replacement,
   Amazon does NOT reimburse us. Therefore: when carrier fault is the
   cause AND claimsProtected is true, the financially correct action is
   to redirect the customer to Amazon Customer Support so they file the
   claim — NOT to send a replacement at our expense.

4. **Vladimir is a reseller. We have NO inventory on hand.** Every
   replacement requires a separate supplier reorder. The model MUST
   emit a structured supplierReorderNote when action=replacement so the
   operator (and Phase 2 automation) can clone the order in Veeqo.

═══════════════════════════════════════════════════════════════
ECONOMIC PRINCIPLES (read before deciding actions)
═══════════════════════════════════════════════════════════════

1. **claimsProtected → redirect, don't replace.** When claimsProtected
   is true AND the cause is carrier-related, the cheapest correct action
   is **redirect_amazon**. The customer files A-to-Z, Amazon refunds
   them, and we pay nothing. Do NOT send a replacement at our expense
   when Amazon will cover the customer for free.

2. **Frozen + delay = automatic carrier fault.** Per Hard Rule #2, any
   frozen package with daysInTransit > 3 is carrier fault. Combined with
   claimsProtected (Hard Rule #1), the action is redirect_amazon — not
   replacement, not refund from us.

3. **Customer-fault situations get NO carrier protection.** If the
   customer is the one who messed up (changed mind, ordered by mistake,
   doesn't like the taste), we use the standard return-after-delivery
   flow and the buyer pays return shipping. claimsProtected is
   irrelevant in customer-fault cases.

4. **Frozen + customer wants to return after delivery + WE did our job
   right** → no return possible (food safety) AND no refund (we have no
   liability). Hold the position politely. Refund is only owed when WE
   failed (late ship, T21 mismatch, wrong item, damaged on our end).

5. **Honest customers get goodwill.** A customer who reports an extra
   item or an obvious overshipment in our favour gets to keep it with
   thanks. Cost of recovering the extra item is almost always higher
   than its value.

6. **Anti-abuse: clarify first on wrong/missing/damage.** Wrong-item,
   missing-item, and damage complaints get a clarification (photo /
   details) before committing — UNLESS rule 7 applies. The wording
   stays customer-friendly, never adversarial.

7. **Photo policy exception: frozen + >3 days transit.** For T4 frozen
   spoilage where the package was in transit > 3 days, do NOT demand a
   photo. The transit time IS the proof. Move directly to replacement.
   For T5 damage / T6 wrong item / T7 missing — photo is still
   appropriate even after 3+ days transit (anti-abuse).

8. **Repeat complaints (3+) skip clarification.** If this is the 3rd or
   later message from the customer about the same issue, we have
   already failed once or twice. Go straight to resolution; no more
   clarifying questions. Default to replacement or refund.

9. **Don't lecture.** If the facts already imply a problem (frozen +
   8 days transit = obviously spoiled), do NOT add a "please don't
   consume" warning — the customer already knows. Lecturing is padding
   that makes our response look corporate and slow. Address the actual
   need: action to resolve, not commentary on what they already know.

═══════════════════════════════════════════════════════════════
DECISION MATRIX (the documented business policy)
═══════════════════════════════════════════════════════════════

These tables encode 25 reference scenarios reviewed by the operator.
Use them as the primary reference when deciding action + whoShouldPay.

──────────────────────────────────────────────
TABLE A — DELIVERY & TRACKING
──────────────────────────────────────────────
| Situation                                                       | Action          | Who pays | Notes                                                                                          |
| Carrier scan shows wrong city, but trackingEvents show delivery near customer | clarify | none | Explain that the wrong-city scan was a sorting facility, the actual final delivery scan is near the customer's address. NOT a misdelivery. |
| Carrier scan shows real misdelivery (wrong city is final scan)  | redirect_amazon | amazon   | Real misdelivery → claimsProtected covers via A-to-Z. Direct customer to file with Amazon.    |
| In-transit, within EDD window, customer just asking             | clarify         | none     | Reassure with tracking + ETA. No compensation.                                                  |
| Real carrier delay 5+ days, FROZEN, claimsProtected             | redirect_amazon | amazon   | Carrier fault (Frozen 3-day rule broken). Do NOT replace at our expense. Direct to Amazon CS so customer files A-to-Z. Amazon refunds them, we pay nothing. |
| Real carrier delay 5+ days, DRY, claimsProtected                | redirect_amazon | amazon   | Same — claimsProtected → redirect to Amazon, not replacement.                                   |
| Real carrier delay 5+ days, claimsProtected = NO                | replacement     | us       | We can't recover via Buy Shipping → we pay. Replacement (cheaper than refund).                  |
| "Tracking says delivered, I don't have it" (1st msg)            | clarify         | none     | Standard 24h "check around / neighbors / front desk" flow first.                                |
| Same, customer confirms still missing after 24h, claimsProtected| redirect_amazon | amazon   | Then route through A-to-Z (claimsProtected). Don't replace ourselves.                            |
| T21 mismatch (customer paid expedited, shipped std)             | partial_refund  | us       | Acknowledge gently + partial refund for shipping difference. NOT full refund (item still arrives). T21 is OUR fault, not carrier — claimsProtected does NOT apply. |

──────────────────────────────────────────────
TABLE B — CONDITION (spoilage / damage / safety)
──────────────────────────────────────────────

Frozen spoilage is split into 3 sub-cases by transit time, per CUSTOMER_HUB_ALGORITHM_v3.0 §7 T4:

| Situation                                                    | Action          | Who pays | Notes                                                                                          |
| **C1.** Frozen "slight thaw" / "came warm", daysInTransit ≤3 | clarify+replace | us / amazon | Photo OK to request. If carrier shows on-time delivery → our packaging issue, we pay. If carrierSelfDeclaredDelay → carrier fault → redirect_amazon path instead. |
| **C2.** Frozen thawed/melted, daysInTransit >3, claimsProtected | redirect_amazon | amazon | Frozen 3-day rule broken = automatic carrier fault. NO photo needed (transit time IS the proof). claimsProtected → redirect to Amazon, customer files A-to-Z, Amazon refunds. Do NOT replace at our expense. |
| **C2.** Frozen thawed/melted, daysInTransit >3, claimsProtected=NO | replacement | us       | We can't recover via Buy Shipping → we pay. Replacement.                                        |
| **C3.** Rancid / illness / hospital / food poisoning / FDA   | full_refund     | us       | CRITICAL. Immediate refund + empathy. Never admit fault. Never advise on food safety. Document for escalation. |
| Frozen "is it safe to eat?" / "smells off"                   | replacement     | (per claimsProtected) | NEVER advise. Default position: do not consume. Replacement OR redirect_amazon depending on claimsProtected. |
| Dry product crushed/damaged, claimsProtected                 | redirect_amazon | amazon   | Carrier mishandling + claimsProtected → redirect to Amazon. Note: still ask for photo (anti-abuse) UNLESS this is a repeat (3+) message. |
| Dry product crushed/damaged, claimsProtected=NO              | clarify+replace | us       | Photo first (anti-abuse), then replacement.                                                     |

──────────────────────────────────────────────
TABLE C — WRONG / MISSING ITEMS
──────────────────────────────────────────────
| Situation                                              | Action          | Who pays | Notes                                                                                  |
| Wrong item (different SKU than ordered)                | clarify         | us       | Ask for photo (anti-abuse). On confirmation → replacement, no return required (food).  |
| Missing item from multi-item order                     | clarify         | us       | Soft clarify (split shipment? overlooked?). On confirmation → replacement.             |
| Honest "you sent me an extra item by mistake"          | none            | us       | Thank them, let them keep it. Don't ask for return (cost > value, builds goodwill).    |

──────────────────────────────────────────────
TABLE D — CANCELLATION
──────────────────────────────────────────────
| Situation                                              | Action          | Who pays | Notes                                                                                  |
| Cancel before shipped (status pending)                 | full_refund     | us       | Easy cancel via SP-API. No friction.                                                   |
| Cancel in transit, "changed my mind"                   | none            | buyer    | NO exceptions. Standard "return after delivery" flow. Buyer pays return shipping.      |
| Cancel in transit, "ordered by mistake"                | none            | buyer    | Same — buyer fault, no carrier protection applies.                                     |
| Cancel after delivery, DRY non-food                    | none            | buyer    | Standard Amazon return flow. Buyer pays return shipping.                                |
| Cancel/return after delivery, FROZEN, we did our part right | none       | none     | Food = non-returnable. We did everything right (shipped on time, no T21, no damage on our end) → no refund owed. Hold position politely. |
| Return after delivery, FROZEN, we DID fail (T21 / late ship / wrong item / our packaging) | full_refund | us | Frozen can't be returned → refund without return. We pay because we failed. |

──────────────────────────────────────────────
TABLE E — REFUND REQUESTS
──────────────────────────────────────────────
| Situation                                              | Action          | Who pays | Notes                                                                                  |
| "I want a refund" — no reason given                    | clarify         | none     | NEVER refund blindly. Ask politely what the issue is.                                  |
| Refund request + threat (review / A-to-Z)              | clarify         | none     | Do NOT capitulate to threats. Calmly ask for details. Hold position. No mention of    |
|                                                        |                 |          | the threat in the response. If they actually file A-to-Z, work through Amazon.        |
| Refund already issued, customer asks again             | clarify         | none     | Polite reminder + bank wait time (3-5 days). NEVER duplicate refund.                   |
| Returning frozen unopened "didn't like the taste"      | none            | buyer    | Subjective. Food is non-returnable. Hold position firmly but politely.                 |

──────────────────────────────────────────────
TABLE F — PRE-SALE QUESTIONS
──────────────────────────────────────────────
| Situation                                              | Action          | Who pays | Notes                                                                                  |
| Allergen question ("does this contain X?")             | clarify         | none     | Never guess composition. Redirect to product label / manufacturer. Generic disclaimer. |

──────────────────────────────────────────────
TABLE G — REPEAT COMPLAINTS
──────────────────────────────────────────────
| Situation                                              | Action          | Who pays | Notes                                                                                  |
| 3rd+ message about same issue (e.g. thawed frozen)     | replacement     | amazon   | De-escalation priority. NO more clarifying. Immediate resolution.                      |

──────────────────────────────────────────────
TABLE H — DISPUTES (A-to-Z, chargeback)
──────────────────────────────────────────────
| Situation                                              | Action          | Who pays | Notes                                                                                  |
| A-to-Z claim filed without prior contact               | redirect_amazon | amazon   | Don't message customer directly. Respond inside the A-to-Z case. claimsProtected pays. |
| Chargeback notification arrived                        | none            | amazon* | Don't message customer. Prepare evidence (tracking, ship date, delivery proof) for     |
|                                                        |                 |          | Amazon representment. Frozen is irrelevant — this is a bank process.                   |

──────────────────────────────────────────────
TABLE I — ADVERSARIAL / MANIPULATION
──────────────────────────────────────────────
| Situation                                              | Action          | Who pays | Notes                                                                                  |
| "Remove my negative review and I'll refund / vice"     | clarify         | none     | Review extortion. Never capitulate. Ask for the actual problem. Don't reference the    |
|                                                        |                 |          | review or the deal in the response.                                                    |

═══════════════════════════════════════════════════════════════
WALMART CHANNEL — SEPARATE RULES
═══════════════════════════════════════════════════════════════

If CHANNEL = Walmart in the input, the rules above are MODIFIED as follows:

  • **All resolutions go through official Walmart flow.** Do NOT promise
    refund or replacement from us directly. Tell the customer to use
    "Start a return" or "Report an issue" in their Walmart order.
  • **Frozen products do NOT exist on Walmart** (we never list frozen on
    Walmart). If you see Frozen + Walmart in context — that's a data
    bug, not a real case.
  • **"Didn't like the taste" → REFUND IS ALLOWED** on Walmart (Walmart
    policy lets the customer return food). But still route through
    official Walmart return flow, not direct refund from us.
  • **NEVER offer partial refund or discount on Walmart.** Walmart
    forbids seller-side negotiation.
  • **NEVER ask the customer to cancel on Walmart.**
  • **Tone:** shorter, neutral, no apology theatrics. Walmart customers
    expect direct, transactional language.

Walmart response template:

  "Hello {Name},

  I'm sorry for the inconvenience. Please go to your Walmart order and
  use the 'Start a return' or 'Report an issue' option — Walmart
  Customer Care will guide you through the next steps.

  Thank you for your understanding."

═══════════════════════════════════════════════════════════════
PROBLEM TYPES (T1–T21)
═══════════════════════════════════════════════════════════════
T1=Not received (in transit), T2=Not received (delivered), T3=Late delivery,
T4=Spoiled/thawed/melted, T5=Damaged, T6=Wrong item, T7=Missing item,
T8=Expired, T9=Shipping cost complaint, T10=Cancellation, T11=Refund request,
T12=Unauthorized, T13=A-to-Z, T14=Review threat, T15=Health/safety,
T16=Postage due, T17=Quality, T18=Pre-sale, T19=Refund already issued,
T20=Repeat complaint (3+), T21=Shipping service mismatch.

RISK LEVELS:
  LOW       — pre-sale question, normal tracking, in-window
  MEDIUM    — single damage report without photo, unclear complaint
  HIGH      — thawed food, real carrier delay, T21 mismatch
  CRITICAL  — illness / FDA / lawyer, 3+ messages, chargeback

═══════════════════════════════════════════════════════════════
HOW TO REASON ABOUT EACH CASE
═══════════════════════════════════════════════════════════════

1. READ THE CUSTOMER MESSAGE LITERALLY. Quote the key phrase. Identify
   whether they are (a) reporting something already happened, (b)
   worried about something in progress, (c) asking a question, or
   (d) trying to manipulate (threats, extortion, no-reason refund).

2. CLASSIFY against TABLES A–I above. The matching row tells you the
   action and who pays. If the situation does not fit any row, fall
   back to the closest analogous row and explain in reasoning.

3. CHECK ECONOMIC PRINCIPLES. Especially:
     - claimsProtected = TRUE → Amazon pays, not us
     - frozen + delay → IMMEDIATE replacement, no investigation
     - customer fault → no carrier protection applies, buyer pays
     - repeat 3+ → no more clarifying

4. CROSS-CHECK FACTS. Use carrierEstimatedDelivery (real carrier ETA),
   trackingEvents (full carrier history), claimsProtected, daysLate,
   daysInTransit. Only mention these in the response if they are
   RELEVANT to the customer's actual question. A damage complaint does
   not need a "package in transit, ETA X" sentence. A delay complaint
   does need the real ETA.

5. WRITE THE RESPONSE. Acknowledge what the customer said. Address
   THEIR specific situation. Be honest, polite, concrete. No corporate
   boilerplate. Give a clear next step. Length: as short as the
   situation allows (3–7 sentences typical). Do NOT pad to look thorough.

═══════════════════════════════════════════════════════════════
HARD RULES (non-negotiable, override anything else)
═══════════════════════════════════════════════════════════════

FOOD SAFETY:
  • NEVER tell a customer food is safe after spoilage/thaw/leak. No
    "still good", "safe to consume", "perfectly fine". Default position:
    "do not consume".
  • NEVER ask a customer to return frozen / chilled food.
  • Pre-sale composition / allergen questions: NEVER guess. Redirect to
    the product label / manufacturer with a generic disclaimer.

FACTS:
  • NEVER invent dates, carriers, statuses, or scan events.
  • Only use dates that appear in the CONTEXT or CARRIER TRACKING EVENTS
    sections. If a date is Unknown, do not mention any date.
  • carrierEstimatedDelivery (when set) is the source of truth for ETA —
    NEVER use promisedEdd if a fresher carrierEstimatedDelivery exists.

CANCELLATIONS (mirrors Table D):
  • Pending / null trackingStatus → cancel may be possible, offer it.
  • In-transit + customer says cancel → "once shipped, cancellation is
    no longer possible". Offer return-after-delivery.
  • Delivered → it's a return, not a cancel.

T21 SHIPPING MISMATCH:
  • Never admit the mismatch directly to the customer.
  • Use: "shipped using the fastest available shipping option at the time".
  • Offer partial refund for shipping difference (NOT full refund — the
    item is still arriving).

TONE:
  • NEVER blame the customer.
  • NEVER say "not our fault" or argue.
  • NEVER use emojis, marketing language, or external links.
  • NEVER ask the customer to change/remove a review, even if extortion.
  • NEVER tell the customer to contact the carrier directly — Amazon.
  • NEVER promise a specific refund amount unless explicitly instructed.
  • NEVER capitulate to threats. Stay calm, ask for the actual problem.

DUPLICATES:
  • Refund already issued → polite reminder + bank wait time. NEVER
    issue a duplicate refund.

═══════════════════════════════════════════════════════════════
RESPONSE FORMAT (minimal structure — body is freeform)
═══════════════════════════════════════════════════════════════

  Line 1:  "Dear {customerName},"  (or "Dear Customer," if name unknown)
           Spanish: "Estimado/a {customerName},"
  Line 2:  blank
  Body:    situation-specific paragraphs. 3–7 sentences typical.
  Blank line
  "Best regards,"
  {storeName}

NO mandatory thank-you. NO mandatory tracking sentence. NO padding.

═══════════════════════════════════════════════════════════════
INTERNAL ACTION CHOICES (queue routing, not customer-facing)
═══════════════════════════════════════════════════════════════
support_case / buy_shipping_reimbursement / sku_check / supplier_reorder / none

═══════════════════════════════════════════════════════════════
REASONING EXAMPLES (study these — they show the matrix in action)
═══════════════════════════════════════════════════════════════

EXAMPLE 1 — Damaged frozen product, claimsProtected, carrier delay
Customer: "uncrushable got all crushed due to packaging"
Facts: productType=Frozen (Uncrustables PB&J = frozen),
       daysInTransit=14, daysLate=8, claimsProtected=true,
       carrierSelfDeclaredDelay=true, "customer not available" event

Match: TABLE B row "Frozen C2 thawed/melted >3d, claimsProtected"
       → action=redirect_amazon, pays=amazon
Reasoning chain:
  - Source-of-truth: customer has the package → treat as delivered
  - Frozen 3-day rule: 14 days transit >> 3 → automatic carrier fault
  - claimsProtected=true → DO NOT replace at our expense → redirect Amazon
  - No lecturing about "don't consume" — 14 days transit, customer knows

  "Dear Customer,

  I'm sorry the Uncrustables arrived in that condition — fourteen days
  in transit is well beyond what should have happened, and the carrier
  is clearly responsible. Because the order was shipped through Amazon
  Buy Shipping, the fastest way to get this resolved is to open an
  A-to-Z Guarantee claim through your Amazon order page. Amazon will
  refund you directly and address the carrier issue on their end.

  If you have any trouble with that process, please let me know and
  I'll help walk you through it.

  Best regards,
  Salutem Solutions"

──────────────────────────────────────────────

EXAMPLE 2 — T21 mismatch, real carrier ETA available
Customer: "I needed this for 4/10/2026"
Facts: requested=NextDay, actual=UPS Ground, carrierEstimatedDelivery=2026-04-15,
       shipping cost charged $62

Match: TABLE A row "T21 mismatch" → action=clarify+partial, pays=us
Use real carrier ETA (April 15), not promisedEdd. Offer partial refund
for the shipping difference, not full.

  "Dear Deborah,

  Thank you for reaching out, and I completely understand the timing
  matters. Your order was processed and shipped using the fastest
  available shipping option at the time, and UPS now estimates delivery
  by April 15. Since the package is already in transit, cancellation is
  no longer possible.

  As a goodwill gesture for the timing, I can refund the shipping cost
  difference. If the item is no longer needed when it arrives, you can
  also start a return through your Amazon order page and we'll process
  the rest of the refund there.

  Best regards,
  Salutem Solutions"

──────────────────────────────────────────────

EXAMPLE 3 — Carrier scan error, no compensation
Customer: "Tracking says delivered in Round Rock, TX. I live in Marble Falls."
Facts: tracking events show Round Rock as a sorting facility, final scan
       was in Meadowlakes (next to Marble Falls)

Match: TABLE A row "Carrier scan shows wrong city" → action=clarify, pays=none
This is normal logistics, not a real problem.

  "Dear Customer,

  I understand the concern, but the Round Rock reference in the tracking
  is just the UPS sorting facility your package passed through on its
  way to your area. The actual delivery scan was in Meadowlakes, which
  is right next to Marble Falls — so the package should be at your
  address. If you can't locate it, please reply and we'll dig in further.

  Best regards,
  Salutem Solutions"

──────────────────────────────────────────────

EXAMPLE 4 — Refund request with no reason
Customer: "I want a refund."
Facts: status=delivered, no complaint detail, first message

Match: TABLE E row "no reason given" → action=clarify, pays=none
Never refund blind. Politely ask for the issue.

  "Dear Customer,

  I'd be glad to help look into a refund. Could you let me know a bit
  more about what's prompting the request — is there an issue with the
  product, the delivery, or something else? Once I understand what
  happened I can find the best way forward.

  Best regards,
  Salutem Solutions"

──────────────────────────────────────────────

EXAMPLE 5 — Customer-fault cancellation, no protection applies
Customer: "I ordered this by mistake, please cancel."
Facts: status=in_transit, claimsProtected=true, dry product, ETA in 2 days

Match: TABLE D row "Cancel in transit, ordered by mistake" → action=none, pays=buyer
claimsProtected does NOT help here — this is buyer fault.

  "Dear Customer,

  I understand, but unfortunately the order has already shipped and we
  can no longer cancel it once it's with the carrier. Once it arrives,
  you can return it through your Amazon order page for a refund — please
  note return shipping is the buyer's responsibility for change-of-mind
  returns. If you'd like, I can walk you through starting the return
  when the package arrives.

  Best regards,
  Salutem Solutions"

──────────────────────────────────────────────

EXAMPLE 6 — Replacement at our expense (no claimsProtected) with supplierReorderNote
Customer: "I got the wrong flavor. I ordered chicken, got beef."
Facts: status=delivered, claimsProtected=false, product=Freshpet Chicken,
       quantity=1, orderId=113-1234567-1234567

Match: TABLE C row "Wrong item" → action=clarify (then replacement), pays=us
Anti-abuse: ask for photo on first contact.

After photo confirmation OR if facts are obvious, action=replacement and
JSON output MUST include supplierReorderNote like:

  "supplierReorderNote": "Freshpet Chicken Recipe × 1 | reason: wrong item shipped (customer received Beef) | original: 113-1234567-1234567"

  "Dear Customer,

  I'm sorry — that's clearly the wrong item. To process the replacement,
  could you share a quick photo of what arrived (and the label) through
  your Amazon order page? Once I see it, I'll get the correct Chicken
  recipe on its way to you right away.

  Best regards,
  Salutem Solutions"

═══════════════════════════════════════════════════════════════
OUTPUT
═══════════════════════════════════════════════════════════════
Return a JSON object (schema in the user message). The "reasoning" field
should record:
  (a) the key customer phrase you trusted
  (b) which decision-matrix row matched (e.g. "Table B / Frozen thawed photo")
  (c) any conflict between customer and facts you noticed
  (d) the action chosen and why (cite the economic principle)

The "suggestedResponse" field MUST start with "Dear ".`;

export interface AnalysisInput {
  customerMessage: string;
  customerName: string | null;
  language: string;
  storeName: string;
  /** Sales channel — "Amazon" or "Walmart". Walmart cases have a
   *  different rule set (returns allowed for taste, all flows go through
   *  official Walmart return / report-issue, no partial refunds, etc.)
   *  See SYSTEM_PROMPT WALMART CHANNEL section. */
  channel?: string;
  amazonOrderId: string | null;
  orderDate: string | null;
  orderTotal: number | null;
  product: string | null;
  productType: string | null;
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  trackingStatus: string | null;
  shipDate: string | null;
  promisedEdd: string | null;
  actualDelivery: string | null;
  daysInTransit: number | null;
  daysLate: number | null;
  // Shipping service mismatch detection (T21) — set by the enricher from
  // Amazon order metadata vs Veeqo shipment data.
  requestedShippingService: string | null;
  actualShippingService: string | null;
  shippingMismatch: boolean;
  carrierEstimatedDelivery: string | null;
  // Carrier event history fetched directly from the carrier API (UPS
  // today; FedEx/USPS later). Each entry has date/time/description/
  // status/location. Passed into the prompt so the model can reason
  // about "package is currently in Atlanta as of 2026-04-12 14:30".
  trackingEvents?: Array<{
    date: string | null;
    time: string | null;
    description: string | null;
    status: string | null;
    location: string | null;
  }> | null;
  /** Documentary evidence the carrier itself flagged a delay/exception/
   *  weather event. Strongest signal for "carrier fault" routing. */
  carrierSelfDeclaredDelay?: boolean;
  boughtThroughVeeqo: boolean;
  claimsProtected: boolean;
  shippedOnTime: boolean | null;
  messageNumber: number;
  conversationHistory: Array<{
    date: string;
    direction: string;
    text: string;
    action: string | null;
  }>;
  hasAtozClaim: boolean;
  hasNegativeFeedback: boolean;
  // Optional extra instruction appended to the user message. Used by the
  // "Rewrite safer" button to steer the model (e.g. "Rewrite to be
  // strictly policy-safe for Amazon").
  extraInstruction?: string;
}

export interface FactCheckMismatch {
  field: "date" | "carrier" | "status";
  inResponse: string;
  actual: string;
  severity: "error" | "warning";
}

export interface FactCheckResult {
  passed: boolean;
  mismatches: FactCheckMismatch[];
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

export interface AnalysisResult {
  problemType: string;
  problemTypeName: string;
  riskLevel: string;
  action: string;
  secondaryAction: string | null;
  whoShouldPay: string;
  internalAction: string;
  foodSafetyRisk: boolean;
  atozRisk: string;
  suggestedResponse: string;
  reasoning: string;
  factCheck: FactCheckResult;
  /** When action=replacement, the model emits a structured note here so
   *  the operator (and Phase 2: Veeqo clone-order automation) can create
   *  a replacement order in Veeqo. Format:
   *    "{product} × {qty} | reason: {short} | original: {orderId}"
   *  Null when no replacement is needed. */
  supplierReorderNote: string | null;
}

// Produce several human-readable variants of a YYYY-MM-DD date so
// factCheckResponse can match the AI's prose ("April 8", "Apr 8", "4/8").
// Noon time avoids timezone edge cases where the date would roll back.
function formatDateVariants(dateStr: string): string[] {
  const d = new Date(dateStr + "T12:00:00");
  if (Number.isNaN(d.getTime())) return [];
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const monthsShort = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const month = d.getMonth();
  const day = d.getDate();
  return [
    `${monthsShort[month]} ${day}`,
    `${months[month]} ${day}`,
    `${month + 1}/${day}`,
    `${String(month + 1).padStart(2, "0")}/${String(day).padStart(2, "0")}`,
  ];
}

/**
 * Audit an AI-generated response against the known context data. Flags:
 *   - dates mentioned in the response that don't match shipDate / EDD /
 *     actualDelivery
 *   - carrier names that don't match the real carrier
 *   - tracking-status claims that contradict trackingStatus
 *
 * Any "error"-severity mismatch drops confidence to LOW. Any mismatch at
 * all drops it to at most MEDIUM. Clean response = HIGH confidence.
 */
export function factCheckResponse(
  response: string,
  context: AnalysisInput
): FactCheckResult {
  const mismatches: FactCheckMismatch[] = [];

  if (!response) {
    return { passed: true, mismatches: [], confidence: "HIGH" };
  }

  // --- Date checks ---
  if (context.shipDate || context.promisedEdd || context.actualDelivery) {
    const datePatterns =
      response.match(
        /(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}/gi
      ) || [];
    const shipDateFormatted = context.shipDate
      ? formatDateVariants(context.shipDate)
      : [];
    const eddFormatted = context.promisedEdd
      ? formatDateVariants(context.promisedEdd)
      : [];
    const deliveryFormatted = context.actualDelivery
      ? formatDateVariants(context.actualDelivery)
      : [];

    for (const dateInResponse of datePatterns) {
      const normalized = dateInResponse.trim().toLowerCase();
      const matches = (variants: string[]): boolean =>
        variants.some((v) => normalized.includes(v.toLowerCase()));
      if (
        !matches(shipDateFormatted) &&
        !matches(eddFormatted) &&
        !matches(deliveryFormatted)
      ) {
        mismatches.push({
          field: "date",
          inResponse: dateInResponse.trim(),
          actual: `Ship: ${context.shipDate || "N/A"}, EDD: ${context.promisedEdd || "N/A"}`,
          severity: "error",
        });
      }
    }
  }

  // --- Carrier check ---
  if (context.carrier) {
    const carrierMatch = response.match(/shipped via ([A-Za-z\s]+?)[\s,\.]/i);
    if (carrierMatch) {
      const inResponse = carrierMatch[1].trim().toLowerCase();
      const actualLower = context.carrier.toLowerCase();
      // Normalise common Veeqo values ("Buy Shipping" → "ups", "UPS®" → "ups")
      const actualNormalised = actualLower
        .replace("buy shipping", "ups")
        .replace("®", "")
        .trim();
      if (
        !inResponse.includes(actualNormalised) &&
        !actualNormalised.includes(inResponse)
      ) {
        mismatches.push({
          field: "carrier",
          inResponse: carrierMatch[1].trim(),
          actual: context.carrier,
          severity: "error",
        });
      }
    }
  }

  // --- Status checks ---
  const lower = response.toLowerCase();
  if (
    context.trackingStatus === "in_transit" &&
    /has been delivered|was delivered|package (?:was|has been) delivered/.test(
      lower
    )
  ) {
    mismatches.push({
      field: "status",
      inResponse: "delivered",
      actual: "in_transit",
      severity: "error",
    });
  }
  if (
    context.trackingStatus === "delivered" &&
    /is currently in transit|on its way|still in transit/.test(lower)
  ) {
    mismatches.push({
      field: "status",
      inResponse: "in transit",
      actual: "delivered",
      severity: "error",
    });
  }

  const hasErrors = mismatches.some((m) => m.severity === "error");
  const confidence: "HIGH" | "MEDIUM" | "LOW" = hasErrors
    ? "LOW"
    : mismatches.length > 0
      ? "MEDIUM"
      : "HIGH";
  return {
    passed: mismatches.length === 0,
    mismatches,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Post-generation validator + auto-fix
// ---------------------------------------------------------------------------
// The SYSTEM_PROMPT already tells the model not to suggest cancellations
// for shipped orders, invent dates, guarantee food safety, etc. — but AI
// still slips through those rules occasionally. This layer runs AFTER
// generation, catches the 6 most common policy violations, and if any are
// found it re-runs the model with a tight corrective prompt. If the retry
// also fails we fall back to a deterministic safe template.

interface ValidationResult {
  fixed: boolean;
  response: string;
  fixReason: string | null;
}

function buildSafeResponse(input: AnalysisInput): string {
  const name = input.customerName || "Customer";
  const store = input.storeName;
  // Normalise carrier label: Veeqo returns "Buy Shipping" (brand name)
  // when we purchased through their Buy Shipping program. Derive the
  // actual carrier from service_name for customer-facing copy.
  const niceCarrier = deriveCarrierLabel(input);

  // T21 — shipping service mismatch. Takes priority over generic in_transit
  // template because the response must NOT admit the mismatch and must
  // NOT redirect to Amazon CS (that implies we failed). Instead it follows
  // the KB canonical pattern: "fastest available option", wait for delivery,
  // then return through Amazon if needed.
  if (input.shippingMismatch && input.trackingStatus !== "delivered") {
    const deliveryDate =
      input.carrierEstimatedDelivery || input.promisedEdd || "the scheduled date";
    return `Dear ${name},\n\nThank you for your message.\n\nI understand your concern regarding the delivery timing. Your order was processed and shipped promptly using the fastest available shipping option at the time.\n\nAt this stage, the package is already in transit with ${niceCarrier} and is currently scheduled for delivery on ${deliveryDate}. Unfortunately, once an order has been shipped, we are unable to cancel it.\n\nWe recommend waiting for delivery. If the item is no longer needed upon arrival, you can request a return or refund through your Amazon account.\n\nIf you need any assistance with that process, please feel free to reach out.\n\nBest regards,\n${store}`;
  }

  if (input.trackingStatus === "in_transit") {
    return `Dear ${name},\n\nThank you for reaching out about your order. Your package was shipped on ${input.shipDate || "the scheduled date"} via ${niceCarrier} and is currently in transit. We understand the delivery is taking longer than expected, and we apologize for the inconvenience. For the fastest resolution regarding this delivery delay, we recommend contacting Amazon Customer Support through your order page.\n\nBest regards,\n${store}`;
  }

  if (input.trackingStatus === "delivered") {
    return `Dear ${name},\n\nThank you for contacting us. According to tracking information, your package was delivered on ${input.actualDelivery || "the expected date"}. If you have not received it, we recommend checking with neighbors, your front desk, or any secure delivery locations. For further assistance, please contact Amazon Customer Support through your order page.\n\nBest regards,\n${store}`;
  }

  return `Dear ${name},\n\nThank you for reaching out. We are looking into your concern and will provide an update shortly. If you need immediate assistance, please contact Amazon Customer Support through your order page.\n\nBest regards,\n${store}`;
}

/**
 * Derive a display-friendly carrier label. Veeqo's API returns
 * carrier_name = "Buy Shipping" when an order went through Amazon's
 * Buy Shipping program — that's a billing concept, not a carrier the
 * customer recognises. Infer the real carrier from the service name.
 */
function deriveCarrierLabel(input: AnalysisInput): string {
  const rawCarrier = (input.carrier || "").trim();
  const rawService = (input.actualShippingService || input.service || "").trim();
  const serviceLower = rawService.toLowerCase();

  if (rawCarrier && rawCarrier.toLowerCase() !== "buy shipping") {
    return rawCarrier;
  }
  if (serviceLower.includes("ups")) return "UPS";
  if (serviceLower.includes("usps") || serviceLower.includes("priority")) {
    return "USPS";
  }
  if (serviceLower.includes("fedex")) return "FedEx";
  if (serviceLower.includes("dhl")) return "DHL";
  return rawCarrier || "the carrier";
}

export interface ValidatorAnalysisContext {
  /** Who should pay for resolution — from AnalysisResult.whoShouldPay */
  whoShouldPay?: string;
  /** Food-safety-risk flag — from AnalysisResult.foodSafetyRisk */
  foodSafetyRisk?: boolean;
}

/**
 * Pure detection — finds policy violations in a generated response but
 * does NOT rewrite it. Used by analyzeMessage to flag warnings on the
 * original model output, and by validateAndFixResponse when the operator
 * explicitly asks for an auto-rewrite via the Fix button.
 */
export function detectResponseViolations(
  response: string,
  input: AnalysisInput,
  factCheck: FactCheckResult,
  analysisContext: ValidatorAnalysisContext = {}
): string[] {
  const violations: string[] = [];
  const lower = response.toLowerCase();

  // RULE 1 — cancel suggested but order is shipped (pending counts as ok)
  if (
    lower.includes("cancel") &&
    input.trackingStatus &&
    input.trackingStatus !== "pending" &&
    !lower.includes("cancellation may not be possible")
  ) {
    violations.push(
      `Response suggests cancellation but order is already ${input.trackingStatus}`
    );
  }

  // RULE 2 — factCheck caught wrong dates
  if (
    factCheck.mismatches.some(
      (m) => m.field === "date" && m.severity === "error"
    )
  ) {
    violations.push("Response contains incorrect dates");
  }

  // RULE 3 — says delivered but in transit
  if (
    input.trackingStatus === "in_transit" &&
    lower.includes("has been delivered")
  ) {
    violations.push("Response says delivered but order is in transit");
  }

  // RULE 4 — says in transit but delivered
  if (
    input.trackingStatus === "delivered" &&
    lower.includes("currently in transit")
  ) {
    violations.push("Response says in transit but order is delivered");
  }

  // RULE 5 — seller-funded refund offered when Amazon should pay
  if (
    analysisContext.whoShouldPay === "amazon" &&
    /we will refund|i will process a refund|full refund from us/i.test(response)
  ) {
    violations.push("Response offers seller refund but Amazon should pay");
  }

  // RULE 6 — guaranteeing food safety after spoilage
  if (
    analysisContext.foodSafetyRisk &&
    /safe to consume|perfectly safe|still good/i.test(response)
  ) {
    violations.push(
      "Response guarantees food safety after spoilage complaint"
    );
  }

  return violations;
}

export async function validateAndFixResponse(
  response: string,
  input: AnalysisInput,
  factCheck: FactCheckResult,
  analysisContext: ValidatorAnalysisContext = {}
): Promise<ValidationResult> {
  const violations = detectResponseViolations(
    response,
    input,
    factCheck,
    analysisContext
  );

  if (violations.length === 0) {
    return { fixed: false, response, fixReason: null };
  }

  console.log("[Validator] Violations detected:", violations);
  console.log("[Validator] Auto-fixing response…");

  const niceCarrier = deriveCarrierLabel(input);
  const carrierEstDelivery =
    input.carrierEstimatedDelivery || input.promisedEdd || "the scheduled date";

  // T21 special path: when shipping mismatch is flagged, we do NOT want
  // the generic "in transit → contact Amazon CS" boilerplate. Instead we
  // give the model the canonical KB response as the target and tell it
  // to rewrite matching that pattern.
  const t21Instructions = input.shippingMismatch
    ? `
SPECIAL CASE — SHIPPING MISMATCH (T21):
This customer paid for "${input.requestedShippingService || "expedited"}" shipping but the order shipped via "${input.actualShippingService || "standard"}".
Your rewrite MUST follow this exact pattern (substitute real values):

"Dear ${input.customerName || "Customer"},

Thank you for your message.

I understand your concern regarding the delivery timing. Your order was processed and shipped promptly using the fastest available shipping option at the time.

At this stage, the package is already in transit with ${niceCarrier} and is currently scheduled for delivery on ${carrierEstDelivery}. Unfortunately, once an order has been shipped, we are unable to cancel it.

We recommend waiting for delivery. If the item is no longer needed upon arrival, you can request a return or refund through your Amazon account.

If you need any assistance with that process, please feel free to reach out.

Best regards,
${input.storeName}"

CRITICAL T21 RULES:
- NEVER say "we couldn't buy Next Day" or "we could not purchase expedited shipping"
- NEVER say "Amazon didn't offer that rate"
- NEVER admit the mismatch directly
- DO say "fastest available shipping option at the time"
- DO suggest wait for delivery → return through Amazon if not needed
- DO NOT redirect to Amazon Customer Support (implies we failed)
`
    : "";

  const fixPrompt = `Your previous response had policy violations. Rewrite it following these MANDATORY constraints:

VIOLATIONS FOUND:
${violations.map((v, i) => `${i + 1}. ${v}`).join("\n")}

ORIGINAL RESPONSE:
"${response}"

FACTS (use ONLY these dates and data):
- Ship Date: ${input.shipDate || "unknown"}
- EDD: ${input.promisedEdd || "unknown"}
- Carrier Estimated Delivery: ${input.carrierEstimatedDelivery || "unknown"}
- Actual Delivery: ${input.actualDelivery || "not yet"}
- Tracking Status: ${input.trackingStatus || "unknown"}
- Carrier (display): ${niceCarrier}
- Requested Shipping: ${input.requestedShippingService || "unknown"}
- Actual Shipping: ${input.actualShippingService || "unknown"}
- Shipping Mismatch: ${input.shippingMismatch ? "YES" : "No"}
- Days In Transit: ${input.daysInTransit ?? "unknown"}
- Days Late: ${input.daysLate ?? "0"}
- Customer Name: ${input.customerName || "Customer"}
- Store Name: ${input.storeName}
${t21Instructions}
MANDATORY RULES FOR REWRITE:
- Start with "Dear ${input.customerName || "Customer"},"
- Use ONLY the dates listed above — do NOT change them
- If shippingMismatch is YES: follow the T21 pattern above (do NOT redirect to Amazon CS)
- If order is in_transit and NOT a mismatch: say "your order is currently in transit" and "we recommend contacting Amazon Customer Support through your order page"
- If order is delivered: reference the delivery
- NEVER suggest cancellation for shipped orders
- NEVER offer seller refund if Amazon should pay
- NEVER guarantee food safety
- End with "Best regards," and store name
- Keep 4-8 sentences

Return ONLY the rewritten response text, no JSON, no explanation.`;

  try {
    const config = await getAIConfig();
    for (const provider of config.providerChain) {
      const model =
        provider === "claude" ? config.claudeModel : config.openaiModel;
      try {
        const fixedText =
          provider === "claude"
            ? await callClaudeRaw(fixPrompt, model)
            : await callOpenAIRaw(fixPrompt, model);
        const trimmed = fixedText.trim();
        if (trimmed && trimmed.toLowerCase().startsWith("dear")) {
          console.log(`[Validator] Response fixed with ${provider}`);
          return {
            fixed: true,
            response: trimmed,
            fixReason: violations.join("; "),
          };
        }
      } catch (e) {
        console.warn(
          `[Validator] ${provider} rewrite failed:`,
          e instanceof Error ? e.message : String(e)
        );
      }
    }
  } catch (e) {
    console.error("[Validator] Auto-fix chain failed:", e);
  }

  // Last-resort deterministic template
  console.log("[Validator] Falling back to safe template");
  return {
    fixed: true,
    response: buildSafeResponse(input),
    fixReason: `Auto-fix failed, using safe template: ${violations.join("; ")}`,
  };
}

// Provider call returns the raw text from the model. Parsing + greeting
// fallback happens in tryParseAnalysis, which is shared between providers
// since both models return the same JSON schema.
async function callClaude(
  userMessage: string,
  model: string
): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });
  return response.content[0].type === "text" ? response.content[0].text : "";
}

async function callOpenAI(
  userMessage: string,
  model: string
): Promise<string> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model,
    max_tokens: 2000,
    // Low temperature for consistent structured JSON output
    temperature: 0.3,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
  });
  return response.choices[0]?.message?.content || "";
}

// Raw text-only provider calls for the validator. Unlike the analysis
// calls above these DO NOT send SYSTEM_PROMPT — the validator passes its
// own constrained prompt and expects plain-text output, not JSON.
async function callClaudeRaw(
  prompt: string,
  model: string
): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model,
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });
  return response.content[0].type === "text" ? response.content[0].text : "";
}

async function callOpenAIRaw(
  prompt: string,
  model: string
): Promise<string> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model,
    max_tokens: 1000,
    temperature: 0.3,
    messages: [{ role: "user", content: prompt }],
  });
  return response.choices[0]?.message?.content || "";
}

export async function analyzeMessage(
  input: AnalysisInput
): Promise<AnalysisResult> {
  // Runtime-configurable: operator picks primary provider + model per
  // provider from the Settings UI (Setting table). Providers without a
  // valid .env key are stripped from the chain automatically.
  const config = await getAIConfig();
  if (config.providerChain.length === 0) {
    console.error(
      "[Analyzer] No AI providers configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env"
    );
    return fallbackResult(input);
  }

  // Pull similar past cases from the knowledge base to give Claude/OpenAI
  // concrete worked examples. For shipping-mismatch cases we bias the
  // lookup to T21 so we always find the canonical scenario.
  let similarCases: KnowledgeBaseHint[] = [];
  try {
    similarCases = await findSimilarCases(
      input.shippingMismatch ? "T21" : null,
      input.customerMessage?.substring(0, 100) || null,
      3
    );
    if (similarCases.length > 0) {
      console.log(
        `[Analyzer] Found ${similarCases.length} similar KB case(s)`
      );
    }
  } catch (e) {
    console.warn(
      "[Analyzer] Knowledge base lookup failed:",
      e instanceof Error ? e.message : String(e)
    );
  }

  const userMessage = buildContextMessage(input, similarCases);
  let lastError = "";

  for (const provider of config.providerChain) {
    const model =
      provider === "claude" ? config.claudeModel : config.openaiModel;
    try {
      console.log(`[Analyzer] Trying ${provider} (${model})…`);
      const text =
        provider === "claude"
          ? await callClaude(userMessage, model)
          : await callOpenAI(userMessage, model);

      const parsed = tryParseAnalysis(text, input);
      if (parsed) {
        console.log(`[Analyzer] Success with ${provider}`);
        // Hybrid post-generation validator (Decision Matrix v2):
        //   - Hard violations (factual errors, direct contradictions) →
        //     auto-fix via validateAndFixResponse
        //   - Subtle violations (style, food safety phrasing) → flag-only
        //     in reasoning, operator decides
        // Hard category: cancel-suggested-for-shipped, "delivered when
        // in transit", "in transit when delivered", incorrect dates,
        // seller-funded refund when Amazon should pay.
        // Subtle category: food safety wording, threats response style.
        const warnings = detectResponseViolations(
          parsed.suggestedResponse,
          input,
          parsed.factCheck,
          {
            whoShouldPay: parsed.whoShouldPay,
            foodSafetyRisk: parsed.foodSafetyRisk,
          }
        );
        if (warnings.length > 0) {
          const hardKeywords = [
            "incorrect dates",
            "cancellation",
            "delivered but order is",
            "in transit but order is",
            "seller refund but Amazon",
          ];
          const hardViolations = warnings.filter((w) =>
            hardKeywords.some((kw) =>
              w.toLowerCase().includes(kw.toLowerCase())
            )
          );
          const subtleViolations = warnings.filter(
            (w) => !hardViolations.includes(w)
          );

          if (hardViolations.length > 0) {
            console.log(
              `[Analyzer] 🔧 ${hardViolations.length} HARD violation(s) — auto-fixing:`,
              hardViolations
            );
            try {
              const fix = await validateAndFixResponse(
                parsed.suggestedResponse,
                input,
                parsed.factCheck,
                {
                  whoShouldPay: parsed.whoShouldPay,
                  foodSafetyRisk: parsed.foodSafetyRisk,
                }
              );
              if (fix.fixed) {
                parsed.suggestedResponse = fix.response;
                parsed.factCheck = factCheckResponse(
                  parsed.suggestedResponse,
                  input
                );
                parsed.reasoning =
                  `${parsed.reasoning || ""} [AUTO-FIXED: ${fix.fixReason}]`.trim();
              }
            } catch (e) {
              console.error(
                "[Analyzer] Auto-fix threw:",
                e instanceof Error ? e.message : String(e)
              );
            }
          }

          if (subtleViolations.length > 0) {
            console.log(
              `[Analyzer] ⚠️  ${subtleViolations.length} subtle violation(s) flagged:`,
              subtleViolations
            );
            parsed.reasoning =
              `${parsed.reasoning || ""} [NEEDS REVIEW: ${subtleViolations.join("; ")}]`.trim();
          }
        }
        return parsed;
      }
      lastError = `${provider} returned unparseable response`;
      console.error(`[Analyzer] ${lastError}`);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      console.error(`[Analyzer] ${provider} failed: ${lastError}`);
      // Fall through to next provider
    }
  }

  console.error(
    `[Analyzer] All providers failed. Last error: ${lastError}. Using heuristic fallback.`
  );
  return fallbackResult(input);
}

// Re-export the provider type so other modules can reference it
export type { ProviderName };

function buildContextMessage(
  input: AnalysisInput,
  similarCases: KnowledgeBaseHint[] = []
): string {
  let msg = `ANALYZE THIS CUSTOMER MESSAGE AND RESPOND IN JSON FORMAT.

CUSTOMER MESSAGE:
"${input.customerMessage}"

CONTEXT:
- Store: ${input.storeName}
- Customer: ${input.customerName || "Unknown"}
- Language: ${input.language}
- Order ID: ${input.amazonOrderId || "Unknown"}
- Order Date: ${input.orderDate || "Unknown"}
- Order Total: ${input.orderTotal ? "$" + input.orderTotal : "Unknown"}
- Product: ${input.product || "Unknown"}
- Product Type: ${input.productType || "Unknown"}

CHANNEL: ${input.channel || "Amazon"}

SHIPPING:
- Carrier: ${input.carrier || "Unknown"}
- Service: ${input.service || "Unknown"}
- Requested Shipping Service: ${input.requestedShippingService || "Unknown"}
- Actual Shipping Service: ${input.actualShippingService || "Unknown"}
- Shipping Mismatch: ${input.shippingMismatch ? "YES — customer paid for different service than what was shipped" : "No"}
- Carrier Estimated Delivery: ${input.carrierEstimatedDelivery || "Unknown"}
- Tracking: ${input.trackingNumber || "None"}
- Status: ${input.trackingStatus || "Unknown"}
- Ship Date: ${input.shipDate || "Unknown"}
- Promised EDD: ${input.promisedEdd || "Unknown"}
- Actual Delivery: ${input.actualDelivery || "Unknown"}
- Days In Transit: ${input.daysInTransit ?? "Unknown"}
- Days Late: ${input.daysLate ?? "N/A"}
- Buy Shipping (Veeqo): ${input.boughtThroughVeeqo ? "YES" : "NO"}
- Claims Protected: ${input.claimsProtected ? "YES — Buy Shipping + shipped on time → Amazon covers carrier issues via A-to-Z" : "NO"}
- Carrier Self-Declared Delay: ${input.carrierSelfDeclaredDelay ? "YES — tracking events contain explicit delay/exception/weather event" : "No"}
- Shipped On Time: ${input.shippedOnTime === null ? "Unknown" : input.shippedOnTime ? "YES" : "NO"}

${
    input.trackingEvents && input.trackingEvents.length > 0
      ? `CARRIER TRACKING EVENTS (direct from carrier API — chronological, earliest first):
${input.trackingEvents
  .map((e) => {
    const when = [e.date, e.time].filter(Boolean).join(" ");
    const where = e.location ? ` @ ${e.location}` : "";
    return `  - ${when}: ${e.description || "(no description)"}${where}`;
  })
  .join("\n")}

Use these events as authoritative facts about where the package is and what has happened. Do NOT invent dates or statuses that are not in this list. If Carrier Estimated Delivery is set, treat it as the single source of truth for the expected delivery date.
`
      : ""
  }
MESSAGE HISTORY:
- This is message #${input.messageNumber} from this customer about this order
- Has A-to-Z claim: ${input.hasAtozClaim ? "YES" : "NO"}
- Has negative feedback: ${input.hasNegativeFeedback ? "YES" : "NO"}`;

  if (input.conversationHistory.length > 0) {
    msg += "\n\nPREVIOUS MESSAGES:\n";
    for (const h of input.conversationHistory) {
      msg += `[${h.date}] ${h.direction === "incoming" ? "CUSTOMER" : "OUR REPLY"}: ${h.text.substring(0, 200)}${h.text.length > 200 ? "..." : ""}\n`;
      if (h.action) msg += `  Action taken: ${h.action}\n`;
    }
  }

  if (similarCases.length > 0) {
    msg += "\n\nKNOWLEDGE BASE — SIMILAR PAST CASES:\n";
    for (const kb of similarCases) {
      msg += "---\n";
      msg += `Scenario: ${kb.scenario}\n`;
      msg += `Customer said: ${kb.customerSaid}\n`;
      msg += `Correct action: ${kb.correctAction}\n`;
      msg += `Correct response: ${kb.correctResponse.substring(0, 200)}\n`;
      msg += `Reasoning: ${kb.reasoning}\n`;
      msg += `Outcome: ${kb.outcome || "unknown"}\n`;
    }
    msg +=
      "\nUse these past cases as GUIDANCE for your response. Adapt to current situation.\n";
  }

  if (input.extraInstruction) {
    msg += `\n\nADDITIONAL INSTRUCTION:\n${input.extraInstruction}`;
  }

  msg += `

RESPOND WITH VALID JSON ONLY (no markdown, no backticks):
{
  "problemType": "T1-T21",
  "problemTypeName": "short name",
  "riskLevel": "LOW|MEDIUM|HIGH|CRITICAL",
  "action": "clarify|redirect_amazon|replacement|partial_refund|full_refund|reassure|investigate|none",
  "secondaryAction": "fallback action or null",
  "whoShouldPay": "us|amazon|carrier|buyer|none",
  "internalAction": "support_case|buy_shipping_reimbursement|sku_check|supplier_reorder|none",
  "foodSafetyRisk": true/false,
  "atozRisk": "low|medium|high",
  "suggestedResponse": "The complete response to send to the customer. Sign off as ${input.storeName}.",
  "reasoning": "(a) key customer phrase quoted, (b) which decision-matrix row matched (e.g. 'Table B / Frozen C2'), (c) any conflict between customer and facts, (d) action chosen and the economic principle that drove it (claimsProtected? carrierSelfDeclaredDelay? frozen+>3d? customer fault? etc.)",
  "supplierReorderNote": "REQUIRED when action=replacement: '{product} × {qty} | reason: {short} | original: {orderId}'. NULL otherwise."
}`;

  return msg;
}

// Belt-and-braces: Claude sometimes still skips the greeting despite the
// prompt's "VIOLATION CHECK" clause. If the response doesn't start with
// "Dear" (or the Spanish equivalent), prepend a correct greeting so the
// operator never has to hand-add one.
function ensureGreeting(
  response: string,
  input: AnalysisInput
): string {
  if (!response) return response;
  const trimmed = response.trimStart();
  const startsWithGreeting =
    /^dear\b/i.test(trimmed) || /^estimad[oa]\b/i.test(trimmed);
  if (startsWithGreeting) return response;

  const isSpanish = /^es/i.test(input.language);
  const nameForGreeting = input.customerName || "Customer";
  const greeting = isSpanish
    ? `Estimado/a ${nameForGreeting},`
    : `Dear ${nameForGreeting},`;
  return `${greeting}\n\n${trimmed}`;
}

// Ensure response ends with "Best regards,\n{store}" — Claude usually gets
// this right but OpenAI (especially gpt-4o-mini) sometimes forgets. We add
// the sign-off only if it's missing, preserving any existing closing.
function ensureClosing(
  response: string,
  input: AnalysisInput
): string {
  if (!response) return response;
  const trimmed = response.trimEnd();
  // Accept any "Best regards", "Kind regards", "Sincerely", or Spanish
  // "Atentamente" / "Saludos" as evidence of an explicit closing.
  const hasClosing =
    /(best regards|kind regards|sincerely|atentamente|saludos|cordialmente)/i.test(
      trimmed
    );
  if (hasClosing) return response;

  const isSpanish = /^es/i.test(input.language);
  const closing = isSpanish ? "Atentamente," : "Best regards,";
  return `${trimmed}\n\n${closing}\n${input.storeName}`;
}

// Provider-loop parser. Returns null on failure so the caller can fall
// through to the next provider. For a "safe" parser that returns a
// fallback result on failure, use the existing fallbackResult() directly.
function tryParseAnalysis(
  text: string,
  input: AnalysisInput
): AnalysisResult | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed || typeof parsed !== "object") return null;
    const suggestedResponse = ensureClosing(
      ensureGreeting(parsed.suggestedResponse || "", input),
      input
    );
    return {
      problemType: parsed.problemType || "T18",
      problemTypeName: parsed.problemTypeName || "Unknown",
      riskLevel: parsed.riskLevel || "MEDIUM",
      action: parsed.action || "investigate",
      secondaryAction: parsed.secondaryAction || null,
      whoShouldPay: parsed.whoShouldPay || "us",
      internalAction: parsed.internalAction || "none",
      foodSafetyRisk: parsed.foodSafetyRisk || false,
      atozRisk: parsed.atozRisk || "low",
      suggestedResponse,
      reasoning: parsed.reasoning || "",
      factCheck: factCheckResponse(suggestedResponse, input),
      supplierReorderNote:
        typeof parsed.supplierReorderNote === "string" &&
        parsed.supplierReorderNote.trim().length > 0
          ? parsed.supplierReorderNote.trim()
          : null,
    };
  } catch (e) {
    console.error("[Analyzer] JSON parse failed:", e);
    return null;
  }
}

function fallbackResult(input: AnalysisInput): AnalysisResult {
  const suggestedResponse = `Dear ${input.customerName || "Customer"},\n\nThank you for reaching out. We are looking into your concern and will get back to you shortly.\n\nBest regards,\n${input.storeName}`;
  return {
    problemType: "T18",
    problemTypeName: "Unable to classify",
    riskLevel: "MEDIUM",
    action: "investigate",
    secondaryAction: null,
    whoShouldPay: "us",
    internalAction: "none",
    foodSafetyRisk: false,
    atozRisk: "low",
    suggestedResponse,
    reasoning: "AI analysis unavailable, using safe fallback",
    // Safe fallback has no AI-generated dates/carriers → always passes
    factCheck: { passed: true, mismatches: [], confidence: "HIGH" },
    supplierReorderNote: null,
  };
}
