/**
 * Amazon Messaging API
 * Role required: Buyer Communication
 * Used for: Customer Service responses
 */

import { spApiPost, spApiGet, MARKETPLACE_ID } from "./client";

/** Get available message types for an order */
export async function getMessagingActionsForOrder(
  amazonOrderId: string,
  storeId = "store1"
) {
  const response = await spApiGet(
    `/messaging/v1/orders/${amazonOrderId}`,
    { storeId, params: { marketplaceIds: MARKETPLACE_ID } }
  );
  return response._links?.actions || [];
}

/** Send a message to a buyer */
export async function sendBuyerMessage(
  amazonOrderId: string,
  messageType:
    | "createUnexpectedProblem"
    | "createNegativeFeedbackRemoval"
    | "createConfirmDeliveryDetails",
  body: { text: string },
  storeId = "store1"
) {
  return spApiPost(
    `/messaging/v1/orders/${amazonOrderId}/messages/${messageType}`,
    { body },
    { storeId, params: { marketplaceIds: MARKETPLACE_ID } }
  );
}
