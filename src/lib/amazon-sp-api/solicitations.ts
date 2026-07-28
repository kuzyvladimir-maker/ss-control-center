/**
 * Amazon Solicitations API
 * Role required: Buyer Solicitation
 * Used for: Feedback Manager — request review from buyer
 */

import { spApiPost, MARKETPLACE_ID } from "./client";

/** Request product review and seller feedback from buyer */
export async function requestFeedback(
  amazonOrderId: string,
  storeId = "store1"
) {
  return spApiPost(
    `/solicitations/v1/orders/${amazonOrderId}/solicitations/productReviewAndSellerFeedback`,
    {},
    { storeId, params: { marketplaceIds: MARKETPLACE_ID } }
  );
}
