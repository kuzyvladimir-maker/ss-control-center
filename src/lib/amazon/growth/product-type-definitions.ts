/**
 * Amazon Product Type Definitions — attribute schema lookup.
 *
 * The set-attribute executor needs to write a SCHEMA-VALID value (e.g. unit_count
 * = { value: 4, type: { value: "Count" } } — not "Pound"; item_weight =
 * { value: 1, unit: "pounds" } — not "1 pound"). The Definitions API gives the
 * exact required sub-fields and their allowed enum values per productType, so we
 * build a valid PATCH and offer the operator the legal options.
 *
 * GET /definitions/2020-09-01/productTypes/{pt} → schema.link.resource (URL) →
 * fetch that JSON schema → properties[attr].items.{required, properties}.
 */

import { spApiGet, MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";

export interface EnumField {
  name: string; // sub-field name, e.g. "type" or "unit"
  nested: boolean; // true = value lives at {name:{value:<enum>}}, false = {name:<enum>}
  allowed: string[];
}
export interface AttributeForm {
  attribute: string;
  productType: string;
  valueField: string | null; // usually "value"
  valueType: "number" | "string" | null;
  enumFields: EnumField[];
  required: string[];
}

// Per-process cache of the full product-type schema JSON.
const schemaCache = new Map<string, Record<string, unknown>>();

async function fetchSchema(storeIndex: number, productType: string): Promise<Record<string, unknown> | null> {
  const cached = schemaCache.get(productType);
  if (cached) return cached;
  const def = (await spApiGet(`/definitions/2020-09-01/productTypes/${encodeURIComponent(productType)}`, {
    storeId: `store${storeIndex}`,
    params: { marketplaceIds: MARKETPLACE_ID, requirements: "LISTING", locale: "en_US" },
  })) as { schema?: { link?: { resource?: string } } };
  const url = def?.schema?.link?.resource;
  if (!url) return null;
  const schema = (await (await fetch(url)).json()) as Record<string, unknown>;
  schemaCache.set(productType, schema);
  return schema;
}

/** Resolve the editable form for one attribute: its value field + enum sub-fields. */
export async function getAttributeForm(
  storeIndex: number,
  productType: string,
  attribute: string,
): Promise<AttributeForm | null> {
  const schema = await fetchSchema(storeIndex, productType);
  if (!schema) return null;
  const props = (schema.properties ?? {}) as Record<string, { items?: { required?: string[]; properties?: Record<string, unknown> } }>;
  const prop = props[attribute];
  const ip = prop?.items?.properties;
  if (!ip) return null;

  let valueField: string | null = null;
  let valueType: "number" | "string" | null = null;
  const enumFields: EnumField[] = [];
  for (const [k, raw] of Object.entries(ip)) {
    if (k === "marketplace_id") continue;
    const v = raw as { type?: string; enum?: string[]; properties?: { value?: { enum?: string[] } } };
    if (k === "value") {
      valueField = "value";
      valueType = v.type === "number" || v.type === "integer" ? "number" : "string";
      continue;
    }
    if (Array.isArray(v.enum)) enumFields.push({ name: k, nested: false, allowed: v.enum });
    else if (Array.isArray(v.properties?.value?.enum)) enumFields.push({ name: k, nested: true, allowed: v.properties!.value!.enum! });
  }
  return { attribute, productType, valueField, valueType, enumFields, required: prop?.items?.required ?? [] };
}

/** Build a schema-valid attribute entry from the form + chosen value/sub-values. */
export function buildAttributeEntry(
  form: AttributeForm,
  value: string,
  subValues: Record<string, string>,
): Record<string, unknown> {
  const entry: Record<string, unknown> = { marketplace_id: MARKETPLACE_ID };
  if (form.valueField) {
    const t = value.trim();
    entry[form.valueField] = form.valueType === "number" && /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t;
  }
  for (const ef of form.enumFields) {
    const chosen = subValues[ef.name];
    if (!chosen) continue;
    // Nested enum objects (e.g. unit_count.type) require a localized value:
    // { value: "Count", language_tag: "en_US" }.
    entry[ef.name] = ef.nested ? { value: chosen, language_tag: "en_US" } : chosen;
  }
  return entry;
}
