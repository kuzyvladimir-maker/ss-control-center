// Placeholder: send a buyer response via SP-API Messaging.
// Wire this up to src/lib/amazon-sp-api/messaging.ts when SP-API Messaging
// credentials are ready. Until then the function is intentionally a no-op
// so the UI can surface a clear "Not implemented" error.
/* eslint-disable @typescript-eslint/no-unused-vars */
export async function sendResponse(
  amazonOrderId: string,
  storeIndex: number,
  text: string
) {
  return { sent: false, error: "Not implemented" };
}
