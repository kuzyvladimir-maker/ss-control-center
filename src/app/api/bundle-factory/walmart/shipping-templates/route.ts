import { NextResponse } from "next/server";

import {
  parseWalmartShippingTemplateDetails,
  parseWalmartShippingTemplateList,
} from "@/lib/bundle-factory/walmart-shipping-templates";
import {
  getWalmartClient,
  getWalmartStoreStatus,
} from "@/lib/walmart";

export const dynamic = "force-dynamic";

function parseStoreIndex(params: URLSearchParams): number | null {
  const raw = params.get("storeIndex");
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= 5
    ? value
    : null;
}

function errorResponse(error: unknown): Response {
  const detail =
    error instanceof Error ? error.message : "Unknown Walmart API error";
  return NextResponse.json(
    {
      error: "Could not read Walmart shipping templates",
      detail,
    },
    {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const storeIndex = parseStoreIndex(params);
  if (storeIndex == null) {
    return NextResponse.json(
      { error: "storeIndex must be an integer from 1 to 5" },
      { status: 400 },
    );
  }
  const account = getWalmartStoreStatus(storeIndex);
  if (!account.configured) {
    return NextResponse.json(
      { error: `Walmart account ${storeIndex} is not configured` },
      { status: 404 },
    );
  }
  const templateId = params.get("templateId")?.trim() || null;
  if (
    templateId != null &&
    !/^[A-Za-z0-9_-]{1,128}$/.test(templateId)
  ) {
    return NextResponse.json(
      { error: "templateId contains unsupported characters" },
      { status: 400 },
    );
  }

  try {
    const client = getWalmartClient(storeIndex);
    const listResponse = await client.requestRaw(
      "GET",
      "/settings/shipping/templates",
      { noRetryOn429: true },
    );
    if (!listResponse.ok || listResponse.status !== 200) {
      return NextResponse.json(
        {
          error: "Walmart rejected the shipping-template list request",
          status: listResponse.status,
          correlation_id: listResponse.correlationId,
        },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
    const templates = parseWalmartShippingTemplateList(listResponse.body);
    if (templateId == null) {
      return NextResponse.json(
        {
          account: {
            store_index: storeIndex,
            name: account.storeName,
          },
          templates,
          fetched_at: new Date().toISOString(),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const selected = templates.find((template) => template.id === templateId);
    if (!selected) {
      return NextResponse.json(
        {
          error:
            `Shipping template ${templateId} does not belong to ` +
            `Walmart account ${storeIndex}`,
        },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    const detailResponse = await client.requestRaw(
      "GET",
      `/settings/shipping/templates/${templateId}`,
      { noRetryOn429: true },
    );
    if (!detailResponse.ok || detailResponse.status !== 200) {
      return NextResponse.json(
        {
          error: "Walmart rejected the shipping-template detail request",
          status: detailResponse.status,
          correlation_id: detailResponse.correlationId,
        },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
    const template = parseWalmartShippingTemplateDetails(
      detailResponse.body,
    );
    if (
      template.id !== selected.id ||
      template.name !== selected.name ||
      template.status !== selected.status ||
      template.rate_model_type !== selected.rate_model_type
    ) {
      return NextResponse.json(
        {
          error:
            "Walmart shipping-template list and detail responses disagree",
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      {
        account: {
          store_index: storeIndex,
          name: account.storeName,
        },
        template,
        fetched_at: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
