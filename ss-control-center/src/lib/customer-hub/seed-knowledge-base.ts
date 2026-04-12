/**
 * Knowledge Base — 40 reference cases
 *
 * Comprehensive seed of the Customer Hub knowledge base covering the full
 * T1–T21 taxonomy across Amazon + Walmart channels. Used by the Decision
 * Engine (message-analyzer.ts) via findSimilarCases() to give the model
 * concrete worked examples alongside the decision matrix in the prompt.
 *
 * Entries flagged "CORRECTED" incorporate direct corrections from the
 * business owner during the 2026-04-11 audit:
 *   - Carrier delay + Buy Shipping → redirect Amazon (don't admit coverage)
 *   - Frozen significant delay → offer choice (replacement OR refund)
 *   - Food safety advice → NEVER (no "may still be safe")
 *   - Illness / FDA → NO vet expense mention (liability)
 *   - Shipping mismatch → NEVER admit directly
 *   - T9 shipping cost food → redirect Amazon CS (don't suggest return)
 *   - Walmart → always through official Walmart flow
 *   - A-to-Z already filed → don't promise separate seller refund
 *
 * The seed is idempotent — calling seedKnowledgeBase() when any entries
 * already exist is a no-op. Use POST /api/customer-hub/knowledge-base/seed
 * with { force: true } to wipe and re-insert after editing this file.
 */

import { prisma } from "@/lib/prisma";
import type { KnowledgeBaseEntryInput } from "./knowledge-base";

