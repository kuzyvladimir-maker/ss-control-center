/**
 * Amazon SP-API Reports API
 * Used for: Account Health metrics (async report generation + download)
 */

import { getCachedAccessToken } from "./auth";

const SP_ENDPOINT =
  process.env.AMAZON_SP_ENDPOINT ||
  "https://sellingpartnerapi-na.amazon.com";
const MARKETPLACE_ID =
  process.env.AMAZON_SP_MARKETPLACE_ID || "ATVPDKIKX0DER";

/** Create a report request */
export async function createReport(
  storeId: string,
  reportType: string,
  daysBack = 30
): Promise<string> {
  const accessToken = await getCachedAccessToken(storeId);

  const dataEndTime = new Date().toISOString();
  const dataStartTime = new Date(
    Date.now() - daysBack * 24 * 60 * 60 * 1000
  ).toISOString();

  const res = await fetch(`${SP_ENDPOINT}/reports/2021-06-30/reports`, {
    method: "POST",
    headers: {
      "x-amz-access-token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      reportType,
      marketplaceIds: [MARKETPLACE_ID],
      dataStartTime,
      dataEndTime,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Create report failed ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.reportId;
}

/** Check report processing status */
export async function getReportStatus(
  storeId: string,
  reportId: string
): Promise<{ status: string; documentId?: string }> {
  const accessToken = await getCachedAccessToken(storeId);

  const res = await fetch(
    `${SP_ENDPOINT}/reports/2021-06-30/reports/${reportId}`,
    {
      headers: {
        "x-amz-access-token": accessToken,
        "Content-Type": "application/json",
      },
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Get report status failed ${res.status}: ${err}`);
  }

  const data = await res.json();
  return {
    status: data.processingStatus, // IN_QUEUE | IN_PROGRESS | DONE | FATAL | CANCELLED
    documentId: data.reportDocumentId,
  };
}

/** Get report document download URL */
export async function getReportDocumentUrl(
  storeId: string,
  documentId: string
): Promise<string> {
  const accessToken = await getCachedAccessToken(storeId);

  const res = await fetch(
    `${SP_ENDPOINT}/reports/2021-06-30/documents/${documentId}`,
    {
      headers: {
        "x-amz-access-token": accessToken,
        "Content-Type": "application/json",
      },
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Get report document failed ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.url;
}

/** Download report content */
export async function downloadReport(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return res.text();
}

/** Full flow: create → poll → download. Returns CSV text. */
export async function requestAndWaitForReport(
  storeId: string,
  reportType: string,
  daysBack = 30,
  maxWaitMs = 5 * 60 * 1000
): Promise<string> {
  const reportId = await createReport(storeId, reportType, daysBack);
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, 15000));

    const { status, documentId } = await getReportStatus(storeId, reportId);

    if (status === "DONE" && documentId) {
      const url = await getReportDocumentUrl(storeId, documentId);
      return downloadReport(url);
    }

    if (status === "FATAL" || status === "CANCELLED") {
      throw new Error(`Report ${reportId} failed: ${status}`);
    }
  }

  throw new Error(`Report ${reportId} timed out after ${maxWaitMs / 1000}s`);
}
