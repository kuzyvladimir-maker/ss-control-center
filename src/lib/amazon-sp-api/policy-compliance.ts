/**
 * Amazon Policy Compliance fetcher.
 *
 * Like AHR, the structured Policy Compliance feed lives behind the
 * "Selling Partner Insights" SP-API role and/or the Reports API
 * (GET_V2_SELLER_PERFORMANCE_REPORT). Until either is wired, this returns
 * the fixed list of 10 categories with zero counts so the UI still renders
 * the table — and the alerts engine never fires false positives.
 *
 * When the real endpoint is available, fill in fetchPolicyComplianceLive()
 * and flip USE_LIVE.
 */

import { spApiGet } from "./client";

export type PolicyCategoryCode =
  | "SUSPECTED_IP"
  | "RECEIVED_IP_COMPLAINTS"
  | "PRODUCT_AUTHENTICITY"
  | "PRODUCT_CONDITION"
  | "FOOD_SAFETY"
  | "LISTING_POLICY"
  | "RESTRICTED_PRODUCT"
  | "CUSTOMER_REVIEWS_POLICY"
  | "OTHER_POLICY"
  | "REGULATORY_COMPLIANCE";

export interface PolicyIssue {
  asin?: string;
  sku?: string;
  listingTitle?: string;
  violationType: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  message: string;
  reportedAt: string;
  amazonReferenceId?: string;
}

export interface PolicyCategoryResult {
  category: PolicyCategoryCode;
  displayName: string;
  count: number;
  status: "OK" | "WARNING" | "CRITICAL";
  details: PolicyIssue[];
}

// Display ordering matches the standard Amazon Account Health UI.
export const POLICY_CATEGORIES: { code: PolicyCategoryCode; displayName: string }[] = [
  { code: "SUSPECTED_IP",            displayName: "Suspected Intellectual Property Violations" },
  { code: "RECEIVED_IP_COMPLAINTS",  displayName: "Received Intellectual Property Complaints" },
  { code: "PRODUCT_AUTHENTICITY",    displayName: "Product Authenticity Customer Complaints" },
  { code: "PRODUCT_CONDITION",       displayName: "Product Condition Customer Complaints" },
  { code: "FOOD_SAFETY",             displayName: "Food and Product Safety Issues" },
  { code: "LISTING_POLICY",          displayName: "Listing Policy Violations" },
  { code: "RESTRICTED_PRODUCT",      displayName: "Restricted Product Policy Violations" },
  { code: "CUSTOMER_REVIEWS_POLICY", displayName: "Customer Product Reviews Policies" },
  { code: "OTHER_POLICY",            displayName: "Other Policy Violations" },
  { code: "REGULATORY_COMPLIANCE",   displayName: "Regulatory Compliance" },
];

const USE_LIVE = false;

/**
 * Returns the 10 fixed categories. When live data is available the counts
 * + details come from Amazon; otherwise everything is zero and the UI
 * shows an "OK / 0" row per category.
 */
export async function fetchPolicyCompliance(
  storeIndex: number
): Promise<PolicyCategoryResult[]> {
  const empty: PolicyCategoryResult[] = POLICY_CATEGORIES.map((c) => ({
    category: c.code,
    displayName: c.displayName,
    count: 0,
    status: "OK",
    details: [],
  }));

  if (!USE_LIVE) return empty;

  try {
    return await fetchPolicyComplianceLive(storeIndex);
  } catch (err) {
    console.warn(
      `[PolicyCompliance] store${storeIndex}: live fetch failed, returning empty`,
      err
    );
    return empty;
  }
}

/**
 * Real-data path. Calls Amazon's Account Issues endpoint and groups results
 * into the 10 fixed categories. Currently unused (USE_LIVE=false) because
 * the endpoint shape isn't confirmed for our role yet — left wired so a
 * follow-up PR can flip the flag once we have a known-good response.
 */
async function fetchPolicyComplianceLive(
  storeIndex: number
): Promise<PolicyCategoryResult[]> {
  const storeId = `store${storeIndex}`;
  // Endpoint to confirm:
  //   GET /sellingpartnerinsights/2024-09-10/policyCompliance
  // or  GET /accountIssues/v1/issues
  const data = await spApiGet(
    "/sellingpartnerinsights/2024-09-10/policyCompliance",
    { storeId }
  );
  type RawIssue = {
    category?: string;
    asin?: string;
    sku?: string;
    title?: string;
    violationType?: string;
    severity?: string;
    message?: string;
    reportedAt?: string;
    amazonReferenceId?: string;
  };
  const rawIssues: RawIssue[] = Array.isArray(data?.issues)
    ? data.issues
    : Array.isArray(data?.payload?.issues)
      ? data.payload.issues
      : [];

  const byCategory = new Map<PolicyCategoryCode, PolicyIssue[]>();
  for (const issue of rawIssues) {
    const code = (issue.category || "OTHER_POLICY").toUpperCase() as PolicyCategoryCode;
    const arr = byCategory.get(code) ?? [];
    arr.push({
      asin: issue.asin,
      sku: issue.sku,
      listingTitle: issue.title,
      violationType: issue.violationType ?? "UNKNOWN",
      severity:
        (issue.severity?.toUpperCase() as PolicyIssue["severity"]) ?? "MEDIUM",
      message: issue.message ?? "",
      reportedAt: issue.reportedAt ?? new Date().toISOString(),
      amazonReferenceId: issue.amazonReferenceId,
    });
    byCategory.set(code, arr);
  }

  return POLICY_CATEGORIES.map((c) => {
    const issues = byCategory.get(c.code) ?? [];
    return {
      category: c.code,
      displayName: c.displayName,
      count: issues.length,
      status:
        issues.some((i) => i.severity === "CRITICAL")
          ? "CRITICAL"
          : issues.length > 0
            ? "WARNING"
            : "OK",
      details: issues,
    };
  });
}