const KB_ENTRIES: KnowledgeBaseEntryInput[] = [
  // ────────── Delivery & Tracking (T1/T2/T3) ──────────
  {
    problemType: "T1",
    scenario: "In transit within EDD, customer asks when",
    customerSaid: "haven't received it, when will it arrive",
    trackingStatus: "in_transit",
    productType: "Frozen",
    correctAction: "reassure",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out! Your order is currently in transit with UPS and is on schedule for delivery by {EDD}. The package was shipped on {shipDate} and has been moving through the carrier network normally.\n\nPlease allow until that date for delivery. If you haven't received it by then, please let us know and we'll make it right.\n\nBest regards,\n{store}",
    reasoning: "In transit within EDD, standard reassure",
    whoShouldPay: "none",
    tags: "in_transit,within_edd,reassure",
  },
  {
    // CORRECTED
    problemType: "T1",
    scenario: "In transit past EDD 2 days, carrier delay, Buy Shipping",
    customerSaid: "supposed to arrive by April 9, still hasn't come",
    trackingStatus: "in_transit",
    productType: "Dry",
    correctAction: "redirect_amazon",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out, and I apologize for the delay with your order. Your package was shipped on {shipDate} via UPS Ground and is currently in transit, with an updated estimated delivery of {carrierETA}.\n\nThis delay appears to be a carrier transit issue. For the fastest resolution, please contact Amazon Customer Support through your order page.\n\nBest regards,\n{store}",
    reasoning:
      "Buy Shipping + carrier delay = redirect Amazon. Removed 'you are fully covered'",
    whoShouldPay: "amazon",
    tags: "carrier_delay,buy_shipping,past_edd,redirect",
  },
  {
    problemType: "T2",
    scenario: "Delivered per tracking but customer says not received",
    customerSaid: "tracking says delivered but I don't have it",
    trackingStatus: "delivered",
    productType: "Frozen",
    correctAction: "investigate",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out. According to the tracking information, your package was delivered on {actualDelivery}. We understand this can be concerning.\n\nWe recommend checking the following locations: your front porch, mailbox, any parcel lockers, with neighbors, or other household members.\n\nIf you're unable to locate the package, please contact Amazon Customer Support through your order page for the fastest resolution.\n\nBest regards,\n{store}",
    reasoning: "Delivered + Buy Shipping = redirect Amazon after check",
    whoShouldPay: "amazon",
    tags: "delivered,not_received,investigate",
  },
  {
    // CORRECTED
    problemType: "T3",
    scenario: "Frozen food significant carrier delay 4 days, Buy Shipping",
    customerSaid:
      "paid for 2 day shipping, still hasn't arrived, frozen food will be ruined, very upset",
    trackingStatus: "in_transit",
    productType: "Frozen",
    correctAction: "refund_or_replacement",
    correctResponse:
      "Dear Customer,\n\nI sincerely apologize for the delay. Since this is a frozen item and the package has been in transit far longer than expected, the product quality may have been compromised. Please do not use the item if it arrives in poor condition.\n\nWe can resolve this for you right away with either a replacement or a full refund. Please let us know which option you prefer.\n\nBest regards,\n{store}",
    reasoning:
      "Frozen + significant delay = product likely compromised. Offer choice not just replacement. Buy Shipping = Amazon reimbursement later",
    whoShouldPay: "amazon",
    tags: "frozen,carrier_delay,significant,buy_shipping",
  },
  {
    problemType: "T2",
    scenario: "Delivered to wrong city",
    customerSaid: "delivered in Round Rock TX, I live in Marble Falls TX",
    trackingStatus: "delivered",
    productType: "Frozen",
    correctAction: "redirect_amazon",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out. I can see the package was marked as delivered to Round Rock, TX, while your address is in Marble Falls, TX. This appears to be a carrier delivery error.\n\nWe recommend contacting Amazon Customer Support through your order page for the fastest resolution.\n\nBest regards,\n{store}",
    reasoning: "Misdelivery + Buy Shipping = Amazon handles",
    whoShouldPay: "amazon",
    tags: "misdelivery,wrong_city,redirect",
  },

  // ────────── Spoilage / Damage / Safety (T4/T5/T8/T15) ──────────
  {
    // CORRECTED
    problemType: "T4",
    scenario: "Slight thaw, delivered in 2 days, no photos",
    customerSaid: "food arrived a little soft, is it still safe for my dog",
    trackingStatus: "delivered",
    productType: "Frozen",
    correctAction: "clarify_offer_replacement",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out about your order.\n\nCould you please share a photo of the product and packaging? Slight softness can sometimes happen during transit, but if you have any concerns about the condition, please do not use the product. We can send a replacement at no additional cost.\n\nBest regards,\n{store}",
    reasoning:
      "Slight thaw, delivered within 3 days = ask photo. Removed food safety advice 'may still be safe'. Offer replacement proactively",
    whoShouldPay: "us",
    tags: "frozen,slight_thaw,photo_request,3day",
  },
  {
    problemType: "T4",
    scenario: "Melted frozen food, 6 days transit, carrier delay",
    customerSaid:
      "frozen food arrived completely melted and warm, had to throw it all away, unacceptable",
    trackingStatus: "delivered",
    productType: "Frozen",
    correctAction: "replacement",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out, and I sincerely apologize for this experience. I completely understand your frustration.\n\nYour package was shipped on {shipDate} and should have arrived by {EDD}, but was delayed by the carrier until {actualDelivery}. After {daysInTransit} days in transit, the product quality was compromised.\n\nWe can send you a replacement at no additional cost. Please do not return the product for food safety reasons.\n\nBest regards,\n{store}",
    reasoning:
      "Melted + carrier delay + Buy Shipping = replacement + Amazon reimbursement",
    whoShouldPay: "amazon",
    tags: "frozen,melted,carrier_delay,replacement",
  },
  {
    // CORRECTED
    problemType: "T15",
    scenario: "Rancid food, dog got sick, FDA threat",
    customerSaid:
      "food smelled rancid, dog ate some and is sick, taking to vet, health hazard, considering FDA",
    trackingStatus: "delivered",
    productType: "Frozen",
    correctAction: "full_refund",
    correctResponse:
      "Dear Customer,\n\nI am sorry to hear this. Please do not use the remaining product and please dispose of it safely. We are issuing a full refund immediately. This matter is being escalated internally.\n\nBest regards,\n{store}",
    reasoning:
      "CRITICAL - illness + FDA threat. Short response. No arguing. No vet expense mention (liability). Immediate refund. Escalate.",
    whoShouldPay: "us",
    tags: "critical,illness,fda,rancid,escalate",
  },
  {
    problemType: "T5",
    scenario: "Damaged cooler",
    customerSaid: "cooler arrived with big crack on lid, unusable",
    trackingStatus: "delivered",
    productType: "Dry",
    correctAction: "replacement",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out, and I'm sorry to hear about the damage to your cooler.\n\nCould you please share a photo of the damage? This will help us document the issue. In the meantime, we can arrange a replacement or full refund — whichever you prefer.\n\nBest regards,\n{store}",
    reasoning: "Damaged non-food, request photo, offer choice",
    whoShouldPay: "us",
    tags: "damaged,dry,photo_request",
  },

  // ────────── Wrong / Missing / Expired (T6/T7/T8) ──────────
  {
    problemType: "T6",
    scenario: "Wrong frozen item received",
    customerSaid:
      "ordered Sausage Links but received Sausage Patties, wrong product",
    trackingStatus: "delivered",
    productType: "Frozen",
    correctAction: "replacement",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out, and I apologize for the mix-up.\n\nCould you please share a photo of the product you received? We can send you the correct product right away. Please do not worry about returning the incorrect item.\n\nBest regards,\n{store}",
    reasoning:
      "Wrong item frozen - photo always needed (even >3 days), don't ask return, replacement",
    whoShouldPay: "us",
    tags: "wrong_item,frozen,photo_always",
  },
  {
    problemType: "T7",
    scenario: "Missing item in multi-pack",
    customerSaid: "ordered 3-pack but only received 2 bags",
    trackingStatus: "delivered",
    productType: "Dry",
    correctAction: "send_missing",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out, and I apologize that your order arrived incomplete.\n\nCould you please share a photo of what you received? Once confirmed, we can ship the missing item at no additional cost.\n\nBest regards,\n{store}",
    reasoning: "Missing item, verify then send",
    whoShouldPay: "us",
    tags: "missing_item,verify",
  },
  {
    problemType: "T8",
    scenario: "Expired product received",
    customerSaid:
      "expiration date is April 5, received expired product, dangerous for pet",
    trackingStatus: "delivered",
    productType: "Frozen",
    correctAction: "full_refund",
    correctResponse:
      "Dear Customer,\n\nThank you for bringing this to our attention. Receiving an expired product is completely unacceptable.\n\nCould you please share a photo of the expiration date? We can issue a full refund. Please do not use or return the product for safety reasons.\n\nBest regards,\n{store}",
    reasoning: "Expired = our fault. Refund. Check SKU batch.",
    whoShouldPay: "us",
    tags: "expired,refund,sku_check",
  },

  // ────────── Shipping Cost / Cancellation (T9/T10) ──────────
  {
    // CORRECTED
    problemType: "T9",
    scenario: "Shipping cost complaint, tried to cancel",
    customerSaid:
      "shipping was $70 for $50 product, way too high, tried to cancel",
    trackingStatus: "in_transit",
    productType: "Dry",
    correctAction: "clarify",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out. The shipping charge is determined at checkout based on the item's size, weight, and destination.\n\nSince the order has already shipped, cancellation is no longer possible. If you still need help after delivery, please contact Amazon Customer Support through your order page.\n\nBest regards,\n{store}",
    reasoning:
      "Removed suggestion to request return for food item. Redirect to Amazon CS instead.",
    whoShouldPay: "none",
    tags: "shipping_cost,clarify",
  },
  {
    problemType: "T10",
    scenario: "Cancel before shipping",
    customerSaid: "changed my mind please cancel",
    trackingStatus: null,
    productType: "Dry",
    correctAction: "cancel_order",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out. Your order has been cancelled as requested. You should see the refund processed shortly.\n\nBest regards,\n{store}",
    reasoning: "Not shipped = cancel",
    whoShouldPay: "none",
    tags: "cancel,not_shipped",
  },
  {
    problemType: "T10",
    scenario: "Cancel after shipping, frozen",
    customerSaid: "please cancel this order, don't want it anymore",
    trackingStatus: "in_transit",
    productType: "Frozen",
    correctAction: "deny_cancel",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out. Unfortunately, your order has already been shipped and is in transit, so cancellation is no longer possible.\n\nSince this is a perishable food item, we are unable to accept returns. If you need further assistance after delivery, please contact Amazon Customer Support through your order page.\n\nBest regards,\n{store}",
    reasoning: "Shipped + frozen = can't cancel, can't return",
    whoShouldPay: "none",
    tags: "cancel,shipped,frozen",
  },

  // ────────── Shipping Mismatch T21 ──────────
  {
    // CORRECTED
    problemType: "T21",
    scenario: "Next Day paid, shipped Ground, customer wants cancel",
    customerSaid:
      "paid $62 for next day, says April 15 delivery, want to cancel",
    trackingStatus: "in_transit",
    shippingMismatch: true,
    productType: "Dry",
    correctAction: "deny_cancel_redirect",
    correctResponse:
      "Dear Customer,\n\nThank you for your message. I understand your concern regarding the delivery timing.\n\nSince the package is already in transit, we are unable to stop it. Once delivered, please contact us through your order page and we will make sure this is resolved appropriately.\n\nBest regards,\n{store}",
    reasoning:
      "Shipping mismatch. Never admit directly. Don't just say 'wait and return'. Promise resolution after delivery. Stronger than previous version.",
    whoShouldPay: "us",
    tags: "shipping_mismatch,next_day,ground,cancel",
  },
  {
    // CORRECTED
    problemType: "T21",
    scenario:
      "Two-Day paid, shipped Ground, delivered late, wants shipping refund",
    customerSaid:
      "paid for 2-day shipping and it took 4 days, need refund for shipping cost",
    trackingStatus: "delivered",
    shippingMismatch: true,
    productType: "Dry",
    correctAction: "redirect_amazon",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out, and I apologize for the delay. For the fastest resolution regarding the shipping service issue, please contact Amazon Customer Support through your order page.\n\nBest regards,\n{store}",
    reasoning:
      "Don't promise partial refund unless it's official SOP. Redirect to Amazon CS instead.",
    whoShouldPay: "us",
    tags: "shipping_mismatch,two_day,ground,redirect",
  },

  // ────────── Unauthorized / Disputes / Threats (T12/T13/T14) ──────────
  {
    problemType: "T12",
    scenario: "Unauthorized purchase",
    customerSaid: "did not place this order, someone used my account",
    trackingStatus: "delivered",
    productType: "Dry",
    correctAction: "redirect_amazon",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out. We do not have access to your account or payment authorization details.\n\nFor the fastest and most secure resolution, please contact Amazon Customer Support directly through your account.\n\nBest regards,\n{store}",
    reasoning: "Unauthorized = Amazon fraud case",
    whoShouldPay: "amazon",
    tags: "unauthorized,fraud,redirect",
  },
  {
    problemType: "T13",
    scenario: "A-to-Z threat with real problem (melted frozen)",
    customerSaid:
      "food arrived melted, give me refund RIGHT NOW or filing A-to-Z and 1-star review",
    trackingStatus: "delivered",
    productType: "Frozen",
    correctAction: "investigate",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out. I understand your frustration and I want to help resolve this.\n\nCould you please share more details about the condition of the product? This will help us determine the best resolution for you right away.\n\nBest regards,\n{store}",
    reasoning:
      "Don't comply with threats. Investigate the real problem first. If real issue confirmed, then resolve based on facts.",
    whoShouldPay: "amazon",
    tags: "threat,atoz,investigate,dont_comply",
  },
  {
    // CORRECTED
    problemType: "T15",
    scenario: "Health concern, dog sick from food",
    customerSaid:
      "dog got very sick after eating, vomiting all day, at the vet, going to report to FDA",
    trackingStatus: "delivered",
    productType: "Frozen",
    correctAction: "full_refund",
    correctResponse:
      "Dear Customer,\n\nI am sorry to hear about your dog's situation. Please do not use the remaining product and dispose of it safely. We are issuing a full refund immediately. This matter is being escalated internally.\n\nBest regards,\n{store}",
    reasoning:
      "CRITICAL. Removed vet expense mention (liability). Short, calm, refund, escalate.",
    whoShouldPay: "us",
    tags: "critical,illness,fda,escalate",
  },
  {
    problemType: "T14",
    scenario: "Review threat, subjective quality",
    customerSaid:
      "dog won't eat these, smell terrible, going to leave very bad review",
    trackingStatus: "delivered",
    productType: "Dry",
    correctAction: "investigate",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out. I'm sorry the treats didn't meet your expectations.\n\nCould you share more details about the issue? We want to understand the problem and find the best solution for you.\n\nBest regards,\n{store}",
    reasoning:
      "Don't comply with review threat. Don't offer refund for taste. Investigate.",
    whoShouldPay: "none",
    tags: "review_threat,taste,investigate",
  },

  // ────────── Postage Due / Quality (T16/T17) ──────────
  {
    problemType: "T16",
    scenario: "Carrier asking for extra payment",
    customerSaid: "UPS asking me to pay $15 extra, I already paid for shipping",
    trackingStatus: "exception",
    productType: "Frozen",
    correctAction: "replacement",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out. You should absolutely NOT pay any additional charges.\n\nI apologize for this inconvenience. We can send a replacement at no additional cost, or process a full refund. Please let us know which you prefer.\n\nBest regards,\n{store}",
    reasoning: "Carrier postage due = carrier issue. Don't ask customer to pay.",
    whoShouldPay: "carrier",
    tags: "postage_due,carrier",
  },
  {
    problemType: "T17",
    scenario: "Subjective taste complaint",
    customerSaid: "my dog doesn't like the taste, won't eat it",
    trackingStatus: "delivered",
    productType: "Dry",
    correctAction: "no_refund",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out. I understand that every pet has different taste preferences.\n\nUnfortunately, since this is a food product and there is no quality issue with the item, we are unable to process a refund. Food products are non-returnable per Amazon's policy.\n\nIf you have any other questions, please don't hesitate to ask.\n\nBest regards,\n{store}",
    reasoning:
      "Taste = subjective. No quality issue. Food non-returnable on Amazon. NO REFUND.",
    whoShouldPay: "buyer",
    tags: "taste,subjective,no_refund,non_returnable",
  },
  {
    problemType: "T17",
    scenario: "Real quality defect, discolored",
    customerSaid:
      "food looks discolored, weird texture, something wrong with this batch",
    trackingStatus: "delivered",
    productType: "Frozen",
    correctAction: "replacement",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out. Product quality is very important to us.\n\nCould you please share a photo of the product? We can send you a replacement right away. Please do not use or return the product.\n\nBest regards,\n{store}",
    reasoning: "Possible batch issue. Photo + replacement. Check SKU.",
    whoShouldPay: "us",
    tags: "quality_defect,photo,replacement",
  },

  // ────────── Pre-sale / Returns / Refund-already-issued (T18/T11/T19) ──────────
  {
    problemType: "T18",
    scenario: "Pre-sale allergen question",
    customerSaid:
      "does this food contain chicken, my dog has severe allergies",
    trackingStatus: null,
    productType: "Frozen",
    correctAction: "answer",
    correctResponse:
      "Dear Customer,\n\nThank you for your question! The specific ingredients vary by variety.\n\nWe recommend checking the full ingredient list on the product listing page before purchasing. If you'd like me to check a specific variety, please let me know.\n\nBest regards,\n{store}",
    reasoning: "Pre-sale. Don't guess ingredients. Redirect to listing/label.",
    whoShouldPay: "none",
    tags: "pre_sale,allergen,ingredients",
  },
  {
    problemType: "T11",
    scenario: "Return request for frozen food",
    customerSaid: "want to return this and get refund, how do I send it back",
    trackingStatus: "delivered",
    productType: "Frozen",
    correctAction: "refund_no_return",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out. Since this is a perishable food product, we are unable to accept returns for food safety reasons.\n\nWe can issue a full refund without requiring a return. You may keep, donate, or dispose of the product as you see fit.\n\nBest regards,\n{store}",
    reasoning: "Frozen = non-returnable. Refund without return.",
    whoShouldPay: "us",
    tags: "return,frozen,no_return,refund",
  },
  {
    problemType: "T11",
    scenario: "Return request for dry food",
    customerSaid: "want to return this, not what I expected",
    trackingStatus: "delivered",
    productType: "Dry",
    correctAction: "redirect_amazon_return",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out.\n\nYou can initiate a return directly through your Amazon account by going to Your Orders and selecting Return or Replace Items. Amazon will guide you through the process.\n\nBest regards,\n{store}",
    reasoning: "Standard dry return through Amazon process",
    whoShouldPay: "buyer",
    tags: "return,dry,amazon_process",
  },
  {
    problemType: "T19",
    scenario: "Refund already issued, customer asking when",
    customerSaid: "you said you'd refund me but I still don't see it",
    trackingStatus: "delivered",
    productType: "Frozen",
    correctAction: "confirm_timeline",
    correctResponse:
      "Dear Customer,\n\nThank you for following up. The refund for your order has been processed.\n\nPlease allow 3-5 business days for it to appear in your account. If you still don't see it after 5 business days, please contact us again.\n\nBest regards,\n{store}",
    reasoning: "Refund already done. Confirm timeline. Don't duplicate.",
    whoShouldPay: "none",
    tags: "refund_issued,timeline",
  },

  // ────────── Repeat complaints (T20) ──────────
  {
    // CORRECTED
    problemType: "T20",
    scenario: "2nd complaint, package 7 days in transit",
    customerSaid:
      "second time writing, been a WEEK, your last answer was useless, want refund NOW",
    trackingStatus: "in_transit",
    productType: "Frozen",
    correctAction: "refund_or_replacement",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out again, and I sincerely apologize that your order still hasn't arrived.\n\nYour package has been in transit for 7 days. We can offer you either a full refund or a replacement shipped right away. Please let me know which option you prefer, and we'll take care of it right away.\n\nBest regards,\n{store}",
    reasoning:
      "2nd complaint = escalate. Previous was 'wait'. Now must solve. Removed 'within the hour'.",
    whoShouldPay: "amazon",
    tags: "repeat,2nd_message,escalate",
  },
  {
    problemType: "T20",
    scenario: "3rd complaint CRITICAL, delivered but never received",
    customerSaid:
      "THIRD time contacting, still no order, nobody helping, want money back or filing claim",
    trackingStatus: "delivered",
    productType: "Dry",
    correctAction: "full_refund",
    correctResponse:
      "Dear Customer,\n\nI sincerely apologize for the ongoing frustration. You've been extremely patient.\n\nWe are issuing a full refund for your order. You should see it in your account within 3-5 business days.\n\nBest regards,\n{store}",
    reasoning: "3rd complaint = CRITICAL. Immediate refund. No more delays.",
    whoShouldPay: "amazon",
    tags: "repeat,3rd_message,critical,refund",
  },

  // ────────── Walmart (T2/T5/T10/T1) ──────────
  {
    // CORRECTED
    problemType: "T2",
    scenario: "Walmart delivered not received",
    customerSaid: "never got my package but it says delivered",
    trackingStatus: "delivered",
    productType: "Dry",
    channel: "Walmart",
    correctAction: "redirect_walmart_flow",
    correctResponse:
      "Hello,\n\nWe're sorry for the inconvenience. If the order is marked delivered but you have not received it, please go to your Walmart order and use the 'Start a return' or 'Report an issue' flow for the fastest resolution. Walmart Customer Care will guide you through the next steps.\n\nThank you for your understanding.",
    reasoning:
      "Walmart = through official flow. Don't promise resolution from seller side.",
    whoShouldPay: "amazon", // "walmart" not in whoShouldPay enum; use "amazon" as platform
    tags: "walmart,delivered,not_received,official_flow",
  },
  {
    // CORRECTED
    problemType: "T5",
    scenario: "Walmart damaged item",
    customerSaid: "item arrived broken, box was crushed",
    trackingStatus: "delivered",
    productType: "Dry",
    channel: "Walmart",
    correctAction: "redirect_walmart_flow",
    correctResponse:
      "Hello,\n\nWe're sorry your item arrived damaged. Please go to your Walmart order and use the return or issue flow to report the damage. Walmart will guide you through the next steps.\n\nThank you for your understanding.",
    reasoning:
      "Walmart damaged = through official Walmart flow. Don't promise refund/replacement from seller.",
    whoShouldPay: "amazon",
    tags: "walmart,damaged,official_flow",
  },
  {
    problemType: "T10",
    scenario: "Walmart cancel after shipping",
    customerSaid: "cancel my order please",
    trackingStatus: "in_transit",
    productType: "Dry",
    channel: "Walmart",
    correctAction: "deny_cancel",
    correctResponse:
      "Hello,\n\nWe're sorry for the inconvenience. Your order has already been shipped and is in transit, so cancellation is no longer possible.\n\nThe package is expected to arrive by {EDD}. Once received, you can request a return through your Walmart account if needed.\n\nThank you for your understanding.",
    reasoning: "Walmart shipped = can't cancel. Standard.",
    whoShouldPay: "none",
    tags: "walmart,cancel,shipped",
  },

  // ────────── Spanish + edge cases ──────────
  {
    problemType: "T18",
    scenario: "Pre-sale question in Spanish",
    customerSaid:
      "Este alimento contiene pollo? Mi perro es alergico al pollo",
    trackingStatus: null,
    productType: "Frozen",
    correctAction: "answer",
    correctResponse:
      "Estimado/a Cliente,\n\nGracias por su consulta. Los ingredientes específicos varían según la variedad.\n\nLe recomendamos revisar la lista completa de ingredientes en la página del producto antes de realizar su compra.\n\nSaludos cordiales,\n{store}",
    reasoning: "Spanish detected. Pre-sale. Don't guess allergens.",
    whoShouldPay: "none",
    tags: "spanish,pre_sale,allergen",
  },
  {
    problemType: "T3",
    scenario: "Weekend delay for frozen, shipped Friday delivered Wednesday",
    customerSaid:
      "food arrived Wednesday but supposed to come Monday, sat in warehouse all weekend, completely thawed",
    trackingStatus: "delivered",
    productType: "Frozen",
    correctAction: "replacement",
    correctResponse:
      "Dear Customer,\n\nI sincerely apologize for this experience. Your package was shipped on Friday and unfortunately experienced a delay over the weekend, arriving on Wednesday instead of Monday.\n\nWe can send you a replacement at no additional cost. Please do not return the product for food safety reasons.\n\nBest regards,\n{store}",
    reasoning:
      "Weekend delay common for frozen. Buy Shipping + carrier delay = Amazon reimbursement.",
    whoShouldPay: "amazon",
    tags: "frozen,weekend_delay,replacement",
  },
  {
    // CORRECTED
    problemType: "T4",
    scenario: "Spoiled food + A-to-Z already filed",
    customerSaid:
      "already filed A-to-Z claim, food arrived melted, want money back",
    trackingStatus: "delivered",
    productType: "Frozen",
    correctAction: "acknowledge_review",
    correctResponse:
      "Dear Customer,\n\nI'm sorry about the condition of your order. I understand you have already filed a claim. Amazon will review it, and we are also reviewing the order from our side.\n\nPlease do not use or return the product.\n\nBest regards,\n{store}",
    reasoning:
      "A-to-Z already filed. Don't promise separate seller refund (risk of double refund). Acknowledge + let Amazon process handle it.",
    whoShouldPay: "amazon",
    tags: "atoz_filed,frozen,no_double_refund",
  },
  {
    problemType: "T1",
    scenario: "Walmart simple tracking question",
    customerSaid: "when will my order arrive",
    trackingStatus: "in_transit",
    productType: "Dry",
    channel: "Walmart",
    correctAction: "reassure",
    correctResponse:
      "Hello,\n\nYour order is currently in transit with FedEx and is expected to arrive by {EDD}.\n\nThank you for your patience.",
    reasoning: "Simple tracking question Walmart. Short.",
    whoShouldPay: "none",
    tags: "walmart,tracking,simple",
  },
  {
    problemType: "T6",
    scenario: "Repeated wrong item, 2nd time",
    customerSaid:
      "SECOND time received wrong product, ordered Chicken got Beef again, ridiculous",
    trackingStatus: "delivered",
    productType: "Frozen",
    correctAction: "full_refund",
    correctResponse:
      "Dear Customer,\n\nI sincerely apologize that this has happened again. Receiving the wrong item twice is completely unacceptable.\n\nWe are issuing a full refund for your order. Please do not return the product. This issue is being escalated to ensure our fulfillment process is corrected.\n\nBest regards,\n{store}",
    reasoning:
      "2nd wrong item = refund safer than another wrong replacement. Escalate SKU/fulfillment.",
    whoShouldPay: "us",
    tags: "wrong_item,repeat,refund,escalate",
  },
  {
    problemType: "T9",
    scenario: "Shipping cost complaint, not yet shipped, wants cancel",
    customerSaid:
      "shipping cost more than product, outrageous, cancel immediately",
    trackingStatus: null,
    productType: "Dry",
    correctAction: "cancel_order",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out. We have cancelled your order as requested, and you should see the refund processed shortly.\n\nWe appreciate your feedback regarding the shipping pricing.\n\nBest regards,\n{store}",
    reasoning: "Not shipped = cancel. Simple.",
    whoShouldPay: "none",
    tags: "shipping_cost,cancel,not_shipped",
  },
  {
    problemType: "T3",
    scenario: "USPS undeliverable, returned to sender",
    customerSaid:
      "USPS says undeliverable and returning to sender, I need this order",
    trackingStatus: "exception",
    productType: "Dry",
    correctAction: "replacement",
    correctResponse:
      "Dear Customer,\n\nThank you for reaching out. I apologize for this situation. The carrier has marked the package as undeliverable.\n\nWe can arrange a replacement to be shipped right away. Could you please confirm your complete shipping address?\n\nBest regards,\n{store}",
    reasoning: "Returned to sender. Replacement with confirmed address.",
    whoShouldPay: "us",
    tags: "returned_to_sender,replacement,address_confirm",
  },
];

