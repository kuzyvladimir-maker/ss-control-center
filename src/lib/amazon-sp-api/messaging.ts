/**
 * Amazon Messaging API
 * Role required: Buyer Communication
 * Used for: Customer Service responses
 *
 * IMPORTANT — Amazon quirks learned the hard way (2026-04-11 debug):
 *
 * 1. Action names in the URL do NOT have a `create` prefix.
 *    Wrong: POST /messaging/v1/orders/{id}/messages/createUnexpectedProblem
 *    Right: POST /messaging/v1/orders/{id}/messages/unexpectedProblem
 *    Our docs source used the OpenAPI *operation name* (createUnexpectedProblem),
 *    but the URL path uses the action *name* — those two are different.
 *
 * 2. The body field is `rawMessageBody`, NOT `text`.
 *    Wrong: { text: "..." }
 *    Right: { rawMessageBody: "..." }
 *
 * 3. Amazon gates which message types are available per-order. Before
 *    sending anything, ALWAYS call getMessagingActionsForOrder first and
 *    check that the desired action is in the returned list. If it isn't,
 *    the API will return 403 Unauthorized no matter how valid the request
 *    looks otherwise. See response-sender.ts for the preflight check.
 */

import { spApiPost, spApiGet, MARKETPLACE_ID } from "./client";

export type MessagingAction =
  | "unexpectedProblem"
  | "confirmDeliveryDetails"
  | "confirmOrderDetails"
  | "confirmServiceDetails"
  | "confirmCustomizationDetails"
  | "legalDisclosure"
  | "warranty"
  | "digitalAccessKey"
  | "sendInvoice"
  | "updateFeedback";

export interface MessagingActionEntry {
  name: string;
  href: string;
}

/**
 * Fetch the list of message actions Amazon currently allows for an
 * order. Returns an array of { name, href } entries. Empty array means
 * no messaging actions are permitted (order is too old, buyer opted
 * out, etc.) — in that case the operator must reply via Seller Central.
 */
export async function getMessagingActionsForOrder(
  amazonOrderId: string,
  storeId = "store1"
): Promise<MessagingActionEntry[]> {
  const response = await spApiGet(
    `/messaging/v1/orders/${amazonOrderId}`,
    { storeId, params: { marketplaceIds: MARKETPLACE_ID } }
  );
  const actions = response?._links?.actions || [];
  return Array.isArray(actions)
    ? actions.map((a: { name: string; href: string }) => ({
        name: a.name,
        href: a.href,
      }))
    : [];
}

/**
 * Send a message to a buyer using one of the allowed action types.
 * Caller MUST verify the action is allowed via getMessagingActionsForOrder
 * before calling this — Amazon returns 403 Unauthorized for disallowed
 * actions.
 */
export async function sendBuyerMessage(
  amazonOrderId: string,
  messageAction: MessagingAction,
  body: { rawMessageBody: string },
  storeId = "store1"
) {
  return spApiPost(
    `/messaging/v1/orders/${amazonOrderId}/messages/${messageAction}`,
    { body },
    { storeId, params: { marketplaceIds: MARKETPLACE_ID } }
  );
}