export interface SeedResult {
  inserted: number;
  skipped: number;
  total: number;
  message: string;
}

/**
 * Insert all 40 reference entries into the knowledge base.
 *
 * Idempotent by default — returns early if the table already has rows.
 * Pass `force: true` to wipe the table first (used by the seed API route
 * when the seed file is edited and needs to be re-applied).
 */
export async function seedKnowledgeBase(
  options: { force?: boolean } = {}
): Promise<SeedResult> {
  const existingCount = await prisma.knowledgeBaseEntry.count();

  if (existingCount > 0 && !options.force) {
    return {
      inserted: 0,
      skipped: KB_ENTRIES.length,
      total: existingCount,
      message: `Knowledge base already has ${existingCount} entries. Pass { force: true } to wipe and re-seed.`,
    };
  }

  if (options.force && existingCount > 0) {
    await prisma.knowledgeBaseEntry.deleteMany({});
    console.log(
      `[KnowledgeBase] Force re-seed: deleted ${existingCount} existing entries`
    );
  }

  // createMany isn't supported on SQLite + some prisma versions with
  // adapters, so insert sequentially. 40 rows is fast regardless.
  let inserted = 0;
  for (const entry of KB_ENTRIES) {
    await prisma.knowledgeBaseEntry.create({
      data: {
        problemType: entry.problemType,
        scenario: entry.scenario,
        customerSaid: entry.customerSaid,
        trackingStatus: entry.trackingStatus || null,
        shippingMismatch: entry.shippingMismatch ?? false,
        productType: entry.productType || null,
        correctAction: entry.correctAction,
        correctResponse: entry.correctResponse,
        reasoning: entry.reasoning,
        whoShouldPay: entry.whoShouldPay || null,
        outcome: entry.outcome || null,
        tags: entry.tags || null,
        source: entry.source || "manual",
        channel: entry.channel || "Amazon",
      },
    });
    inserted++;
  }

  const total = await prisma.knowledgeBaseEntry.count();
  console.log(
    `[KnowledgeBase] Seeded ${inserted} entries (total now: ${total})`
  );

  return {
    inserted,
    skipped: 0,
    total,
    message: `Seeded ${inserted} knowledge base entries.`,
  };
}
