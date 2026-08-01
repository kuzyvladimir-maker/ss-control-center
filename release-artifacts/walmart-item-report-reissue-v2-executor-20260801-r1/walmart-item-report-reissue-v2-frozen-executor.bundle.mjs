#!/usr/bin/env node

// src/lib/walmart/catalog-visual-truth-preflight.ts
import { createHash } from "node:crypto";
var WALMART_TRUTH_PREFLIGHT_INPUT_SCHEMA = "walmart-visual-truth-preflight-input/v1";
var WALMART_TRUTH_PREFLIGHT_RESULT_SCHEMA = "walmart-visual-truth-preflight-result/v1";
var WALMART_TRUTH_PREFLIGHT_COVERAGE_SCHEMA = "walmart-visual-truth-preflight-coverage/v1";
var SIZE_UNITS = /* @__PURE__ */ new Set([
  "oz",
  "fl_oz",
  "count",
  "lb",
  "g",
  "kg",
  "ml",
  "l"
]);
var SOURCE_KINDS = /* @__PURE__ */ new Set([
  "seller_catalog",
  "buyer_pdp",
  "recipe_record",
  "sku_reference_catalog",
  "manufacturer_page",
  "retailer_page",
  "manual_verification",
  "donor_image"
]);
var EVIDENCE_SCOPES = /* @__PURE__ */ new Set([
  "current_title",
  "outer_units",
  "identity",
  "package_facts",
  "component_truth"
]);
var WALMART_TRUTH_SOURCE_AUTHORITY = {
  seller_catalog: ["current_title"],
  buyer_pdp: ["current_title"],
  recipe_record: ["outer_units", "identity", "package_facts", "component_truth"],
  sku_reference_catalog: ["outer_units", "identity", "package_facts", "component_truth"],
  manufacturer_page: ["identity", "package_facts", "component_truth"],
  retailer_page: ["identity", "package_facts", "component_truth"],
  manual_verification: ["current_title", "outer_units", "identity", "package_facts", "component_truth"],
  donor_image: []
};
function sourceKindCanEstablish(sourceKind, scope) {
  const allowed = WALMART_TRUTH_SOURCE_AUTHORITY[sourceKind];
  return allowed.includes(scope);
}
var IDENTITY_ROLES = /* @__PURE__ */ new Set(["brand", "product", "variant"]);
var PACKAGE_KINDS = /* @__PURE__ */ new Set(["net_content", "inner_item_count"]);
var PACKAGE_REQUIREMENTS = /* @__PURE__ */ new Set(["required", "if_visible"]);
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function assertExactKeys(value, required, path7) {
  const allowed = new Set(required);
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (extras.length) throw new Error(`${path7} has unsupported fields: ${extras.join(", ")}`);
  if (missing.length) throw new Error(`${path7} is missing required fields: ${missing.join(", ")}`);
}
function requiredString(value, path7) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path7} must be a non-empty string`);
  }
  return value.trim();
}
function stringArray(value, path7, max = 100) {
  if (!Array.isArray(value) || value.length > max) {
    throw new Error(`${path7} must be an array with at most ${max} items`);
  }
  const parsed = value.map((item, index) => requiredString(item, `${path7}[${index}]`));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${path7} contains duplicates`);
  return parsed;
}
function nullablePositiveInteger(value, path7) {
  if (value === null) return null;
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${path7} must be a positive integer or null`);
  }
  return Number(value);
}
function positiveInteger(value, path7) {
  const parsed = nullablePositiveInteger(value, path7);
  if (parsed === null) throw new Error(`${path7} must be a positive integer`);
  return parsed;
}
function parseMarkerGroups(value, path7) {
  if (!Array.isArray(value) || value.length > 12) {
    throw new Error(`${path7} must be an array with at most 12 groups`);
  }
  return value.map((group, groupIndex) => {
    if (!Array.isArray(group) || group.length === 0 || group.length > 12) {
      throw new Error(`${path7}[${groupIndex}] must contain 1-12 aliases`);
    }
    return stringArray(group, `${path7}[${groupIndex}]`, 12);
  });
}
function parseIdentity(value, path7) {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error(`${path7} must be an object or null`);
  assertExactKeys(value, [
    "brand_aliases",
    "product_marker_groups",
    "variant_marker_groups",
    "forbidden_markers"
  ], path7);
  const brandAliases = stringArray(value.brand_aliases, `${path7}.brand_aliases`, 12);
  const productGroups = parseMarkerGroups(value.product_marker_groups, `${path7}.product_marker_groups`);
  const variantGroups = parseMarkerGroups(value.variant_marker_groups, `${path7}.variant_marker_groups`);
  if (!Array.isArray(value.forbidden_markers) || value.forbidden_markers.length > 24) {
    throw new Error(`${path7}.forbidden_markers must be an array with at most 24 items`);
  }
  const forbidden = value.forbidden_markers.map((raw, index) => {
    const markerPath = `${path7}.forbidden_markers[${index}]`;
    if (!isRecord(raw)) throw new Error(`${markerPath} must be an object`);
    assertExactKeys(raw, ["role", "aliases"], markerPath);
    if (typeof raw.role !== "string" || !IDENTITY_ROLES.has(raw.role)) {
      throw new Error(`${markerPath}.role is unsupported`);
    }
    const aliases = stringArray(raw.aliases, `${markerPath}.aliases`, 12);
    if (aliases.length === 0) throw new Error(`${markerPath}.aliases must not be empty`);
    return { role: raw.role, aliases };
  });
  return {
    brand_aliases: brandAliases,
    product_marker_groups: productGroups,
    variant_marker_groups: variantGroups,
    forbidden_markers: forbidden
  };
}
function parsePackageFacts(value, path7) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 4) {
    throw new Error(`${path7} must be an array with at most 4 facts, or null`);
  }
  return value.map((raw, index) => {
    const factPath = `${path7}[${index}]`;
    if (!isRecord(raw)) throw new Error(`${factPath} must be an object`);
    assertExactKeys(raw, ["kind", "value", "unit", "requirement"], factPath);
    if (typeof raw.kind !== "string" || !PACKAGE_KINDS.has(raw.kind)) {
      throw new Error(`${factPath}.kind is unsupported`);
    }
    if (typeof raw.value !== "number" || !Number.isFinite(raw.value) || raw.value <= 0) {
      throw new Error(`${factPath}.value must be a positive number`);
    }
    if (typeof raw.unit !== "string" || !SIZE_UNITS.has(raw.unit)) {
      throw new Error(`${factPath}.unit is unsupported`);
    }
    if (typeof raw.requirement !== "string" || !PACKAGE_REQUIREMENTS.has(raw.requirement)) {
      throw new Error(`${factPath}.requirement is unsupported`);
    }
    return {
      kind: raw.kind,
      value: raw.value,
      unit: raw.unit,
      requirement: raw.requirement
    };
  });
}
function parseRecipeComponent(value, path7) {
  if (!isRecord(value)) throw new Error(`${path7} must be an object`);
  assertExactKeys(value, [
    "component_id",
    "quantity",
    "identity",
    "package_facts",
    "source_ref_ids"
  ], path7);
  return {
    component_id: requiredString(value.component_id, `${path7}.component_id`),
    quantity: positiveInteger(value.quantity, `${path7}.quantity`),
    identity: parseIdentity(value.identity, `${path7}.identity`),
    package_facts: parsePackageFacts(value.package_facts, `${path7}.package_facts`),
    source_ref_ids: stringArray(value.source_ref_ids, `${path7}.source_ref_ids`)
  };
}
function parseRecipe(value, path7) {
  if (!isRecord(value)) throw new Error(`${path7} must be an object`);
  assertExactKeys(value, [
    "recipe_id",
    "composition",
    "outer_units",
    "components",
    "source_ref_ids"
  ], path7);
  if (value.composition !== "same_product" && value.composition !== "mixed_bundle" && value.composition !== "variety_pack") {
    throw new Error(`${path7}.composition is unsupported`);
  }
  if (!Array.isArray(value.components) || value.components.length > 100) {
    throw new Error(`${path7}.components must be an array with at most 100 items`);
  }
  const components = value.components.map((component, index) => parseRecipeComponent(component, `${path7}.components[${index}]`));
  const ids = components.map((component) => component.component_id);
  if (new Set(ids).size !== ids.length) throw new Error(`${path7}.components has duplicate component_id`);
  return {
    recipe_id: requiredString(value.recipe_id, `${path7}.recipe_id`),
    composition: value.composition,
    outer_units: nullablePositiveInteger(value.outer_units, `${path7}.outer_units`),
    components,
    source_ref_ids: stringArray(value.source_ref_ids, `${path7}.source_ref_ids`)
  };
}
function parseStructuredRecord(value, path7) {
  if (!isRecord(value)) throw new Error(`${path7} must be an object`);
  assertExactKeys(value, ["outer_units", "components", "source_ref_ids"], path7);
  if (!Array.isArray(value.components) || value.components.length > 100) {
    throw new Error(`${path7}.components must be an array with at most 100 items`);
  }
  const components = value.components.map((raw, index) => {
    const componentPath = `${path7}.components[${index}]`;
    if (!isRecord(raw)) throw new Error(`${componentPath} must be an object`);
    assertExactKeys(raw, ["component_id", "quantity"], componentPath);
    return {
      component_id: requiredString(raw.component_id, `${componentPath}.component_id`),
      quantity: positiveInteger(raw.quantity, `${componentPath}.quantity`)
    };
  });
  const ids = components.map((component) => component.component_id);
  if (new Set(ids).size !== ids.length) throw new Error(`${path7}.components has duplicate component_id`);
  return {
    outer_units: nullablePositiveInteger(value.outer_units, `${path7}.outer_units`),
    components,
    source_ref_ids: stringArray(value.source_ref_ids, `${path7}.source_ref_ids`)
  };
}
function parseProposedTruth(value, path7) {
  if (!isRecord(value)) throw new Error(`${path7} must be an object`);
  assertExactKeys(value, [
    "outer_units",
    "identity",
    "package_facts",
    "truth_source",
    "source_ref_ids"
  ], path7);
  if (value.truth_source !== "recipe" && value.truth_source !== "manual_verified") {
    throw new Error(`${path7}.truth_source must be recipe or manual_verified`);
  }
  return {
    outer_units: nullablePositiveInteger(value.outer_units, `${path7}.outer_units`),
    identity: parseIdentity(value.identity, `${path7}.identity`),
    package_facts: parsePackageFacts(value.package_facts, `${path7}.package_facts`),
    truth_source: value.truth_source,
    source_ref_ids: stringArray(value.source_ref_ids, `${path7}.source_ref_ids`)
  };
}
function parseSourceEvidence(value, path7) {
  if (!isRecord(value)) throw new Error(`${path7} must be an object`);
  assertExactKeys(value, [
    "source_ref_id",
    "source_kind",
    "locator",
    "captured_at",
    "payload_sha256",
    "supports"
  ], path7);
  if (typeof value.source_kind !== "string" || !SOURCE_KINDS.has(value.source_kind)) {
    throw new Error(`${path7}.source_kind is unsupported`);
  }
  if (value.payload_sha256 !== null && typeof value.payload_sha256 !== "string") {
    throw new Error(`${path7}.payload_sha256 must be a string or null`);
  }
  if (!Array.isArray(value.supports) || value.supports.length > EVIDENCE_SCOPES.size) {
    throw new Error(`${path7}.supports must be an array with at most ${EVIDENCE_SCOPES.size} items`);
  }
  const supports = value.supports.map((scope, index) => {
    if (typeof scope !== "string" || !EVIDENCE_SCOPES.has(scope)) {
      throw new Error(`${path7}.supports[${index}] is unsupported`);
    }
    return scope;
  });
  if (new Set(supports).size !== supports.length) throw new Error(`${path7}.supports contains duplicates`);
  return {
    source_ref_id: requiredString(value.source_ref_id, `${path7}.source_ref_id`),
    source_kind: value.source_kind,
    locator: requiredString(value.locator, `${path7}.locator`),
    captured_at: typeof value.captured_at === "string" ? value.captured_at.trim() : "",
    payload_sha256: value.payload_sha256 === null ? null : value.payload_sha256.trim(),
    supports
  };
}
function parseTruthPreflightInput(raw) {
  if (!isRecord(raw)) throw new Error("truth preflight input must be an object");
  assertExactKeys(raw, [
    "schema_version",
    "sku",
    "item_id",
    "listing_kind",
    "current_title",
    "current_title_source_ref_ids",
    "recipe",
    "structured_record",
    "proposed_truth",
    "source_evidence"
  ], "truth preflight input");
  if (raw.schema_version !== WALMART_TRUTH_PREFLIGHT_INPUT_SCHEMA) {
    throw new Error(`truth preflight input.schema_version must be ${WALMART_TRUTH_PREFLIGHT_INPUT_SCHEMA}`);
  }
  if (raw.listing_kind !== "single" && raw.listing_kind !== "multipack" && raw.listing_kind !== "bundle" && raw.listing_kind !== "variety") {
    throw new Error("truth preflight input.listing_kind is unsupported");
  }
  const itemId = requiredString(raw.item_id, "truth preflight input.item_id");
  if (!/^\d+$/.test(itemId)) throw new Error("truth preflight input.item_id must contain digits only");
  if (!Array.isArray(raw.source_evidence) || raw.source_evidence.length > 500) {
    throw new Error("truth preflight input.source_evidence must be an array with at most 500 items");
  }
  const evidence = raw.source_evidence.map((source, index) => parseSourceEvidence(source, `truth preflight input.source_evidence[${index}]`));
  const ids = evidence.map((source) => source.source_ref_id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("truth preflight input.source_evidence has duplicate source_ref_id");
  }
  return {
    schema_version: WALMART_TRUTH_PREFLIGHT_INPUT_SCHEMA,
    sku: requiredString(raw.sku, "truth preflight input.sku"),
    item_id: itemId,
    listing_kind: raw.listing_kind,
    current_title: requiredString(raw.current_title, "truth preflight input.current_title"),
    current_title_source_ref_ids: stringArray(
      raw.current_title_source_ref_ids,
      "truth preflight input.current_title_source_ref_ids"
    ),
    recipe: parseRecipe(raw.recipe, "truth preflight input.recipe"),
    structured_record: parseStructuredRecord(
      raw.structured_record,
      "truth preflight input.structured_record"
    ),
    proposed_truth: parseProposedTruth(raw.proposed_truth, "truth preflight input.proposed_truth"),
    source_evidence: evidence
  };
}
function normalizeText(value) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
function containsAlias(haystack, aliases) {
  const padded = ` ${normalizeText(haystack)} `;
  return aliases.some((alias) => {
    const needle = normalizeText(alias);
    return needle.length > 0 && padded.includes(` ${needle} `);
  });
}
function extractTitleOuterCountEvidence(title) {
  const claims = [];
  const patterns = [
    {
      syntax: "pack_of",
      pattern: /\b(?:pack|set|bundle|case|multipack)\s+of\s+(\d{1,4})\b/gi,
      valueGroup: 1
    },
    {
      syntax: "number_pack",
      pattern: /\b(\d{1,4})\s*(?:-\s*)?(?:pack|pk)\b/gi,
      valueGroup: 1
    },
    {
      syntax: "quantity_of",
      pattern: /\b(?:quantity|qty)\s+of\s+(\d{1,4})\b/gi,
      valueGroup: 1
    }
  ];
  for (const entry of patterns) {
    for (const match of title.matchAll(entry.pattern)) {
      const value = Number(match[entry.valueGroup]);
      if (!Number.isInteger(value) || value < 1) continue;
      claims.push({
        value,
        phrase: match[0],
        syntax: entry.syntax,
        index: match.index ?? 0
      });
    }
  }
  claims.sort((left, right) => left.index - right.index || left.phrase.localeCompare(right.phrase));
  const deduped = claims.filter((claim, index) => !claims.slice(0, index).some((earlier) => earlier.index === claim.index && earlier.phrase.toLowerCase() === claim.phrase.toLowerCase())).map((claim) => ({
    value: claim.value,
    phrase: claim.phrase,
    syntax: claim.syntax
  }));
  const uniqueCounts = [...new Set(deduped.map((claim) => claim.value))];
  if (uniqueCounts.length === 0) return { status: "NONE", value: null, claims: [] };
  if (uniqueCounts.length === 1) {
    return { status: "EXACT", value: uniqueCounts[0], claims: deduped };
  }
  return { status: "AMBIGUOUS", value: null, claims: deduped };
}
function canonicalIdentity(identity) {
  const groups = (value) => value.map((group) => group.map(normalizeText).sort()).sort((left, right) => left.join("|").localeCompare(right.join("|")));
  return JSON.stringify({
    brand_aliases: identity.brand_aliases.map(normalizeText).sort(),
    product_marker_groups: groups(identity.product_marker_groups),
    variant_marker_groups: groups(identity.variant_marker_groups),
    forbidden_markers: identity.forbidden_markers.map((marker) => ({
      role: marker.role,
      aliases: marker.aliases.map(normalizeText).sort()
    })).sort((left, right) => `${left.role}:${left.aliases.join("|")}`.localeCompare(`${right.role}:${right.aliases.join("|")}`))
  });
}
function canonicalPackageFacts(facts) {
  return JSON.stringify([...facts].map((fact) => ({
    kind: fact.kind,
    value: fact.value,
    unit: fact.unit,
    requirement: fact.requirement
  })).sort((left, right) => left.kind.localeCompare(right.kind)));
}
function isValidCapturedAt(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function preflightWalmartAuditTruth(raw) {
  const input = parseTruthPreflightInput(raw);
  const reasons = [];
  const reasonKeys = /* @__PURE__ */ new Set();
  const addReason = (code, path7, message) => {
    const key = `${code}\0${path7}\0${message}`;
    if (reasonKeys.has(key)) return;
    reasonKeys.add(key);
    reasons.push({ code, path: path7, message });
  };
  const evidenceById = new Map(input.source_evidence.map((source) => [source.source_ref_id, source]));
  for (const [index, source] of input.source_evidence.entries()) {
    const path7 = `source_evidence[${index}]`;
    if (source.payload_sha256 === null || source.payload_sha256 === "") {
      addReason("MISSING_SOURCE_SHA256", `${path7}.payload_sha256`, `Source ${source.source_ref_id} has no immutable payload hash`);
    } else if (!/^[a-f0-9]{64}$/i.test(source.payload_sha256)) {
      addReason("INVALID_SOURCE_SHA256", `${path7}.payload_sha256`, `Source ${source.source_ref_id} is not bound to a SHA-256 digest`);
    }
    if (!isValidCapturedAt(source.captured_at)) {
      addReason("INVALID_SOURCE_CAPTURED_AT", `${path7}.captured_at`, `Source ${source.source_ref_id} has no valid immutable capture timestamp`);
    }
  }
  const validateRefs = (refs, path7, requiredScopes) => {
    if (refs.length === 0) {
      addReason("MISSING_SOURCE_EVIDENCE", path7, "No immutable source evidence is referenced");
      return;
    }
    const resolved = refs.flatMap((ref) => {
      const source = evidenceById.get(ref);
      if (!source) {
        addReason("UNKNOWN_SOURCE_REFERENCE", path7, `Unknown source reference ${ref}`);
        return [];
      }
      if (source.source_kind === "donor_image") {
        addReason("DONOR_IMAGE_NOT_AUTHORITATIVE", path7, `Donor image ${ref} cannot establish catalog truth`);
      }
      return [source];
    });
    for (const scope of requiredScopes) {
      const declaredForScope = resolved.filter((source) => source.supports.includes(scope));
      for (const source of declaredForScope) {
        if (!sourceKindCanEstablish(source.source_kind, scope)) {
          addReason(
            "SOURCE_KIND_NOT_AUTHORITATIVE",
            path7,
            `Source ${source.source_ref_id} of kind ${source.source_kind} cannot establish ${scope}`
          );
        }
      }
      if (!declaredForScope.some((source) => sourceKindCanEstablish(source.source_kind, scope))) {
        addReason("SOURCE_SCOPE_MISSING", path7, `Referenced evidence does not support ${scope}`);
      }
    }
  };
  validateRefs(input.current_title_source_ref_ids, "current_title_source_ref_ids", ["current_title"]);
  validateRefs(input.recipe.source_ref_ids, "recipe.source_ref_ids", ["outer_units", "component_truth"]);
  validateRefs(input.structured_record.source_ref_ids, "structured_record.source_ref_ids", ["outer_units", "component_truth"]);
  validateRefs(input.proposed_truth.source_ref_ids, "proposed_truth.source_ref_ids", [
    "outer_units",
    "identity",
    "package_facts"
  ]);
  const proposedIdentity = input.proposed_truth.identity;
  if (!proposedIdentity) {
    addReason("IDENTITY_TRUTH_MISSING", "proposed_truth.identity", "No v3 identity truth is available");
  } else {
    if (proposedIdentity.brand_aliases.length === 0 || proposedIdentity.brand_aliases.some((alias) => normalizeText(alias).length < 2)) {
      addReason("IDENTITY_TRUTH_INCOMPLETE", "proposed_truth.identity", "Brand identity must contain explicit lexical v3 truth");
    }
    const missing = [];
    if (!containsAlias(input.current_title, proposedIdentity.brand_aliases)) missing.push("brand");
    for (const [index, group] of proposedIdentity.product_marker_groups.entries()) {
      if (!containsAlias(input.current_title, group)) missing.push(`product group ${index + 1}`);
    }
    for (const [index, group] of proposedIdentity.variant_marker_groups.entries()) {
      if (!containsAlias(input.current_title, group)) missing.push(`variant group ${index + 1}`);
    }
    const forbidden = proposedIdentity.forbidden_markers.filter((marker) => containsAlias(input.current_title, marker.aliases));
    if (missing.length || forbidden.length) {
      const details = [
        ...missing.length ? [`missing ${missing.join(", ")}`] : [],
        ...forbidden.length ? [`contains forbidden ${forbidden.map((marker) => `${marker.role}:${marker.aliases.join("|")}`).join(", ")}`] : []
      ];
      addReason("TITLE_IDENTITY_CONTRADICTION", "current_title", `Current title contradicts proposed identity: ${details.join("; ")}`);
    }
  }
  const validateFacts = (facts, path7) => {
    if (!facts || facts.length === 0) {
      addReason("PACKAGE_FACTS_MISSING", path7, "No typed per-outer-package facts are available");
      return;
    }
    const kinds = facts.map((fact) => fact.kind);
    const ambiguous = new Set(kinds).size !== kinds.length || facts.length > 2 || facts.some((fact) => fact.kind === "net_content" && fact.unit === "count") || facts.some((fact) => fact.kind === "inner_item_count" && (fact.unit !== "count" || !Number.isInteger(fact.value)));
    if (ambiguous) {
      addReason("NET_CONTENT_INNER_COUNT_AMBIGUITY", path7, "Net content and inner item count are not independently typed v3 facts");
    }
  };
  validateFacts(input.proposed_truth.package_facts, "proposed_truth.package_facts");
  if (input.recipe.components.length === 0) {
    addReason("MISSING_COMPONENT_TRUTH", "recipe.components", "Recipe has no explicit components");
  }
  for (const [index, component] of input.recipe.components.entries()) {
    const path7 = `recipe.components[${index}]`;
    if (!component.identity || !component.package_facts || component.package_facts.length === 0) {
      addReason("MISSING_COMPONENT_TRUTH", path7, `Component ${component.component_id} lacks identity or package truth`);
    }
    validateFacts(component.package_facts, `${path7}.package_facts`);
    validateRefs(component.source_ref_ids, `${path7}.source_ref_ids`, ["component_truth"]);
    if (component.identity && proposedIdentity && canonicalIdentity(component.identity) !== canonicalIdentity(proposedIdentity)) {
      addReason("COMPONENT_TRUTH_CONTRADICTION", `${path7}.identity`, `Component ${component.component_id} identity differs from proposed listing truth`);
    }
    if (component.package_facts && input.proposed_truth.package_facts && canonicalPackageFacts(component.package_facts) !== canonicalPackageFacts(input.proposed_truth.package_facts)) {
      addReason("COMPONENT_TRUTH_CONTRADICTION", `${path7}.package_facts`, `Component ${component.component_id} package facts differ from proposed listing truth`);
    }
  }
  if (input.recipe.composition === "mixed_bundle" || input.recipe.composition === "variety_pack") {
    addReason("MIXED_BUNDLE_UNSUPPORTED", "recipe.composition", "The v3 single-product comparator does not represent mixed or variety component truth");
  } else {
    const componentIdentitySet = new Set(input.recipe.components.flatMap((component) => component.identity ? [canonicalIdentity(component.identity)] : []));
    const componentFactSet = new Set(input.recipe.components.flatMap((component) => component.package_facts ? [canonicalPackageFacts(component.package_facts)] : []));
    if (input.listing_kind === "bundle" || input.listing_kind === "variety" || componentIdentitySet.size > 1 || componentFactSet.size > 1) {
      addReason("MIXED_BUNDLE_AMBIGUOUS", "recipe", "Listing/recipe signals disagree on whether all outer units are the same product");
    }
  }
  const titleCount = extractTitleOuterCountEvidence(input.current_title);
  if (titleCount.status === "AMBIGUOUS") {
    addReason("TITLE_OUTER_COUNT_AMBIGUOUS", "current_title", `Title contains conflicting explicit pack claims: ${titleCount.claims.map((claim) => `${claim.phrase}=${claim.value}`).join(", ")}`);
  }
  const outerCounts = [
    { source: "recipe.outer_units", value: input.recipe.outer_units },
    { source: "structured_record.outer_units", value: input.structured_record.outer_units },
    { source: "proposed_truth.outer_units", value: input.proposed_truth.outer_units },
    ...titleCount.status === "EXACT" ? [{ source: "current_title", value: titleCount.value }] : []
  ];
  for (const count of outerCounts.slice(0, 3)) {
    if (count.value === null) addReason("OUTER_COUNT_MISSING", count.source, `${count.source} has no outer sellable-unit count`);
  }
  const availableOuterCounts = outerCounts.filter((count) => count.value !== null);
  if (new Set(availableOuterCounts.map((count) => count.value)).size > 1) {
    addReason("OUTER_COUNT_DISAGREEMENT", "outer_units", `Outer count disagreement: ${availableOuterCounts.map((count) => `${count.source}=${count.value}`).join(", ")}`);
  }
  const recipeQuantity = input.recipe.components.reduce((sum, component) => sum + component.quantity, 0);
  if (input.recipe.outer_units !== null && recipeQuantity !== input.recipe.outer_units) {
    addReason("OUTER_COUNT_DISAGREEMENT", "recipe.components", `Recipe component quantity ${recipeQuantity} differs from recipe outer_units ${input.recipe.outer_units}`);
  }
  const structuredQuantity = input.structured_record.components.reduce((sum, component) => sum + component.quantity, 0);
  if (input.structured_record.outer_units !== null && structuredQuantity !== input.structured_record.outer_units) {
    addReason("OUTER_COUNT_DISAGREEMENT", "structured_record.components", `Structured component quantity ${structuredQuantity} differs from structured outer_units ${input.structured_record.outer_units}`);
  }
  const recipeComponentMap = [...input.recipe.components].map((component) => `${component.component_id}:${component.quantity}`).sort();
  const structuredComponentMap = [...input.structured_record.components].map((component) => `${component.component_id}:${component.quantity}`).sort();
  if (JSON.stringify(recipeComponentMap) !== JSON.stringify(structuredComponentMap)) {
    addReason("STRUCTURED_COMPONENT_DISAGREEMENT", "structured_record.components", "Structured record components do not exactly match the recipe");
  }
  const agreedOuterUnits = input.proposed_truth.outer_units;
  if (input.listing_kind === "single" && agreedOuterUnits !== null && agreedOuterUnits !== 1 || input.listing_kind === "multipack" && agreedOuterUnits === 1) {
    addReason("LISTING_KIND_OUTER_COUNT_CONTRADICTION", "listing_kind", `listing_kind=${input.listing_kind} contradicts outer_units=${agreedOuterUnits}`);
  }
  reasons.sort((left, right) => left.code.localeCompare(right.code) || left.path.localeCompare(right.path) || left.message.localeCompare(right.message));
  const unsupported = reasons.some((reason) => reason.code === "MIXED_BUNDLE_UNSUPPORTED");
  const status = unsupported ? "UNSUPPORTED" : reasons.length > 0 ? "TRUTH_REVIEW" : "AUDITABLE";
  const expected = status === "AUDITABLE" && proposedIdentity && input.proposed_truth.package_facts && agreedOuterUnits !== null ? {
    title: input.current_title,
    outer_units: agreedOuterUnits,
    identity: proposedIdentity,
    package_facts: input.proposed_truth.package_facts,
    truth_source: input.proposed_truth.truth_source
  } : null;
  const referencedIds = /* @__PURE__ */ new Set([
    ...input.current_title_source_ref_ids,
    ...input.recipe.source_ref_ids,
    ...input.structured_record.source_ref_ids,
    ...input.proposed_truth.source_ref_ids,
    ...input.recipe.components.flatMap((component) => component.source_ref_ids)
  ]);
  const evidenceBindings = input.source_evidence.filter((source) => referencedIds.has(source.source_ref_id)).map((source) => ({
    ...source,
    payload_sha256: source.payload_sha256 && /^[a-f0-9]{64}$/i.test(source.payload_sha256) ? source.payload_sha256.toLowerCase() : source.payload_sha256
  })).sort((left, right) => left.source_ref_id.localeCompare(right.source_ref_id));
  return {
    schema_version: WALMART_TRUTH_PREFLIGHT_RESULT_SCHEMA,
    status,
    sku: input.sku,
    item_id: input.item_id,
    input_sha256: stableHash(input),
    expected,
    evidence_bindings: evidenceBindings,
    reasons
  };
}
function summarizeTruthPreflightCoverage(results) {
  const identities = /* @__PURE__ */ new Set();
  const reasonCounts = /* @__PURE__ */ new Map();
  let auditable = 0;
  let review = 0;
  let unsupported = 0;
  for (const [index, result] of results.entries()) {
    if (result.schema_version !== WALMART_TRUTH_PREFLIGHT_RESULT_SCHEMA) {
      throw new Error(`results[${index}].schema_version is unsupported`);
    }
    const identity = `${result.sku}\0${result.item_id}`;
    if (identities.has(identity)) throw new Error(`duplicate preflight result for ${result.sku}/${result.item_id}`);
    identities.add(identity);
    if (result.status === "AUDITABLE") auditable += 1;
    else if (result.status === "TRUTH_REVIEW") review += 1;
    else if (result.status === "UNSUPPORTED") unsupported += 1;
    else throw new Error(`results[${index}].status is unsupported`);
    for (const code of new Set(result.reasons.map((reason) => reason.code))) {
      reasonCounts.set(code, (reasonCounts.get(code) ?? 0) + 1);
    }
  }
  const sortedReasonCounts = Object.fromEntries(
    [...reasonCounts.entries()].sort(([left], [right]) => left.localeCompare(right))
  );
  return {
    schema_version: WALMART_TRUTH_PREFLIGHT_COVERAGE_SCHEMA,
    total_cases: results.length,
    auditable_cases: auditable,
    truth_review_cases: review,
    unsupported_cases: unsupported,
    vision_eligible_cases: auditable,
    vision_blocked_cases: review + unsupported,
    reason_counts: sortedReasonCounts
  };
}

// src/lib/walmart/catalog-truth-export.ts
import { createHash as createHash2 } from "node:crypto";
var PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA = "product-truth-platform-walmart-audit-snapshot/v2";
var WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA = "walmart-buyer-facing-snapshot-index/v2";
var WALMART_CATALOG_TRUTH_AUDIT_EXPORT_SCHEMA = "walmart-catalog-truth-audit-export/v2";
var SEALED_WALMART_BUYER_SNAPSHOT_SCHEMA = "walmart-buyer-facing-snapshot/v3";
function walmartListingKey(storeIndex, sku) {
  if (!Number.isInteger(storeIndex) || storeIndex < 1) {
    throw new Error("store_index must be a positive integer");
  }
  if (typeof sku !== "string" || !sku || sku !== sku.trim()) {
    throw new Error("SKU must be non-empty and already trimmed");
  }
  return `walmart:${storeIndex}:${sku}`;
}
function isRecord2(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function assertExactKeys2(value, required, path7) {
  const allowed = new Set(required);
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (extras.length) throw new Error(`${path7} has unsupported fields: ${extras.join(", ")}`);
  if (missing.length) throw new Error(`${path7} is missing required fields: ${missing.join(", ")}`);
}
function requiredString2(value, path7) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path7} must be a non-empty string`);
  }
  return value.trim();
}
function exactSku(value, path7) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(`${path7} must be a non-empty, already-trimmed exact SKU`);
  }
  return value;
}
function parseListingIdentity(raw, path7) {
  if (raw.channel !== "WALMART_US") {
    throw new Error(`${path7}.channel must be WALMART_US`);
  }
  const storeIndex = positiveInteger2(raw.store_index, `${path7}.store_index`);
  const sku = exactSku(raw.sku, `${path7}.sku`);
  const listingKey = requiredString2(raw.listing_key, `${path7}.listing_key`);
  const expectedKey = walmartListingKey(storeIndex, sku);
  if (listingKey !== expectedKey) {
    throw new Error(`${path7}.listing_key must equal ${expectedKey}`);
  }
  return {
    channel: "WALMART_US",
    store_index: storeIndex,
    sku,
    listing_key: listingKey
  };
}
function compareCanonicalText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function nullableString(value, path7) {
  if (value === null) return null;
  return requiredString2(value, path7);
}
function numericItemId(value, path7) {
  const parsed = requiredString2(value, path7);
  if (!/^\d+$/.test(parsed)) throw new Error(`${path7} must contain digits only`);
  return parsed;
}
function sha256String(value, path7) {
  const parsed = requiredString2(value, path7);
  if (!/^[a-f0-9]{64}$/.test(parsed)) {
    throw new Error(`${path7} must be a lowercase SHA-256 digest`);
  }
  return parsed;
}
function validCapturedAt(value, path7) {
  const parsed = requiredString2(value, path7);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(parsed) || !Number.isFinite(Date.parse(parsed))) {
    throw new Error(`${path7} must be an ISO-8601 timestamp with timezone`);
  }
  return parsed;
}
function positiveInteger2(value, path7) {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${path7} must be a positive integer`);
  }
  return Number(value);
}
function nonNegativeInteger(value, path7) {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${path7} must be a non-negative integer`);
  }
  return Number(value);
}
function exactBoolean(value, expected, path7) {
  if (value !== expected) throw new Error(`${path7} must be ${String(expected)}`);
}
function canonicalCatalogTruthJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalCatalogTruthJson(item)).join(",")}]`;
  }
  if (isRecord2(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== void 0).sort().map((key) => `${JSON.stringify(key)}:${canonicalCatalogTruthJson(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === void 0) throw new Error("canonical JSON does not support undefined values");
  return encoded;
}
function catalogTruthCanonicalSha256(value) {
  return createHash2("sha256").update(canonicalCatalogTruthJson(value)).digest("hex");
}
function productTruthRevisionBody(raw) {
  return {
    revision_id: raw.revision_id,
    listing_kind: raw.listing_kind,
    category: raw.category,
    recipe: raw.recipe,
    structured_record: raw.structured_record,
    proposed_truth: raw.proposed_truth,
    source_evidence: raw.source_evidence
  };
}
function parseApproval(raw, revisionBodySha, path7) {
  if (raw === null) return null;
  if (!isRecord2(raw)) throw new Error(`${path7} must be an object or null`);
  assertExactKeys2(raw, [
    "decision",
    "revision_body_sha256",
    "approved_at",
    "approved_by",
    "approval_authority",
    "approval_method",
    "approval_sha256"
  ], path7);
  if (raw.decision !== "approved") throw new Error(`${path7}.decision must be approved`);
  if (raw.approval_authority !== "product_truth_platform_owner_gate") {
    throw new Error(`${path7}.approval_authority must be product_truth_platform_owner_gate`);
  }
  if (raw.approval_method !== "trusted_platform_record") {
    throw new Error(`${path7}.approval_method must be trusted_platform_record`);
  }
  const approval = {
    decision: "approved",
    revision_body_sha256: sha256String(
      raw.revision_body_sha256,
      `${path7}.revision_body_sha256`
    ),
    approved_at: validCapturedAt(raw.approved_at, `${path7}.approved_at`),
    approved_by: requiredString2(raw.approved_by, `${path7}.approved_by`),
    approval_authority: "product_truth_platform_owner_gate",
    approval_method: "trusted_platform_record",
    approval_sha256: sha256String(raw.approval_sha256, `${path7}.approval_sha256`)
  };
  if (approval.revision_body_sha256 !== revisionBodySha) {
    throw new Error(`${path7}.revision_body_sha256 does not bind the exact revision body`);
  }
  const approvalBody = {
    decision: approval.decision,
    revision_body_sha256: approval.revision_body_sha256,
    approved_at: approval.approved_at,
    approved_by: approval.approved_by,
    approval_authority: approval.approval_authority,
    approval_method: approval.approval_method
  };
  if (catalogTruthCanonicalSha256(approvalBody) !== approval.approval_sha256) {
    throw new Error(`${path7}.approval_sha256 does not match the canonical approval body`);
  }
  return approval;
}
function parseTruthRevision(raw, sku, itemId, path7) {
  if (!isRecord2(raw)) throw new Error(`${path7} must be an object`);
  assertExactKeys2(raw, [
    "revision_id",
    "body_sha256",
    "approval",
    "superseded_by_revision_id",
    "listing_kind",
    "category",
    "recipe",
    "structured_record",
    "proposed_truth",
    "source_evidence"
  ], path7);
  const bodySha = sha256String(raw.body_sha256, `${path7}.body_sha256`);
  if (catalogTruthCanonicalSha256(productTruthRevisionBody(raw)) !== bodySha) {
    throw new Error(`${path7}.body_sha256 does not match the canonical revision body`);
  }
  const parsed = parseTruthPreflightInput({
    schema_version: WALMART_TRUTH_PREFLIGHT_INPUT_SCHEMA,
    sku,
    item_id: itemId,
    listing_kind: raw.listing_kind,
    current_title: "Buyer title unavailable during revision parsing",
    current_title_source_ref_ids: [],
    recipe: raw.recipe,
    structured_record: raw.structured_record,
    proposed_truth: raw.proposed_truth,
    source_evidence: raw.source_evidence
  });
  const supersededBy = nullableString(
    raw.superseded_by_revision_id,
    `${path7}.superseded_by_revision_id`
  );
  return {
    revision_id: requiredString2(raw.revision_id, `${path7}.revision_id`),
    body_sha256: bodySha,
    approval: parseApproval(raw.approval, bodySha, `${path7}.approval`),
    superseded_by_revision_id: supersededBy,
    listing_kind: parsed.listing_kind,
    category: requiredString2(raw.category, `${path7}.category`),
    recipe: parsed.recipe,
    structured_record: parsed.structured_record,
    proposed_truth: parsed.proposed_truth,
    source_evidence: parsed.source_evidence
  };
}
function parseProductTruthSnapshot(raw) {
  const path7 = "product truth snapshot";
  if (!isRecord2(raw)) throw new Error(`${path7} must be an object`);
  assertExactKeys2(raw, [
    "schema_version",
    "snapshot_id",
    "body_sha256",
    "captured_at",
    "producer",
    "rows"
  ], path7);
  if (raw.schema_version !== PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA) {
    throw new Error(`${path7}.schema_version must be ${PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA}`);
  }
  if (raw.producer !== "shared_product_truth_platform") {
    throw new Error(`${path7}.producer must be shared_product_truth_platform`);
  }
  if (!Array.isArray(raw.rows) || raw.rows.length > 1e5) {
    throw new Error(`${path7}.rows must be an array with at most 100000 items`);
  }
  const bodySha = sha256String(raw.body_sha256, `${path7}.body_sha256`);
  const body = {
    schema_version: raw.schema_version,
    captured_at: raw.captured_at,
    producer: raw.producer,
    rows: raw.rows
  };
  if (catalogTruthCanonicalSha256(body) !== bodySha) {
    throw new Error(`${path7}.body_sha256 does not match the canonical snapshot body`);
  }
  const snapshotId = requiredString2(raw.snapshot_id, `${path7}.snapshot_id`);
  if (snapshotId !== `product-truth-${bodySha.slice(0, 16)}`) {
    throw new Error(`${path7}.snapshot_id is not derived from body_sha256`);
  }
  const rows = raw.rows.map((entry, index) => {
    const rowPath = `${path7}.rows[${index}]`;
    if (!isRecord2(entry)) throw new Error(`${rowPath} must be an object`);
    assertExactKeys2(entry, [
      "channel",
      "store_index",
      "sku",
      "listing_key",
      "item_id",
      "revision"
    ], rowPath);
    const identity = parseListingIdentity(entry, rowPath);
    const itemId = numericItemId(entry.item_id, `${rowPath}.item_id`);
    return {
      ...identity,
      item_id: itemId,
      revision: parseTruthRevision(
        entry.revision,
        identity.sku,
        itemId,
        `${rowPath}.revision`
      )
    };
  });
  assertUniqueIdentity(rows, `${path7}.rows`);
  const revisionIds = /* @__PURE__ */ new Set();
  for (const [index, row] of rows.entries()) {
    if (revisionIds.has(row.revision.revision_id)) {
      throw new Error(`${path7}.rows has duplicate revision_id ${row.revision.revision_id} at index ${index}`);
    }
    revisionIds.add(row.revision.revision_id);
  }
  return {
    schema_version: PRODUCT_TRUTH_WALMART_AUDIT_SNAPSHOT_SCHEMA,
    snapshot_id: snapshotId,
    body_sha256: bodySha,
    captured_at: validCapturedAt(raw.captured_at, `${path7}.captured_at`),
    producer: "shared_product_truth_platform",
    rows
  };
}
function assertUniqueIdentity(rows, path7) {
  const listingKeys = /* @__PURE__ */ new Set();
  for (const [index, row] of rows.entries()) {
    if (listingKeys.has(row.listing_key)) {
      throw new Error(`${path7} has duplicate listing_key ${row.listing_key} at index ${index}`);
    }
    listingKeys.add(row.listing_key);
  }
}
function stringArray2(value, path7, min = 0, max = 500) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${path7} must contain ${min}-${max} strings`);
  }
  const parsed = value.map((item, index) => requiredString2(item, `${path7}[${index}]`));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${path7} contains duplicates`);
  return parsed;
}
function httpsUrl(value, path7) {
  const parsed = requiredString2(value, path7);
  let url;
  try {
    url = new URL(parsed);
  } catch {
    throw new Error(`${path7} must be a valid HTTPS URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${path7} must use HTTPS`);
  return parsed;
}
function walmartImageUrl(value, path7) {
  const parsed = httpsUrl(value, path7);
  const hostname = new URL(parsed).hostname.toLowerCase();
  if (hostname !== "walmartimages.com" && !hostname.endsWith(".walmartimages.com")) {
    throw new Error(`${path7} must use a walmartimages.com host`);
  }
  return parsed;
}
function parseBuyerSnapshot(raw, path7) {
  if (!isRecord2(raw)) throw new Error(`${path7} must be an object`);
  assertExactKeys2(raw, [
    "schema_version",
    "snapshot_id",
    "body_sha256",
    "captured_at",
    "target",
    "identity",
    "source_contract",
    "payload_hashes",
    "assets"
  ], path7);
  if (raw.schema_version !== SEALED_WALMART_BUYER_SNAPSHOT_SCHEMA) {
    throw new Error(`${path7}.schema_version must be ${SEALED_WALMART_BUYER_SNAPSHOT_SCHEMA}`);
  }
  const bodySha = sha256String(raw.body_sha256, `${path7}.body_sha256`);
  const body = {
    schema_version: raw.schema_version,
    captured_at: raw.captured_at,
    target: raw.target,
    identity: raw.identity,
    source_contract: raw.source_contract,
    payload_hashes: raw.payload_hashes,
    assets: raw.assets
  };
  if (catalogTruthCanonicalSha256(body) !== bodySha) {
    throw new Error(`${path7}.body_sha256 does not match the canonical buyer snapshot body`);
  }
  const capturedAt = validCapturedAt(raw.captured_at, `${path7}.captured_at`);
  if (new Date(capturedAt).toISOString() !== capturedAt) {
    throw new Error(`${path7}.captured_at must be the normalized UTC timestamp written by v3 capture`);
  }
  const safeStamp = capturedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const snapshotId = requiredString2(raw.snapshot_id, `${path7}.snapshot_id`);
  if (snapshotId !== `walmart-buyer-${safeStamp}-${bodySha.slice(0, 12)}`) {
    throw new Error(`${path7}.snapshot_id is not derived from captured_at and body_sha256`);
  }
  if (!isRecord2(raw.target)) throw new Error(`${path7}.target must be an object`);
  assertExactKeys2(raw.target, ["sku", "item_id"], `${path7}.target`);
  const sku = requiredString2(raw.target.sku, `${path7}.target.sku`);
  const itemId = numericItemId(raw.target.item_id, `${path7}.target.item_id`);
  if (!isRecord2(raw.identity)) throw new Error(`${path7}.identity must be an object`);
  assertExactKeys2(raw.identity, [
    "exact_sku_match",
    "exact_item_id_match",
    "buyer_facing_verified",
    "seller",
    "catalog_search_candidate",
    "buyer",
    "chain_evidence"
  ], `${path7}.identity`);
  exactBoolean(raw.identity.exact_sku_match, true, `${path7}.identity.exact_sku_match`);
  exactBoolean(raw.identity.exact_item_id_match, true, `${path7}.identity.exact_item_id_match`);
  exactBoolean(raw.identity.buyer_facing_verified, true, `${path7}.identity.buyer_facing_verified`);
  if (!isRecord2(raw.identity.seller)) throw new Error(`${path7}.identity.seller must be an object`);
  assertExactKeys2(raw.identity.seller, [
    "sku",
    "title",
    "upc",
    "gtin14",
    "wpid",
    "published_status",
    "lifecycle_status"
  ], `${path7}.identity.seller`);
  if (requiredString2(raw.identity.seller.sku, `${path7}.identity.seller.sku`) !== sku) {
    throw new Error(`${path7}.identity.seller.sku does not match target.sku`);
  }
  const sellerTitle = requiredString2(raw.identity.seller.title, `${path7}.identity.seller.title`);
  const upc = requiredString2(raw.identity.seller.upc, `${path7}.identity.seller.upc`);
  if (!/^\d+$/.test(upc) || ![8, 12, 13, 14].includes(upc.length)) {
    throw new Error(`${path7}.identity.seller.upc is invalid`);
  }
  const gtin14 = requiredString2(raw.identity.seller.gtin14, `${path7}.identity.seller.gtin14`);
  if (!/^\d{14}$/.test(gtin14) || upc.padStart(14, "0") !== gtin14) {
    throw new Error(`${path7}.identity.seller UPC/GTIN binding is invalid`);
  }
  if (raw.identity.seller.wpid !== null) {
    const wpid = requiredString2(raw.identity.seller.wpid, `${path7}.identity.seller.wpid`);
    if (wpid === itemId) throw new Error(`${path7}.identity.seller.wpid must not be public itemId evidence`);
  }
  if (raw.identity.seller.published_status !== null) {
    requiredString2(
      raw.identity.seller.published_status,
      `${path7}.identity.seller.published_status`
    );
  }
  if (raw.identity.seller.lifecycle_status !== null) {
    requiredString2(
      raw.identity.seller.lifecycle_status,
      `${path7}.identity.seller.lifecycle_status`
    );
  }
  const candidate = raw.identity.catalog_search_candidate;
  if (!isRecord2(candidate)) throw new Error(`${path7}.identity.catalog_search_candidate must be an object`);
  assertExactKeys2(candidate, [
    "item_id",
    "title",
    "main_image_url",
    "is_marketplace_item",
    "duplicate_rows_collapsed"
  ], `${path7}.identity.catalog_search_candidate`);
  if (numericItemId(candidate.item_id, `${path7}.identity.catalog_search_candidate.item_id`) !== itemId) {
    throw new Error(`${path7}.identity.catalog_search_candidate.item_id does not match target.item_id`);
  }
  const candidateTitle = requiredString2(
    candidate.title,
    `${path7}.identity.catalog_search_candidate.title`
  );
  if (candidateTitle !== sellerTitle) {
    throw new Error(`${path7}.identity.catalog_search_candidate.title differs from seller title`);
  }
  walmartImageUrl(
    candidate.main_image_url,
    `${path7}.identity.catalog_search_candidate.main_image_url`
  );
  if (candidate.is_marketplace_item !== null && typeof candidate.is_marketplace_item !== "boolean") {
    throw new Error(`${path7}.identity.catalog_search_candidate.is_marketplace_item is invalid`);
  }
  positiveInteger2(
    candidate.duplicate_rows_collapsed,
    `${path7}.identity.catalog_search_candidate.duplicate_rows_collapsed`
  );
  const buyer = raw.identity.buyer;
  if (!isRecord2(buyer)) throw new Error(`${path7}.identity.buyer must be an object`);
  assertExactKeys2(buyer, ["item_id", "title", "identity_evidence"], `${path7}.identity.buyer`);
  if (numericItemId(buyer.item_id, `${path7}.identity.buyer.item_id`) !== itemId) {
    throw new Error(`${path7}.identity.buyer.item_id does not match target.item_id`);
  }
  requiredString2(buyer.title, `${path7}.identity.buyer.title`);
  const buyerEvidence = stringArray2(
    buyer.identity_evidence,
    `${path7}.identity.buyer.identity_evidence`,
    1
  );
  if (!buyerEvidence.some((entry) => entry.endsWith(`=${itemId}`))) {
    throw new Error(`${path7}.identity.buyer.identity_evidence does not bind target.item_id`);
  }
  const chain = raw.identity.chain_evidence;
  if (!isRecord2(chain)) throw new Error(`${path7}.identity.chain_evidence must be an object`);
  assertExactKeys2(chain, ["seller_to_catalog", "catalog_to_buyer_pdp"], `${path7}.identity.chain_evidence`);
  const sellerToCatalog = stringArray2(
    chain.seller_to_catalog,
    `${path7}.identity.chain_evidence.seller_to_catalog`,
    1
  );
  const catalogToBuyer = stringArray2(
    chain.catalog_to_buyer_pdp,
    `${path7}.identity.chain_evidence.catalog_to_buyer_pdp`,
    1
  );
  if (!sellerToCatalog.includes(`request.sku=${sku}`) || !sellerToCatalog.includes(`seller.normalized_gtin14=${gtin14}`) || !sellerToCatalog.includes(`catalog.unique_numeric_public_itemId=${itemId}`)) {
    throw new Error(`${path7}.identity.chain_evidence does not prove exact seller/catalog binding`);
  }
  if (canonicalCatalogTruthJson(catalogToBuyer) !== canonicalCatalogTruthJson(buyerEvidence)) {
    throw new Error(`${path7}.identity.chain_evidence.catalog_to_buyer_pdp differs from buyer evidence`);
  }
  if (!isRecord2(raw.source_contract)) throw new Error(`${path7}.source_contract must be an object`);
  assertExactKeys2(raw.source_contract, [
    "seller",
    "candidate",
    "buyer",
    "positional_or_fuzzy_fallbacks",
    "database_writes",
    "walmart_writes",
    "r2_writes"
  ], `${path7}.source_contract`);
  if (raw.source_contract.seller !== "walmart_marketplace_exact_sku_get" || raw.source_contract.candidate !== "walmart_catalog_search_exact_upc" || raw.source_contract.buyer !== "walmart_buyer_pdp_exact_item_get") {
    throw new Error(`${path7}.source_contract does not describe the exact buyer chain`);
  }
  for (const field of [
    "positional_or_fuzzy_fallbacks",
    "database_writes",
    "walmart_writes",
    "r2_writes"
  ]) {
    if (raw.source_contract[field] !== 0) {
      throw new Error(`${path7}.source_contract.${field} must be 0`);
    }
  }
  if (!isRecord2(raw.payload_hashes)) throw new Error(`${path7}.payload_hashes must be an object`);
  assertExactKeys2(raw.payload_hashes, [
    "seller_payload_canonical_sha256",
    "catalog_search_payload_canonical_sha256",
    "resolution_canonical_sha256",
    "buyer_payload_canonical_sha256"
  ], `${path7}.payload_hashes`);
  for (const field of [
    "seller_payload_canonical_sha256",
    "catalog_search_payload_canonical_sha256",
    "resolution_canonical_sha256",
    "buyer_payload_canonical_sha256"
  ]) {
    sha256String(raw.payload_hashes[field], `${path7}.payload_hashes.${field}`);
  }
  if (!Array.isArray(raw.assets) || raw.assets.length < 1 || raw.assets.length > 100) {
    throw new Error(`${path7}.assets must contain 1-100 sealed image manifests`);
  }
  const seenSlots = /* @__PURE__ */ new Set();
  for (const [index, asset] of raw.assets.entries()) {
    const assetPath = `${path7}.assets[${index}]`;
    if (!isRecord2(asset)) throw new Error(`${assetPath} must be an object`);
    assertExactKeys2(asset, [
      "slot",
      "source_url",
      "final_url",
      "sha256",
      "bytes",
      "media_type",
      "extension",
      "decoded_format",
      "decoded_width",
      "decoded_height",
      "local_path"
    ], assetPath);
    const slot = requiredString2(asset.slot, `${assetPath}.slot`);
    if (slot !== "MAIN" && !/^GALLERY_[1-9]\d*$/.test(slot)) {
      throw new Error(`${assetPath}.slot is unsupported`);
    }
    if (seenSlots.has(slot)) throw new Error(`${path7}.assets has duplicate slot ${slot}`);
    seenSlots.add(slot);
    walmartImageUrl(asset.source_url, `${assetPath}.source_url`);
    walmartImageUrl(asset.final_url, `${assetPath}.final_url`);
    const digest5 = sha256String(asset.sha256, `${assetPath}.sha256`);
    positiveInteger2(asset.bytes, `${assetPath}.bytes`);
    if (asset.media_type !== "image/jpeg" && asset.media_type !== "image/png" && asset.media_type !== "image/webp") {
      throw new Error(`${assetPath}.media_type is unsupported`);
    }
    if (asset.extension !== "jpg" && asset.extension !== "png" && asset.extension !== "webp") {
      throw new Error(`${assetPath}.extension is unsupported`);
    }
    const expectedFormat = asset.extension === "jpg" ? "jpeg" : asset.extension;
    if (asset.decoded_format !== expectedFormat) {
      throw new Error(`${assetPath}.decoded_format does not match extension`);
    }
    positiveInteger2(asset.decoded_width, `${assetPath}.decoded_width`);
    positiveInteger2(asset.decoded_height, `${assetPath}.decoded_height`);
    if (asset.local_path !== `assets/${digest5}.${asset.extension}`) {
      throw new Error(`${assetPath}.local_path is not content-addressed`);
    }
  }
  if (!seenSlots.has("MAIN")) throw new Error(`${path7}.assets has no MAIN image`);
  const expectedSlots = [
    "MAIN",
    ...Array.from({ length: raw.assets.length - 1 }, (_, index) => `GALLERY_${index + 1}`)
  ];
  if (canonicalCatalogTruthJson(raw.assets.map((asset) => asset.slot)) !== canonicalCatalogTruthJson(expectedSlots)) {
    throw new Error(`${path7}.assets must be ordered MAIN then contiguous gallery slots`);
  }
  return raw;
}
function parseBuyerIndex(raw) {
  const path7 = "buyer snapshot index";
  if (!isRecord2(raw)) throw new Error(`${path7} must be an object`);
  assertExactKeys2(raw, [
    "schema_version",
    "index_id",
    "body_sha256",
    "captured_at",
    "entries"
  ], path7);
  if (raw.schema_version !== WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA) {
    throw new Error(`${path7}.schema_version must be ${WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA}`);
  }
  if (!Array.isArray(raw.entries) || raw.entries.length > 1e5) {
    throw new Error(`${path7}.entries must be an array with at most 100000 items`);
  }
  const bodySha = sha256String(raw.body_sha256, `${path7}.body_sha256`);
  const body = {
    schema_version: raw.schema_version,
    captured_at: raw.captured_at,
    entries: raw.entries
  };
  if (catalogTruthCanonicalSha256(body) !== bodySha) {
    throw new Error(`${path7}.body_sha256 does not match the canonical index body`);
  }
  const indexId = requiredString2(raw.index_id, `${path7}.index_id`);
  if (indexId !== `walmart-buyer-index-${bodySha.slice(0, 16)}`) {
    throw new Error(`${path7}.index_id is not derived from body_sha256`);
  }
  const entries = raw.entries.map((entry, index) => {
    const entryPath = `${path7}.entries[${index}]`;
    if (!isRecord2(entry)) throw new Error(`${entryPath} must be an object`);
    assertExactKeys2(entry, [
      "channel",
      "store_index",
      "sku",
      "listing_key",
      "item_id",
      "snapshot"
    ], entryPath);
    const identity = parseListingIdentity(entry, entryPath);
    const itemId = numericItemId(entry.item_id, `${entryPath}.item_id`);
    const snapshot = parseBuyerSnapshot(entry.snapshot, `${entryPath}.snapshot`);
    if (snapshot.target.sku !== identity.sku || snapshot.target.item_id !== itemId) {
      throw new Error(`${entryPath}.snapshot target does not match listing identity/item_id`);
    }
    return { ...identity, item_id: itemId, snapshot };
  });
  assertUniqueIdentity(entries, `${path7}.entries`);
  const snapshotIds = /* @__PURE__ */ new Set();
  for (const [index, entry] of entries.entries()) {
    if (snapshotIds.has(entry.snapshot.snapshot_id)) {
      throw new Error(
        `${path7}.entries has duplicate snapshot_id ${entry.snapshot.snapshot_id} at index ${index}`
      );
    }
    snapshotIds.add(entry.snapshot.snapshot_id);
  }
  return {
    schema_version: WALMART_BUYER_SNAPSHOT_INDEX_SCHEMA,
    index_id: indexId,
    body_sha256: bodySha,
    captured_at: validCapturedAt(raw.captured_at, `${path7}.captured_at`),
    entries
  };
}
function mainAssetSha(snapshot) {
  const main3 = snapshot.assets.filter((asset) => asset.slot === "MAIN");
  if (main3.length !== 1) throw new Error(`${snapshot.snapshot_id} must contain exactly one MAIN asset`);
  return main3[0].sha256;
}
function preflightDisposition(result) {
  if (result.status === "AUDITABLE") return "auditable";
  if (result.status === "TRUTH_REVIEW") return "truth_review";
  return "unsupported";
}
function unsealedCase(value) {
  return value;
}
function sealCase(value) {
  const digest5 = catalogTruthCanonicalSha256(unsealedCase(value));
  return { case_id: `walmart-truth-case-${digest5.slice(0, 20)}`, ...value };
}
function compileCase(row, exactBuyer, bindingMismatch) {
  const compilerReasons = [];
  if (!row.revision.approval) compilerReasons.push("TRUTH_REVISION_UNAPPROVED");
  if (row.revision.superseded_by_revision_id) {
    compilerReasons.push("TRUTH_REVISION_SUPERSEDED");
  }
  if (bindingMismatch) compilerReasons.push("BUYER_BINDING_NOT_EXACT");
  else if (!exactBuyer) compilerReasons.push("BUYER_SNAPSHOT_MISSING");
  const publishedStatus = exactBuyer?.identity.seller.published_status ?? null;
  if (exactBuyer && publishedStatus !== "PUBLISHED") {
    compilerReasons.push("BUYER_LISTING_NOT_PUBLISHED");
  }
  const lifecycleStatus = exactBuyer?.identity.seller.lifecycle_status ?? null;
  if (exactBuyer && lifecycleStatus !== "ACTIVE") {
    compilerReasons.push("BUYER_LISTING_NOT_ACTIVE");
  }
  let preflight = null;
  if (row.revision.approval && !row.revision.superseded_by_revision_id && exactBuyer && !bindingMismatch) {
    const titleEvidenceRef = `buyer-title:${exactBuyer.snapshot_id}`;
    if (row.revision.source_evidence.some((source) => source.source_ref_id === titleEvidenceRef)) {
      throw new Error(`${row.sku}: truth evidence collides with compiler buyer-title evidence`);
    }
    preflight = preflightWalmartAuditTruth({
      schema_version: WALMART_TRUTH_PREFLIGHT_INPUT_SCHEMA,
      sku: row.sku,
      item_id: row.item_id,
      listing_kind: row.revision.listing_kind,
      current_title: exactBuyer.identity.buyer.title,
      current_title_source_ref_ids: [titleEvidenceRef],
      recipe: row.revision.recipe,
      structured_record: row.revision.structured_record,
      proposed_truth: row.revision.proposed_truth,
      source_evidence: [
        ...row.revision.source_evidence,
        {
          source_ref_id: titleEvidenceRef,
          source_kind: "buyer_pdp",
          locator: `snapshot://${exactBuyer.snapshot_id}#buyer-pdp`,
          captured_at: exactBuyer.captured_at,
          payload_sha256: exactBuyer.payload_hashes.buyer_payload_canonical_sha256,
          supports: ["current_title"]
        }
      ]
    });
  }
  const disposition = compilerReasons.length > 0 ? "truth_review" : preflight ? preflightDisposition(preflight) : "truth_review";
  const preflightSha = preflight ? catalogTruthCanonicalSha256(preflight) : null;
  return sealCase({
    channel: row.channel,
    store_index: row.store_index,
    sku: row.sku,
    listing_key: row.listing_key,
    item_id: row.item_id,
    category: row.revision.category,
    published_status: publishedStatus,
    lifecycle_status: lifecycleStatus,
    listing_kind: row.revision.listing_kind,
    recipe_composition: row.revision.recipe.composition,
    disposition,
    truth_revision: {
      revision_id: row.revision.revision_id,
      body_sha256: row.revision.body_sha256,
      approval_sha256: row.revision.approval?.approval_sha256 ?? null
    },
    buyer_snapshot: exactBuyer ? {
      snapshot_id: exactBuyer.snapshot_id,
      body_sha256: exactBuyer.body_sha256,
      main_asset_sha256: mainAssetSha(exactBuyer)
    } : null,
    preflight,
    preflight_sha256: preflightSha,
    compiler_reasons: compilerReasons
  });
}
function summarizeCases(cases) {
  return {
    total_cases: cases.length,
    auditable_cases: cases.filter((entry) => entry.disposition === "auditable").length,
    truth_review_cases: cases.filter((entry) => entry.disposition === "truth_review").length,
    unsupported_cases: cases.filter((entry) => entry.disposition === "unsupported").length
  };
}
function compileWalmartCatalogTruthExport(rawTruthSnapshot, rawBuyerIndex) {
  const truthSnapshot = parseProductTruthSnapshot(rawTruthSnapshot);
  const buyerIndex = parseBuyerIndex(rawBuyerIndex);
  const buyerByListingKey = new Map(
    buyerIndex.entries.map((entry) => [entry.listing_key, entry])
  );
  const cases = truthSnapshot.rows.map((row) => {
    const byListing = buyerByListingKey.get(row.listing_key) ?? null;
    const exact = byListing && byListing.item_id === row.item_id ? byListing.snapshot : null;
    const mismatch = !!byListing && byListing.item_id !== row.item_id;
    return compileCase(row, exact, mismatch);
  }).sort((left, right) => compareCanonicalText(left.listing_key, right.listing_key) || compareCanonicalText(left.item_id, right.item_id));
  const body = {
    schema_version: WALMART_CATALOG_TRUTH_AUDIT_EXPORT_SCHEMA,
    product_truth_snapshot: {
      snapshot_id: truthSnapshot.snapshot_id,
      body_sha256: truthSnapshot.body_sha256,
      captured_at: truthSnapshot.captured_at
    },
    buyer_index: {
      index_id: buyerIndex.index_id,
      body_sha256: buyerIndex.body_sha256,
      captured_at: buyerIndex.captured_at
    },
    summary: summarizeCases(cases),
    cases
  };
  const bodySha = catalogTruthCanonicalSha256(body);
  return {
    ...body,
    export_id: `walmart-truth-audit-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha
  };
}
function parseExportBinding(raw, type, path7) {
  if (!isRecord2(raw)) throw new Error(`${path7} must be an object`);
  const idField = type === "truth" ? "snapshot_id" : "index_id";
  assertExactKeys2(raw, [idField, "body_sha256", "captured_at"], path7);
  return {
    id: requiredString2(raw[idField], `${path7}.${idField}`),
    body_sha256: sha256String(raw.body_sha256, `${path7}.body_sha256`),
    captured_at: validCapturedAt(raw.captured_at, `${path7}.captured_at`)
  };
}
function parsePreflightResult(raw, path7) {
  if (!isRecord2(raw)) throw new Error(`${path7} must be an object`);
  assertExactKeys2(raw, [
    "schema_version",
    "status",
    "sku",
    "item_id",
    "input_sha256",
    "expected",
    "evidence_bindings",
    "reasons"
  ], path7);
  if (raw.schema_version !== WALMART_TRUTH_PREFLIGHT_RESULT_SCHEMA) {
    throw new Error(`${path7}.schema_version must be ${WALMART_TRUTH_PREFLIGHT_RESULT_SCHEMA}`);
  }
  if (raw.status !== "AUDITABLE" && raw.status !== "TRUTH_REVIEW" && raw.status !== "UNSUPPORTED") {
    throw new Error(`${path7}.status is unsupported`);
  }
  requiredString2(raw.sku, `${path7}.sku`);
  numericItemId(raw.item_id, `${path7}.item_id`);
  sha256String(raw.input_sha256, `${path7}.input_sha256`);
  if (!Array.isArray(raw.evidence_bindings)) throw new Error(`${path7}.evidence_bindings must be an array`);
  if (!Array.isArray(raw.reasons)) throw new Error(`${path7}.reasons must be an array`);
  if (raw.status === "AUDITABLE" && raw.expected === null) {
    throw new Error(`${path7}.expected must be present for AUDITABLE status`);
  }
  if (raw.status !== "AUDITABLE" && raw.expected !== null) {
    throw new Error(`${path7}.expected must be null unless status is AUDITABLE`);
  }
  return raw;
}
function parseExportCase(raw, path7) {
  if (!isRecord2(raw)) throw new Error(`${path7} must be an object`);
  assertExactKeys2(raw, [
    "case_id",
    "channel",
    "store_index",
    "sku",
    "listing_key",
    "item_id",
    "category",
    "published_status",
    "lifecycle_status",
    "listing_kind",
    "recipe_composition",
    "disposition",
    "truth_revision",
    "buyer_snapshot",
    "preflight",
    "preflight_sha256",
    "compiler_reasons"
  ], path7);
  const identity = parseListingIdentity(raw, path7);
  const sku = identity.sku;
  const itemId = numericItemId(raw.item_id, `${path7}.item_id`);
  const category = requiredString2(raw.category, `${path7}.category`);
  const publishedStatus = nullableString(raw.published_status, `${path7}.published_status`);
  const lifecycleStatus = nullableString(raw.lifecycle_status, `${path7}.lifecycle_status`);
  if (raw.listing_kind !== "single" && raw.listing_kind !== "multipack" && raw.listing_kind !== "bundle" && raw.listing_kind !== "variety") {
    throw new Error(`${path7}.listing_kind is unsupported`);
  }
  if (raw.recipe_composition !== "same_product" && raw.recipe_composition !== "mixed_bundle" && raw.recipe_composition !== "variety_pack") {
    throw new Error(`${path7}.recipe_composition is unsupported`);
  }
  if (raw.disposition !== "auditable" && raw.disposition !== "truth_review" && raw.disposition !== "unsupported") {
    throw new Error(`${path7}.disposition is unsupported`);
  }
  if (!isRecord2(raw.truth_revision)) throw new Error(`${path7}.truth_revision must be an object`);
  assertExactKeys2(raw.truth_revision, [
    "revision_id",
    "body_sha256",
    "approval_sha256"
  ], `${path7}.truth_revision`);
  const truthRevision = {
    revision_id: requiredString2(raw.truth_revision.revision_id, `${path7}.truth_revision.revision_id`),
    body_sha256: sha256String(raw.truth_revision.body_sha256, `${path7}.truth_revision.body_sha256`),
    approval_sha256: raw.truth_revision.approval_sha256 === null ? null : sha256String(raw.truth_revision.approval_sha256, `${path7}.truth_revision.approval_sha256`)
  };
  let buyerSnapshot = null;
  if (raw.buyer_snapshot !== null) {
    if (!isRecord2(raw.buyer_snapshot)) throw new Error(`${path7}.buyer_snapshot must be an object or null`);
    assertExactKeys2(raw.buyer_snapshot, [
      "snapshot_id",
      "body_sha256",
      "main_asset_sha256"
    ], `${path7}.buyer_snapshot`);
    buyerSnapshot = {
      snapshot_id: requiredString2(raw.buyer_snapshot.snapshot_id, `${path7}.buyer_snapshot.snapshot_id`),
      body_sha256: sha256String(raw.buyer_snapshot.body_sha256, `${path7}.buyer_snapshot.body_sha256`),
      main_asset_sha256: sha256String(
        raw.buyer_snapshot.main_asset_sha256,
        `${path7}.buyer_snapshot.main_asset_sha256`
      )
    };
  }
  const preflight = raw.preflight === null ? null : parsePreflightResult(raw.preflight, `${path7}.preflight`);
  const preflightSha = raw.preflight_sha256 === null ? null : sha256String(raw.preflight_sha256, `${path7}.preflight_sha256`);
  if (preflight === null !== (preflightSha === null)) {
    throw new Error(`${path7}.preflight and preflight_sha256 must both be present or null`);
  }
  if (preflight && catalogTruthCanonicalSha256(preflight) !== preflightSha) {
    throw new Error(`${path7}.preflight_sha256 does not match preflight`);
  }
  if (preflight && (preflight.sku !== sku || preflight.item_id !== itemId)) {
    throw new Error(`${path7}.preflight identity does not match the case`);
  }
  if (!Array.isArray(raw.compiler_reasons) || raw.compiler_reasons.length > 6) {
    throw new Error(`${path7}.compiler_reasons must be an array with at most 6 items`);
  }
  const allowedReasons = /* @__PURE__ */ new Set([
    "TRUTH_REVISION_UNAPPROVED",
    "TRUTH_REVISION_SUPERSEDED",
    "BUYER_SNAPSHOT_MISSING",
    "BUYER_BINDING_NOT_EXACT",
    "BUYER_LISTING_NOT_PUBLISHED",
    "BUYER_LISTING_NOT_ACTIVE"
  ]);
  const compilerReasons = raw.compiler_reasons.map((reason, index) => {
    if (typeof reason !== "string" || !allowedReasons.has(reason)) {
      throw new Error(`${path7}.compiler_reasons[${index}] is unsupported`);
    }
    return reason;
  });
  if (new Set(compilerReasons).size !== compilerReasons.length) {
    throw new Error(`${path7}.compiler_reasons contains duplicates`);
  }
  const expectedDisposition = compilerReasons.length > 0 ? "truth_review" : preflight ? preflightDisposition(preflight) : "truth_review";
  if (raw.disposition !== expectedDisposition) {
    throw new Error(`${path7}.disposition does not match compiler/preflight evidence`);
  }
  if (!preflight && compilerReasons.length === 0) {
    throw new Error(`${path7} has neither preflight evidence nor a compiler review reason`);
  }
  if (raw.disposition === "auditable") {
    if (!truthRevision.approval_sha256 || !buyerSnapshot || publishedStatus !== "PUBLISHED" || lifecycleStatus !== "ACTIVE") {
      throw new Error(
        `${path7} auditable case lacks approved truth, buyer snapshot, PUBLISHED status, or ACTIVE lifecycle`
      );
    }
    if (raw.recipe_composition !== "same_product" || raw.listing_kind !== "single" && raw.listing_kind !== "multipack") {
      throw new Error(`${path7} auditable case is outside the current comparator contract`);
    }
  }
  const parsedWithoutId = {
    ...identity,
    item_id: itemId,
    category,
    published_status: publishedStatus,
    lifecycle_status: lifecycleStatus,
    listing_kind: raw.listing_kind,
    recipe_composition: raw.recipe_composition,
    disposition: raw.disposition,
    truth_revision: truthRevision,
    buyer_snapshot: buyerSnapshot,
    preflight,
    preflight_sha256: preflightSha,
    compiler_reasons: compilerReasons
  };
  const expectedCaseId = `walmart-truth-case-${catalogTruthCanonicalSha256(parsedWithoutId).slice(0, 20)}`;
  const caseId = requiredString2(raw.case_id, `${path7}.case_id`);
  if (caseId !== expectedCaseId) throw new Error(`${path7}.case_id does not match the canonical case body`);
  return { case_id: caseId, ...parsedWithoutId };
}
function verifyWalmartCatalogTruthAuditExport(raw) {
  const path7 = "catalog truth audit export";
  if (!isRecord2(raw)) throw new Error(`${path7} must be an object`);
  assertExactKeys2(raw, [
    "schema_version",
    "export_id",
    "body_sha256",
    "product_truth_snapshot",
    "buyer_index",
    "summary",
    "cases"
  ], path7);
  if (raw.schema_version !== WALMART_CATALOG_TRUTH_AUDIT_EXPORT_SCHEMA) {
    throw new Error(`${path7}.schema_version must be ${WALMART_CATALOG_TRUTH_AUDIT_EXPORT_SCHEMA}`);
  }
  const truthBinding = parseExportBinding(
    raw.product_truth_snapshot,
    "truth",
    `${path7}.product_truth_snapshot`
  );
  const buyerBinding = parseExportBinding(raw.buyer_index, "buyer", `${path7}.buyer_index`);
  if (!Array.isArray(raw.cases) || raw.cases.length > 1e5) {
    throw new Error(`${path7}.cases must be an array with at most 100000 items`);
  }
  const cases = raw.cases.map((entry, index) => parseExportCase(entry, `${path7}.cases[${index}]`));
  assertUniqueIdentity(cases, `${path7}.cases`);
  const sorted = [...cases].sort((left, right) => compareCanonicalText(left.listing_key, right.listing_key) || compareCanonicalText(left.item_id, right.item_id));
  if (canonicalCatalogTruthJson(cases.map((entry) => entry.case_id)) !== canonicalCatalogTruthJson(sorted.map((entry) => entry.case_id))) {
    throw new Error(`${path7}.cases are not in canonical listing_key/item_id order`);
  }
  if (!isRecord2(raw.summary)) throw new Error(`${path7}.summary must be an object`);
  assertExactKeys2(raw.summary, [
    "total_cases",
    "auditable_cases",
    "truth_review_cases",
    "unsupported_cases"
  ], `${path7}.summary`);
  const suppliedSummary = {
    total_cases: nonNegativeInteger(raw.summary.total_cases, `${path7}.summary.total_cases`),
    auditable_cases: nonNegativeInteger(raw.summary.auditable_cases, `${path7}.summary.auditable_cases`),
    truth_review_cases: nonNegativeInteger(
      raw.summary.truth_review_cases,
      `${path7}.summary.truth_review_cases`
    ),
    unsupported_cases: nonNegativeInteger(
      raw.summary.unsupported_cases,
      `${path7}.summary.unsupported_cases`
    )
  };
  if (canonicalCatalogTruthJson(suppliedSummary) !== canonicalCatalogTruthJson(summarizeCases(cases))) {
    throw new Error(`${path7}.summary does not match cases`);
  }
  const parsedBody = {
    schema_version: WALMART_CATALOG_TRUTH_AUDIT_EXPORT_SCHEMA,
    product_truth_snapshot: {
      snapshot_id: truthBinding.id,
      body_sha256: truthBinding.body_sha256,
      captured_at: truthBinding.captured_at
    },
    buyer_index: {
      index_id: buyerBinding.id,
      body_sha256: buyerBinding.body_sha256,
      captured_at: buyerBinding.captured_at
    },
    summary: suppliedSummary,
    cases
  };
  const bodySha = sha256String(raw.body_sha256, `${path7}.body_sha256`);
  if (catalogTruthCanonicalSha256(parsedBody) !== bodySha) {
    throw new Error(`${path7}.body_sha256 does not match the canonical export body`);
  }
  const exportId = requiredString2(raw.export_id, `${path7}.export_id`);
  if (exportId !== `walmart-truth-audit-${bodySha.slice(0, 16)}`) {
    throw new Error(`${path7}.export_id is not derived from body_sha256`);
  }
  return { ...parsedBody, export_id: exportId, body_sha256: bodySha };
}
function verifyWalmartCatalogTruthAuditExportAgainstSources(rawExport, rawTruthSnapshot, rawBuyerIndex) {
  const verified = verifyWalmartCatalogTruthAuditExport(rawExport);
  const recompiled = compileWalmartCatalogTruthExport(rawTruthSnapshot, rawBuyerIndex);
  if (canonicalCatalogTruthJson(verified) !== canonicalCatalogTruthJson(recompiled)) {
    throw new Error(
      "catalog truth audit export does not exactly match deterministic compilation from trusted sources"
    );
  }
  return verified;
}

// src/lib/walmart/item-report-published-source.ts
import { createHash as createHash3 } from "node:crypto";
import { gunzipSync, inflateRawSync } from "node:zlib";
var WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA = "walmart-item-report-published-source/v1";
var WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA = "walmart-item-report-catalog-source/v1";
var WALMART_ITEM_REPORT_STATUS_POLICY = "walmart-item-v4-v6-published-only/v1";
var WALMART_ITEM_REPORT_CATALOG_STATUS_POLICY = "walmart-item-v6-all-status-catalog/v1";
var WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA = "walmart-item-report-create-request/v1";
var WALMART_ITEM_REPORT_READY_REQUEST_MANIFEST_SCHEMA = "walmart-item-report-ready-request/v1";
var WALMART_ITEM_REPORT_DOWNLOAD_LOCATOR_REQUEST_MANIFEST_SCHEMA = "walmart-item-report-download-locator-request/v1";
var WALMART_ITEM_REPORT_FILE_REQUEST_MANIFEST_SCHEMA = "walmart-item-report-file-request/v1";
var WALMART_ITEM_REPORT_DOWNLOAD_URL_POLICY_ID = "walmart-item-report-download-url-policy/v1";
var WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID = "walmart-item-report-trusted-atomic-exchange/v1";
var APPROVED_DOWNLOAD_HOST_SUFFIXES = Object.freeze([
  ".amazonaws.com",
  ".blob.core.windows.net",
  ".cloudfront.net",
  ".storage.googleapis.com",
  ".walmartapis.com"
]);
var CHANNEL = "WALMART_US";
var REPORT_TYPE = "ITEM";
var TEXT_ENCODING = "utf-8";
var WALMART_ITEM_REPORT_LIMITS = Object.freeze({
  max_transport_bytes: 64 * 1024 * 1024,
  max_decoded_report_bytes: 128 * 1024 * 1024,
  max_create_request_bytes: 1024 * 1024,
  max_create_response_bytes: 1024 * 1024,
  max_ready_request_bytes: 1024 * 1024,
  max_ready_status_bytes: 1024 * 1024,
  max_download_locator_request_bytes: 1024 * 1024,
  max_download_locator_response_bytes: 1024 * 1024,
  max_report_file_request_bytes: 2 * 1024 * 1024,
  max_redirects: 8,
  max_logical_records: 5e4,
  max_columns: 512,
  max_field_characters: 1e6,
  max_compression_ratio: 1e3
});
var PUBLISHED_STATUSES = ["PUBLISHED", "SYSTEM_PROBLEM", "UNPUBLISHED"];
var LIFECYCLE_STATUSES = ["ACTIVE", "ARCHIVED", "RETIRED"];
var REQUIRED_HEADER_ALIASES = {
  sku: ["SKU"],
  product_name: ["ProductName", "Product Name"],
  product_id: ["ProductId", "UPC", "GTIN"],
  product_id_type: ["ProductIdType", "UPC", "GTIN"],
  published_status: ["PublishedStatus", "Publish Status"]
};
var OPTIONAL_HEADER_ALIASES = {
  lifecycle_status: ["LifecycleStatus", "Lifecycle Status"],
  product_condition: ["ProductCondition", "Product Condition"],
  legacy_item_id: ["Item ID", "Walmart Item ID"],
  legacy_wpid: ["WPID"]
};
function isRecord3(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function asRecord(value, path7) {
  if (!isRecord3(value)) throw new Error(`${path7} must be an object`);
  return value;
}
function assertExactKeys3(value, required, path7) {
  const allowed = new Set(required);
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (extras.length) throw new Error(`${path7} has unsupported fields: ${extras.join(", ")}`);
  if (missing.length) throw new Error(`${path7} is missing required fields: ${missing.join(", ")}`);
}
function exactString(value, path7) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path7} must be a non-empty string`);
  if (value.length > WALMART_ITEM_REPORT_LIMITS.max_field_characters) {
    throw new Error(`${path7} exceeds the field-length safety cap`);
  }
  if (value !== value.trim()) throw new Error(`${path7} must already be trimmed`);
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${path7} must not contain control characters`);
  return value;
}
function exactText(value, path7) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path7} must be a non-empty string`);
  if (value.length > WALMART_ITEM_REPORT_LIMITS.max_field_characters) {
    throw new Error(`${path7} exceeds the field-length safety cap`);
  }
  if (value !== value.trim()) throw new Error(`${path7} must already be trimmed`);
  if (/[\u0000\r\n]/u.test(value)) throw new Error(`${path7} must not contain NUL or line breaks`);
  return value;
}
function nullableHeaderString(value, path7) {
  if (value === null) return null;
  return exactString(value, path7);
}
function sha256String2(value, path7) {
  const parsed = exactString(value, path7);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) throw new Error(`${path7} must be a lowercase SHA-256 digest`);
  return parsed;
}
function nullableSha256String(value, path7) {
  if (value === null) return null;
  return sha256String2(value, path7);
}
function positiveInteger3(value, path7) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${path7} must be a positive safe integer`);
  return Number(value);
}
function nonNegativeInteger2(value, path7) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${path7} must be a non-negative safe integer`);
  return Number(value);
}
function nullableNonNegativeInteger(value, path7) {
  if (value === null) return null;
  return nonNegativeInteger2(value, path7);
}
function isoTimestamp(value, path7) {
  const parsed = exactString(value, path7);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(parsed) || !Number.isFinite(Date.parse(parsed))) {
    throw new Error(`${path7} must be an ISO-8601 timestamp with timezone`);
  }
  return parsed;
}
function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
function canonicalWalmartItemReportJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalWalmartItemReportJson).join(",")}]`;
  if (isRecord3(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== void 0).sort(compareCodeUnits).map((key) => `${JSON.stringify(key)}:${canonicalWalmartItemReportJson(value[key])}`).join(",")}}`;
  }
  throw new Error(`canonical JSON does not support ${typeof value}`);
}
function walmartItemReportSha256(value) {
  return createHash3("sha256").update(canonicalWalmartItemReportJson(value)).digest("hex");
}
function walmartItemReportUtf8Sha256(value) {
  return createHash3("sha256").update(exactString(value, "opaque UTF-8 value"), "utf8").digest("hex");
}
function walmartItemReportTrustedExchangeSha256(input) {
  const raw = asRecord(input, "trusted exchange input");
  assertExactKeys3(raw, [
    "request_manifest_bytes",
    "request_correlation_id_sha256",
    "response_payload_bytes",
    "http"
  ], "trusted exchange input");
  const requestBytes = copyBytes(
    raw.request_manifest_bytes,
    "trusted exchange input.request_manifest_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_report_file_request_bytes
  );
  const responseBytes = copyBytes(
    raw.response_payload_bytes,
    "trusted exchange input.response_payload_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_decoded_report_bytes
  );
  const correlationSha256 = sha256String2(
    raw.request_correlation_id_sha256,
    "trusted exchange input.request_correlation_id_sha256"
  );
  const http = asRecord(raw.http, "trusted exchange input.http");
  assertExactKeys3(http, [
    "status",
    "content_type",
    "content_length",
    "echoed_correlation_id_sha256",
    "echoed_report_request_id_sha256"
  ], "trusted exchange input.http");
  const status = positiveInteger3(http.status, "trusted exchange input.http.status");
  const contentType = http.content_type === null ? null : exactString(http.content_type, "trusted exchange input.http.content_type");
  const contentLength = nullableNonNegativeInteger(
    http.content_length,
    "trusted exchange input.http.content_length"
  );
  if (contentLength !== null && contentLength !== responseBytes.byteLength) {
    throw new Error("trusted exchange input HTTP content length does not match response bytes");
  }
  const echoedCorrelation = nullableSha256String(
    http.echoed_correlation_id_sha256,
    "trusted exchange input.http.echoed_correlation_id_sha256"
  );
  const echoedRequestId = nullableSha256String(
    http.echoed_report_request_id_sha256,
    "trusted exchange input.http.echoed_report_request_id_sha256"
  );
  return walmartItemReportSha256({
    policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
    request_manifest_sha256: sha256Bytes(requestBytes),
    request_manifest_byte_length: requestBytes.byteLength,
    request_correlation_id_sha256: correlationSha256,
    response_payload_sha256: sha256Bytes(responseBytes),
    response_payload_byte_length: responseBytes.byteLength,
    http_status: status,
    http_content_type: contentType,
    http_content_length: contentLength,
    echoed_correlation_id_sha256: echoedCorrelation,
    echoed_report_request_id_sha256: echoedRequestId
  });
}
function sha256Bytes(bytes) {
  return createHash3("sha256").update(bytes).digest("hex");
}
function copyBytes(value, path7, maximum) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error(`${path7} must be a non-empty Uint8Array`);
  }
  if (value.byteLength > maximum) throw new Error(`${path7} exceeds the ${maximum}-byte safety cap`);
  return new Uint8Array(value);
}
function parseCapture(input) {
  const raw = asRecord(input, "capture");
  assertExactKeys3(raw, [
    "create_request_manifest_bytes",
    "create_response_payload_bytes",
    "ready_status_request_manifest_bytes",
    "ready_status_payload_bytes",
    "download_locator_request_manifest_bytes",
    "download_locator_response_payload_bytes",
    "report_file_request_manifest_bytes",
    "downloaded_body_bytes",
    "http"
  ], "capture");
  const createRequestBytes = copyBytes(
    raw.create_request_manifest_bytes,
    "capture.create_request_manifest_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_create_request_bytes
  );
  const createResponseBytes = copyBytes(
    raw.create_response_payload_bytes,
    "capture.create_response_payload_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_create_response_bytes
  );
  const readyRequestBytes = copyBytes(
    raw.ready_status_request_manifest_bytes,
    "capture.ready_status_request_manifest_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_ready_request_bytes
  );
  const downloadLocatorRequestBytes = copyBytes(
    raw.download_locator_request_manifest_bytes,
    "capture.download_locator_request_manifest_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_download_locator_request_bytes
  );
  const downloadLocatorResponseBytes = copyBytes(
    raw.download_locator_response_payload_bytes,
    "capture.download_locator_response_payload_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_download_locator_response_bytes
  );
  const reportFileRequestBytes = copyBytes(
    raw.report_file_request_manifest_bytes,
    "capture.report_file_request_manifest_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_report_file_request_bytes
  );
  const transportBytes = copyBytes(
    raw.downloaded_body_bytes,
    "capture.downloaded_body_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_transport_bytes
  );
  const statusBytes = copyBytes(
    raw.ready_status_payload_bytes,
    "capture.ready_status_payload_bytes",
    WALMART_ITEM_REPORT_LIMITS.max_ready_status_bytes
  );
  const http = asRecord(raw.http, "capture.http");
  assertExactKeys3(http, [
    "create_response",
    "ready_status_response",
    "download_locator_response",
    "download_response"
  ], "capture.http");
  const parseHttp = (value, path7, bodyLength, allowedStatuses) => {
    const metadata = asRecord(value, path7);
    assertExactKeys3(metadata, [
      "status",
      "content_type",
      "content_length",
      "echoed_correlation_id_sha256",
      "echoed_report_request_id_sha256"
    ], path7);
    const status = positiveInteger3(metadata.status, `${path7}.status`);
    if (!allowedStatuses.includes(status)) {
      throw new Error(`${path7}.status must be ${allowedStatuses.join(" or ")}`);
    }
    const contentType = metadata.content_type === null ? null : exactString(metadata.content_type, `${path7}.content_type`);
    const contentLength = nullableNonNegativeInteger(metadata.content_length, `${path7}.content_length`);
    if (contentLength !== null && contentLength !== bodyLength) {
      throw new Error(`${path7}.content_length does not match captured body bytes`);
    }
    return {
      status,
      contentType,
      contentLength,
      echoedCorrelationIdSha256: nullableSha256String(
        metadata.echoed_correlation_id_sha256,
        `${path7}.echoed_correlation_id_sha256`
      ),
      echoedReportRequestIdSha256: nullableSha256String(
        metadata.echoed_report_request_id_sha256,
        `${path7}.echoed_report_request_id_sha256`
      )
    };
  };
  return {
    createRequestBytes,
    createResponseBytes,
    readyRequestBytes,
    downloadLocatorRequestBytes,
    downloadLocatorResponseBytes,
    reportFileRequestBytes,
    transportBytes,
    statusBytes,
    createResponseHttp: parseHttp(
      http.create_response,
      "capture.http.create_response",
      createResponseBytes.byteLength,
      [200, 201]
    ),
    readyStatusHttp: parseHttp(
      http.ready_status_response,
      "capture.http.ready_status_response",
      statusBytes.byteLength,
      [200]
    ),
    downloadLocatorHttp: parseHttp(
      http.download_locator_response,
      "capture.http.download_locator_response",
      downloadLocatorResponseBytes.byteLength,
      [200]
    ),
    downloadHttp: parseHttp(
      http.download_response,
      "capture.http.download_response",
      transportBytes.byteLength,
      [200]
    )
  };
}
function parseContext(input) {
  const raw = asRecord(input, "context");
  assertExactKeys3(raw, [
    "account_scope",
    "request_correlations",
    "trusted_exchange_seals",
    "ready_at",
    "download_locator_at",
    "report_file_requested_at",
    "downloaded_at"
  ], "context");
  const scope = asRecord(raw.account_scope, "context.account_scope");
  assertExactKeys3(scope, ["channel", "store_index", "seller_account_fingerprint_sha256"], "context.account_scope");
  if (scope.channel !== CHANNEL) throw new Error(`context.account_scope.channel must be ${CHANNEL}`);
  const readyAt = isoTimestamp(raw.ready_at, "context.ready_at");
  const downloadLocatorAt = isoTimestamp(raw.download_locator_at, "context.download_locator_at");
  const reportFileRequestedAt = isoTimestamp(raw.report_file_requested_at, "context.report_file_requested_at");
  const downloadedAt = isoTimestamp(raw.downloaded_at, "context.downloaded_at");
  if (Date.parse(readyAt) > Date.parse(downloadLocatorAt) || Date.parse(downloadLocatorAt) > Date.parse(reportFileRequestedAt) || Date.parse(reportFileRequestedAt) > Date.parse(downloadedAt)) {
    throw new Error(
      "context chronology must satisfy ready_at <= download_locator_at <= report_file_requested_at <= downloaded_at"
    );
  }
  const correlations = asRecord(raw.request_correlations, "context.request_correlations");
  assertExactKeys3(correlations, [
    "create_sha256",
    "ready_status_sha256",
    "download_locator_sha256",
    "report_file_sha256"
  ], "context.request_correlations");
  const requestCorrelations = {
    create_sha256: sha256String2(correlations.create_sha256, "context.request_correlations.create_sha256"),
    ready_status_sha256: sha256String2(
      correlations.ready_status_sha256,
      "context.request_correlations.ready_status_sha256"
    ),
    download_locator_sha256: sha256String2(
      correlations.download_locator_sha256,
      "context.request_correlations.download_locator_sha256"
    ),
    report_file_sha256: sha256String2(
      correlations.report_file_sha256,
      "context.request_correlations.report_file_sha256"
    )
  };
  if (new Set(Object.values(requestCorrelations)).size !== 4) {
    throw new Error("context.request_correlations must use a distinct correlation ID hash for every request");
  }
  const seals = asRecord(raw.trusted_exchange_seals, "context.trusted_exchange_seals");
  assertExactKeys3(seals, [
    "create_response_sha256",
    "ready_status_response_sha256",
    "download_locator_response_sha256",
    "download_response_sha256"
  ], "context.trusted_exchange_seals");
  const trustedExchangeSeals = {
    create_response_sha256: sha256String2(
      seals.create_response_sha256,
      "context.trusted_exchange_seals.create_response_sha256"
    ),
    ready_status_response_sha256: sha256String2(
      seals.ready_status_response_sha256,
      "context.trusted_exchange_seals.ready_status_response_sha256"
    ),
    download_locator_response_sha256: sha256String2(
      seals.download_locator_response_sha256,
      "context.trusted_exchange_seals.download_locator_response_sha256"
    ),
    download_response_sha256: sha256String2(
      seals.download_response_sha256,
      "context.trusted_exchange_seals.download_response_sha256"
    )
  };
  if (new Set(Object.values(trustedExchangeSeals)).size !== 4) {
    throw new Error("context.trusted_exchange_seals must contain four distinct atomic exchange seals");
  }
  return {
    account_scope: {
      channel: CHANNEL,
      store_index: positiveInteger3(scope.store_index, "context.account_scope.store_index"),
      seller_account_fingerprint_sha256: sha256String2(
        scope.seller_account_fingerprint_sha256,
        "context.account_scope.seller_account_fingerprint_sha256"
      )
    },
    request_correlations: requestCorrelations,
    trusted_exchange_seals: trustedExchangeSeals,
    ready_at: readyAt,
    download_locator_at: downloadLocatorAt,
    report_file_requested_at: reportFileRequestedAt,
    downloaded_at: downloadedAt
  };
}
function decodeUtf8(bytes, path7, allowBom) {
  const bom = bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191;
  if (bom && !allowBom) throw new Error(`${path7} must not contain a UTF-8 BOM`);
  const body = bom ? bytes.subarray(3) : bytes;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body), bom };
  } catch {
    throw new Error(`${path7} is not valid UTF-8`);
  }
}
function parseJsonBytes(bytes, path7) {
  const { text } = decodeUtf8(bytes, path7, false);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path7} must contain valid JSON`);
  }
  return asRecord(parsed, path7);
}
function advertisedStrings(values, label) {
  const advertised = values.filter((value) => value !== void 0 && value !== null);
  if (advertised.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new Error(`captured Walmart payload has invalid advertised ${label}`);
  }
  return advertised;
}
function advertisedTimestamp(values, label, required) {
  const advertised = advertisedStrings(values, label);
  if (required && advertised.length === 0) throw new Error(`captured Walmart payload is missing ${label}`);
  if (advertised.length === 0) return null;
  const instants = advertised.map((value, index) => Date.parse(isoTimestamp(value, `${label}[${index}]`)));
  if (new Set(instants).size !== 1) throw new Error(`captured Walmart payload has conflicting ${label}`);
  return new Date(instants[0]).toISOString();
}
function sameInstant(left, right) {
  return Date.parse(left) === Date.parse(right);
}
function assertHttpEchoBindings(http, expectedCorrelationSha256, requestId, path7) {
  if (http.echoedCorrelationIdSha256 !== null && http.echoedCorrelationIdSha256 !== expectedCorrelationSha256) {
    throw new Error(`${path7}.echoed_correlation_id_sha256 conflicts with request manifest`);
  }
  const requestIdSha256 = walmartItemReportUtf8Sha256(requestId);
  if (http.echoedReportRequestIdSha256 !== null && http.echoedReportRequestIdSha256 !== requestIdSha256) {
    throw new Error(`${path7}.echoed_report_request_id_sha256 conflicts with report requestId`);
  }
}
function assertTrustedExchangeBinding(requestManifestBytes, requestCorrelationSha256, responsePayloadBytes, http, expectedSealSha256, path7) {
  const actual = walmartItemReportTrustedExchangeSha256({
    request_manifest_bytes: requestManifestBytes,
    request_correlation_id_sha256: requestCorrelationSha256,
    response_payload_bytes: responsePayloadBytes,
    http: {
      status: http.status,
      content_type: http.contentType,
      content_length: http.contentLength,
      echoed_correlation_id_sha256: http.echoedCorrelationIdSha256,
      echoed_report_request_id_sha256: http.echoedReportRequestIdSha256
    }
  });
  if (actual !== expectedSealSha256) {
    throw new Error(`${path7} does not match the trusted atomic capture exchange seal`);
  }
}
function parseAccountScope(value, path7) {
  const scope = asRecord(value, path7);
  assertExactKeys3(scope, ["channel", "store_index", "seller_account_fingerprint_sha256"], path7);
  if (scope.channel !== CHANNEL) throw new Error(`${path7}.channel must be ${CHANNEL}`);
  return {
    channel: CHANNEL,
    store_index: positiveInteger3(scope.store_index, `${path7}.store_index`),
    seller_account_fingerprint_sha256: sha256String2(
      scope.seller_account_fingerprint_sha256,
      `${path7}.seller_account_fingerprint_sha256`
    )
  };
}
function parseManifestBinding(value, path7) {
  const raw = asRecord(value, path7);
  assertExactKeys3(raw, ["account_scope", "request_correlation_id_sha256"], path7);
  return {
    account_scope: parseAccountScope(raw.account_scope, `${path7}.account_scope`),
    request_correlation_id_sha256: sha256String2(
      raw.request_correlation_id_sha256,
      `${path7}.request_correlation_id_sha256`
    )
  };
}
function manifestAuthority(bindingInput) {
  const binding2 = parseManifestBinding(bindingInput, "request manifest binding");
  return {
    account_scope: { ...binding2.account_scope },
    request_correlation_id_sha256: binding2.request_correlation_id_sha256
  };
}
function assertManifestAuthority(value, context, expectedCorrelationSha256, path7) {
  const authority = parseManifestBinding(value, path7);
  if (canonicalWalmartItemReportJson(authority.account_scope) !== canonicalWalmartItemReportJson(context.account_scope)) {
    throw new Error(`${path7}.account_scope does not exactly match trusted credential scope`);
  }
  if (authority.request_correlation_id_sha256 !== expectedCorrelationSha256) {
    throw new Error(`${path7}.request_correlation_id_sha256 does not match trusted request correlation`);
  }
}
function approvedDownloadHostname(hostname) {
  const normalized = hostname.toLowerCase();
  return APPROVED_DOWNLOAD_HOST_SUFFIXES.some((suffix) => normalized === suffix.slice(1) || normalized.endsWith(suffix));
}
function approvedDownloadUrlDescriptor(value, path7) {
  const rawUrl = exactString(value, path7);
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${path7} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${path7} must use HTTPS`);
  if (parsed.username || parsed.password) throw new Error(`${path7} must not contain credentials`);
  if (parsed.hash) throw new Error(`${path7} must not contain a fragment`);
  if (parsed.port) throw new Error(`${path7} must not use a non-default port`);
  const hostname = parsed.hostname.toLowerCase();
  if (!approvedDownloadHostname(hostname)) throw new Error(`${path7} hostname is not approved`);
  if (!parsed.pathname || parsed.pathname === "/") throw new Error(`${path7} must contain a non-root report path`);
  if (/%(?:2e|2f|5c)/iu.test(parsed.pathname)) {
    throw new Error(`${path7} has an ambiguous encoded path segment`);
  }
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    throw new Error(`${path7} has invalid path encoding`);
  }
  if (decodedPath.includes("\\") || decodedPath.includes("\0") || decodedPath.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${path7} path is not approved`);
  }
  return {
    url_sha256: walmartItemReportUtf8Sha256(rawUrl),
    hostname,
    path_sha256: walmartItemReportUtf8Sha256(parsed.pathname),
    https: true,
    query_present: parsed.search.length > 1,
    no_credentials: true,
    no_fragment: true,
    default_port: true,
    host_policy_approved: true,
    path_policy_approved: true
  };
}
function parseDownloadUrlDescriptor(value, path7, exactUrl) {
  const raw = asRecord(value, path7);
  assertExactKeys3(raw, [
    "url_sha256",
    "hostname",
    "path_sha256",
    "https",
    "query_present",
    "no_credentials",
    "no_fragment",
    "default_port",
    "host_policy_approved",
    "path_policy_approved"
  ], path7);
  const descriptor = {
    url_sha256: sha256String2(raw.url_sha256, `${path7}.url_sha256`),
    hostname: exactString(raw.hostname, `${path7}.hostname`).toLowerCase(),
    path_sha256: sha256String2(raw.path_sha256, `${path7}.path_sha256`),
    https: raw.https === true ? true : (() => {
      throw new Error(`${path7}.https must be true`);
    })(),
    query_present: typeof raw.query_present === "boolean" ? raw.query_present : (() => {
      throw new Error(`${path7}.query_present must be boolean`);
    })(),
    no_credentials: raw.no_credentials === true ? true : (() => {
      throw new Error(`${path7}.no_credentials must be true`);
    })(),
    no_fragment: raw.no_fragment === true ? true : (() => {
      throw new Error(`${path7}.no_fragment must be true`);
    })(),
    default_port: raw.default_port === true ? true : (() => {
      throw new Error(`${path7}.default_port must be true`);
    })(),
    host_policy_approved: raw.host_policy_approved === true ? true : (() => {
      throw new Error(`${path7}.host_policy_approved must be true`);
    })(),
    path_policy_approved: raw.path_policy_approved === true ? true : (() => {
      throw new Error(`${path7}.path_policy_approved must be true`);
    })()
  };
  if (raw.hostname !== descriptor.hostname || !approvedDownloadHostname(descriptor.hostname)) {
    throw new Error(`${path7}.hostname is not an approved canonical hostname`);
  }
  if (exactUrl !== null) {
    const expected = approvedDownloadUrlDescriptor(exactUrl, `${path7} locator URL`);
    if (canonicalWalmartItemReportJson(descriptor) !== canonicalWalmartItemReportJson(expected)) {
      throw new Error(`${path7} does not exactly describe the locator URL`);
    }
  }
  return descriptor;
}
function buildWalmartItemReportV6CreateRequestManifest(binding2) {
  return {
    schema_version: WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA,
    method: "POST",
    endpoint: "/v3/reports/reportRequests",
    query: { reportType: REPORT_TYPE, reportVersion: "v6" },
    headers: { "content-type": "application/json" },
    body: {},
    authority: manifestAuthority(binding2)
  };
}
function buildWalmartItemReportReadyRequestManifest(requestId, binding2) {
  return {
    schema_version: WALMART_ITEM_REPORT_READY_REQUEST_MANIFEST_SCHEMA,
    method: "GET",
    endpoint: "/v3/reports/reportRequests/{requestId}",
    path: { requestId: exactString(requestId, "READY requestId") },
    query: {},
    headers: {},
    authority: manifestAuthority(binding2)
  };
}
function buildWalmartItemReportDownloadLocatorRequestManifest(requestId, binding2) {
  return {
    schema_version: WALMART_ITEM_REPORT_DOWNLOAD_LOCATOR_REQUEST_MANIFEST_SCHEMA,
    method: "GET",
    endpoint: "/v3/reports/downloadReport",
    query: { requestId: exactString(requestId, "download locator requestId") },
    headers: {},
    authority: manifestAuthority(binding2)
  };
}
function buildWalmartItemReportFileRequestManifest(input) {
  const locatorUrl = exactString(input.locator_url, "report file locator_url");
  const initial = approvedDownloadUrlDescriptor(locatorUrl, "report file locator_url");
  if (!initial.query_present) throw new Error("report file locator_url must be presigned with a query string");
  const redirects = input.redirects ?? [];
  if (!Array.isArray(redirects) || redirects.length > WALMART_ITEM_REPORT_LIMITS.max_redirects) {
    throw new Error(`report file redirects must contain at most ${WALMART_ITEM_REPORT_LIMITS.max_redirects} entries`);
  }
  let currentUrl = locatorUrl;
  const visited = /* @__PURE__ */ new Set([initial.url_sha256]);
  const compiledRedirects = redirects.map((redirect, index) => {
    const path7 = `report file redirects[${index}]`;
    const raw = asRecord(redirect, path7);
    assertExactKeys3(raw, ["status", "from_url", "to_url"], path7);
    const status = positiveInteger3(raw.status, `${path7}.status`);
    if (![301, 302, 303, 307, 308].includes(status)) throw new Error(`${path7}.status is not an HTTP redirect`);
    const fromUrl = exactString(raw.from_url, `${path7}.from_url`);
    if (fromUrl !== currentUrl) throw new Error(`${path7}.from_url does not continue the exact redirect chain`);
    const toUrl = exactString(raw.to_url, `${path7}.to_url`);
    const to = approvedDownloadUrlDescriptor(toUrl, `${path7}.to_url`);
    if (visited.has(to.url_sha256)) throw new Error(`${path7}.to_url creates a redirect loop`);
    visited.add(to.url_sha256);
    currentUrl = toUrl;
    return { status, from_url_sha256: walmartItemReportUtf8Sha256(fromUrl), to };
  });
  return {
    schema_version: WALMART_ITEM_REPORT_FILE_REQUEST_MANIFEST_SCHEMA,
    method: "GET",
    headers: {},
    url_policy_id: WALMART_ITEM_REPORT_DOWNLOAD_URL_POLICY_ID,
    authority: manifestAuthority({
      account_scope: input.account_scope,
      request_correlation_id_sha256: input.request_correlation_id_sha256
    }),
    initial,
    redirects: compiledRedirects,
    final: approvedDownloadUrlDescriptor(currentUrl, "report file final URL")
  };
}
function parseCreateRequestManifest(requestBytes, context) {
  const manifest = parseJsonBytes(requestBytes, "capture.create_request_manifest_bytes");
  assertExactKeys3(manifest, [
    "schema_version",
    "method",
    "endpoint",
    "query",
    "headers",
    "body",
    "authority"
  ], "create request manifest");
  if (manifest.schema_version !== WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA) {
    throw new Error("create request manifest.schema_version is invalid");
  }
  if (manifest.method !== "POST" || manifest.endpoint !== "/v3/reports/reportRequests") {
    throw new Error("create request manifest must bind POST /v3/reports/reportRequests");
  }
  const query = asRecord(manifest.query, "create request manifest.query");
  assertExactKeys3(query, ["reportType", "reportVersion"], "create request manifest.query");
  if (query.reportType !== REPORT_TYPE || query.reportVersion !== "v6") {
    throw new Error("create request manifest must bind unfiltered ITEM reportVersion v6");
  }
  const headers = asRecord(manifest.headers, "create request manifest.headers");
  assertExactKeys3(headers, ["content-type"], "create request manifest.headers");
  if (headers["content-type"] !== "application/json") {
    throw new Error("create request manifest must bind content-type application/json");
  }
  assertExactKeys3(asRecord(manifest.body, "create request manifest.body"), [], "create request manifest.body");
  assertManifestAuthority(
    manifest.authority,
    context,
    context.request_correlations.create_sha256,
    "create request manifest.authority"
  );
}
function parseReadyRequestManifest(requestBytes, requestId, context) {
  const manifest = parseJsonBytes(requestBytes, "capture.ready_status_request_manifest_bytes");
  assertExactKeys3(manifest, [
    "schema_version",
    "method",
    "endpoint",
    "path",
    "query",
    "headers",
    "authority"
  ], "READY request manifest");
  if (manifest.schema_version !== WALMART_ITEM_REPORT_READY_REQUEST_MANIFEST_SCHEMA || manifest.method !== "GET" || manifest.endpoint !== "/v3/reports/reportRequests/{requestId}") {
    throw new Error("READY request manifest must bind GET /v3/reports/reportRequests/{requestId}");
  }
  const requestPath = asRecord(manifest.path, "READY request manifest.path");
  assertExactKeys3(requestPath, ["requestId"], "READY request manifest.path");
  if (requestPath.requestId !== requestId) throw new Error("READY request manifest path requestId does not exactly match create response");
  assertExactKeys3(asRecord(manifest.query, "READY request manifest.query"), [], "READY request manifest.query");
  assertExactKeys3(asRecord(manifest.headers, "READY request manifest.headers"), [], "READY request manifest.headers");
  assertManifestAuthority(
    manifest.authority,
    context,
    context.request_correlations.ready_status_sha256,
    "READY request manifest.authority"
  );
}
function parseDownloadLocatorRequestManifest(requestBytes, requestId, context) {
  const manifest = parseJsonBytes(requestBytes, "capture.download_locator_request_manifest_bytes");
  assertExactKeys3(manifest, [
    "schema_version",
    "method",
    "endpoint",
    "query",
    "headers",
    "authority"
  ], "download locator request manifest");
  if (manifest.schema_version !== WALMART_ITEM_REPORT_DOWNLOAD_LOCATOR_REQUEST_MANIFEST_SCHEMA || manifest.method !== "GET" || manifest.endpoint !== "/v3/reports/downloadReport") {
    throw new Error("download locator request manifest must bind GET /v3/reports/downloadReport");
  }
  const query = asRecord(manifest.query, "download locator request manifest.query");
  assertExactKeys3(query, ["requestId"], "download locator request manifest.query");
  if (query.requestId !== requestId) {
    throw new Error("download locator request manifest requestId does not exactly match create response");
  }
  assertExactKeys3(asRecord(manifest.headers, "download locator request manifest.headers"), [], "download locator request manifest.headers");
  assertManifestAuthority(
    manifest.authority,
    context,
    context.request_correlations.download_locator_sha256,
    "download locator request manifest.authority"
  );
}
function parseReportFileRequestManifest(requestBytes, locatorUrl, context) {
  const manifest = parseJsonBytes(requestBytes, "capture.report_file_request_manifest_bytes");
  assertExactKeys3(manifest, [
    "schema_version",
    "method",
    "headers",
    "url_policy_id",
    "authority",
    "initial",
    "redirects",
    "final"
  ], "report file request manifest");
  if (manifest.schema_version !== WALMART_ITEM_REPORT_FILE_REQUEST_MANIFEST_SCHEMA || manifest.method !== "GET" || manifest.url_policy_id !== WALMART_ITEM_REPORT_DOWNLOAD_URL_POLICY_ID) {
    throw new Error("report file request manifest has invalid method, schema, or URL policy");
  }
  assertExactKeys3(asRecord(manifest.headers, "report file request manifest.headers"), [], "report file request manifest.headers");
  assertManifestAuthority(
    manifest.authority,
    context,
    context.request_correlations.report_file_sha256,
    "report file request manifest.authority"
  );
  const initial = parseDownloadUrlDescriptor(manifest.initial, "report file request manifest.initial", locatorUrl);
  if (!initial.query_present) throw new Error("report file request manifest initial URL must be presigned");
  if (!Array.isArray(manifest.redirects) || manifest.redirects.length > WALMART_ITEM_REPORT_LIMITS.max_redirects) {
    throw new Error("report file request manifest.redirects exceeds safety cap or is not an array");
  }
  let priorUrlSha = initial.url_sha256;
  const visited = /* @__PURE__ */ new Set([priorUrlSha]);
  for (let index = 0; index < manifest.redirects.length; index += 1) {
    const path7 = `report file request manifest.redirects[${index}]`;
    const redirect = asRecord(manifest.redirects[index], path7);
    assertExactKeys3(redirect, ["status", "from_url_sha256", "to"], path7);
    const status = positiveInteger3(redirect.status, `${path7}.status`);
    if (![301, 302, 303, 307, 308].includes(status)) throw new Error(`${path7}.status is not an HTTP redirect`);
    if (sha256String2(redirect.from_url_sha256, `${path7}.from_url_sha256`) !== priorUrlSha) {
      throw new Error(`${path7}.from_url_sha256 breaks the redirect chain`);
    }
    const to = parseDownloadUrlDescriptor(redirect.to, `${path7}.to`, null);
    if (visited.has(to.url_sha256)) throw new Error(`${path7}.to creates a redirect loop`);
    visited.add(to.url_sha256);
    priorUrlSha = to.url_sha256;
  }
  const final = parseDownloadUrlDescriptor(manifest.final, "report file request manifest.final", null);
  if (final.url_sha256 !== priorUrlSha) throw new Error("report file request manifest.final breaks the redirect chain");
  return {
    initial,
    final,
    redirectChainSha256: walmartItemReportSha256(manifest.redirects),
    redirectCount: manifest.redirects.length
  };
}
function validateAdvertisedReportBinding(payload, nested, path7) {
  const reportTypes = advertisedStrings(
    [payload.reportType, nested?.reportType],
    `${path7} reportType`
  ).map((value) => value.trim().toUpperCase());
  if (new Set(reportTypes).size > 1 || reportTypes.some((value) => value !== REPORT_TYPE)) {
    throw new Error(`${path7} has conflicting or non-ITEM reportType`);
  }
  const reportVersions = advertisedStrings(
    [payload.reportVersion, nested?.reportVersion],
    `${path7} reportVersion`
  ).map((value) => value.trim().toLowerCase());
  if (new Set(reportVersions).size > 1 || reportVersions.some((value) => value !== "v6")) {
    throw new Error(`${path7} has conflicting or non-v6 reportVersion`);
  }
}
function parseCreateResponse(createResponseBytes) {
  const payload = parseJsonBytes(createResponseBytes, "capture.create_response_payload_bytes");
  const nested = isRecord3(payload.reportRequest) ? payload.reportRequest : null;
  const requestIds = advertisedStrings(
    [payload.requestId, payload.requestID, nested?.requestId, nested?.requestID],
    "create response request ID"
  );
  if (requestIds.length === 0 || new Set(requestIds).size !== 1) {
    throw new Error("create response must contain one unambiguous request ID");
  }
  const requestedAt = advertisedTimestamp([
    payload.requestSubmissionDate,
    payload.createdTime,
    nested?.requestSubmissionDate,
    nested?.createdTime
  ], "create response requestSubmissionDate|createdTime", true);
  validateAdvertisedReportBinding(payload, nested, "create response");
  return {
    requestId: exactString(requestIds[0], "create response.requestId"),
    requestedAt
  };
}
function parseReadyStatus(statusBytes, requestId, requestedAt, readyAt) {
  const payload = parseJsonBytes(statusBytes, "capture.ready_status_payload_bytes");
  const nested = isRecord3(payload.reportRequest) ? payload.reportRequest : null;
  const statuses = advertisedStrings(
    [payload.requestStatus, payload.status, nested?.requestStatus, nested?.status],
    "request status"
  ).map((value) => value.trim().toUpperCase());
  if (statuses.length === 0 || new Set(statuses).size !== 1 || statuses[0] !== "READY") {
    throw new Error("READY status payload must contain one unambiguous READY request status");
  }
  const requestIds = advertisedStrings(
    [payload.requestId, payload.requestID, nested?.requestId, nested?.requestID],
    "request ID"
  );
  if (requestIds.length === 0 || requestIds.some((value) => value !== requestId)) {
    throw new Error("READY status payload request ID does not exactly match create response request ID");
  }
  const reportTypes = advertisedStrings(
    [payload.reportType, nested?.reportType],
    "reportType"
  ).map((value) => value.trim().toUpperCase());
  if (reportTypes.length === 0 || new Set(reportTypes).size !== 1 || reportTypes[0] !== REPORT_TYPE) {
    throw new Error(`READY status payload must bind reportType=${REPORT_TYPE}`);
  }
  const reportVersions = advertisedStrings(
    [payload.reportVersion, nested?.reportVersion],
    "reportVersion"
  ).map((value) => value.trim().toLowerCase());
  if (reportVersions.length === 0 || new Set(reportVersions).size !== 1 || reportVersions[0] !== "v6") {
    throw new Error("READY status payload must bind reportVersion=v6");
  }
  const requestSubmissionAt = advertisedTimestamp([
    payload.requestSubmissionDate,
    payload.createdTime,
    nested?.requestSubmissionDate,
    nested?.createdTime
  ], "READY requestSubmissionDate|createdTime", false);
  if (requestSubmissionAt !== null && !sameInstant(requestSubmissionAt, requestedAt)) {
    throw new Error("READY requestSubmissionDate|createdTime conflicts with create response");
  }
  const reportGenerationAt = advertisedTimestamp([
    payload.reportGenerationDate,
    nested?.reportGenerationDate
  ], "READY reportGenerationDate", false);
  if (reportGenerationAt !== null && (Date.parse(reportGenerationAt) < Date.parse(requestedAt) || Date.parse(reportGenerationAt) > Date.parse(readyAt))) {
    throw new Error("READY reportGenerationDate must be between request submission and READY observation");
  }
  return { requestSubmissionAt, reportGenerationAt };
}
function parseDownloadLocatorResponse(responseBytes, requestId, requestedAt, readyAt, readyGenerationAt) {
  const payload = parseJsonBytes(responseBytes, "capture.download_locator_response_payload_bytes");
  const nested = isRecord3(payload.reportRequest) ? payload.reportRequest : null;
  const urls = advertisedStrings([
    payload.downloadURL,
    payload.downloadUrl,
    nested?.downloadURL,
    nested?.downloadUrl
  ], "download locator downloadURL");
  if (urls.length === 0 || new Set(urls).size !== 1) {
    throw new Error("download locator response must contain one unambiguous downloadURL");
  }
  const downloadUrl = exactString(urls[0], "download locator response.downloadURL");
  approvedDownloadUrlDescriptor(downloadUrl, "download locator response.downloadURL");
  const expirationAt = advertisedTimestamp([
    payload.downloadURLExpirationTime,
    payload.downloadUrlExpirationTime,
    nested?.downloadURLExpirationTime,
    nested?.downloadUrlExpirationTime
  ], "download locator downloadURLExpirationTime", true);
  const requestIds = advertisedStrings([
    payload.requestId,
    payload.requestID,
    nested?.requestId,
    nested?.requestID
  ], "download locator request ID");
  if (requestIds.length > 0 && requestIds.some((value) => value !== requestId)) {
    throw new Error("download locator response request ID does not exactly match create response request ID");
  }
  validateAdvertisedReportBinding(payload, nested, "download locator response");
  const requestSubmissionAt = advertisedTimestamp([
    payload.requestSubmissionDate,
    payload.createdTime,
    nested?.requestSubmissionDate,
    nested?.createdTime
  ], "download locator requestSubmissionDate|createdTime", false);
  if (requestSubmissionAt !== null && !sameInstant(requestSubmissionAt, requestedAt)) {
    throw new Error("download locator requestSubmissionDate|createdTime conflicts with create response");
  }
  const reportGenerationAt = advertisedTimestamp([
    payload.reportGenerationDate,
    nested?.reportGenerationDate
  ], "download locator reportGenerationDate", false);
  if (reportGenerationAt !== null && (Date.parse(reportGenerationAt) < Date.parse(requestedAt) || Date.parse(reportGenerationAt) > Date.parse(readyAt))) {
    throw new Error("download locator reportGenerationDate must be between request submission and READY observation");
  }
  if (reportGenerationAt !== null && readyGenerationAt !== null && !sameInstant(reportGenerationAt, readyGenerationAt)) {
    throw new Error("download locator reportGenerationDate conflicts with READY reportGenerationDate");
  }
  return { downloadUrl, expirationAt, requestSubmissionAt, reportGenerationAt };
}
function crc32(bytes) {
  let crc = 4294967295;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc >>> 1 ^ (crc & 1 ? 3988292384 : 0);
  }
  return (crc ^ 4294967295) >>> 0;
}
function extractSingleZipMember(bytes) {
  const buffer = Buffer.from(bytes);
  let eocd = -1;
  const floor = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 101010256) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > buffer.length) throw new Error("ZIP transport has no valid end-of-central-directory record");
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const commentLength = buffer.readUInt16LE(eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== 1 || totalEntries !== 1) {
    throw new Error("ZIP transport must contain exactly one member on one disk");
  }
  if (eocd + 22 + commentLength !== buffer.length) throw new Error("ZIP transport has trailing or truncated bytes");
  if (centralOffset + centralSize !== eocd || centralOffset + 46 > buffer.length) {
    throw new Error("ZIP transport central directory bounds are invalid");
  }
  if (buffer.readUInt32LE(centralOffset) !== 33639248) throw new Error("ZIP transport central directory entry is invalid");
  const flags = buffer.readUInt16LE(centralOffset + 8);
  const method = buffer.readUInt16LE(centralOffset + 10);
  const expectedCrc = buffer.readUInt32LE(centralOffset + 16);
  const compressedSize = buffer.readUInt32LE(centralOffset + 20);
  const uncompressedSize = buffer.readUInt32LE(centralOffset + 24);
  const nameLength = buffer.readUInt16LE(centralOffset + 28);
  const extraLength = buffer.readUInt16LE(centralOffset + 30);
  const memberCommentLength = buffer.readUInt16LE(centralOffset + 32);
  const localOffset = buffer.readUInt32LE(centralOffset + 42);
  if ((flags & 1) !== 0) throw new Error("ZIP transport member must not be encrypted");
  if (method !== 0 && method !== 8) throw new Error(`ZIP transport compression method ${method} is unsupported`);
  if ([compressedSize, uncompressedSize, localOffset].includes(4294967295)) throw new Error("ZIP64 transport is unsupported");
  if (uncompressedSize > WALMART_ITEM_REPORT_LIMITS.max_decoded_report_bytes) {
    throw new Error("ZIP transport declared uncompressed size exceeds decoded-report safety cap");
  }
  if (uncompressedSize > Math.max(1, compressedSize) * WALMART_ITEM_REPORT_LIMITS.max_compression_ratio) {
    throw new Error("ZIP transport declared compression ratio exceeds safety cap");
  }
  if (centralOffset + 46 + nameLength + extraLength + memberCommentLength !== eocd) {
    throw new Error("ZIP transport central directory entry length is invalid");
  }
  const nameBytes = buffer.subarray(centralOffset + 46, centralOffset + 46 + nameLength);
  const { text: name } = decodeUtf8(nameBytes, "ZIP member name", false);
  if (!name || name.endsWith("/") || name.includes("\0")) throw new Error("ZIP transport member name is invalid");
  if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 67324752) {
    throw new Error("ZIP transport local header is invalid");
  }
  const localFlags = buffer.readUInt16LE(localOffset + 6);
  const localMethod = buffer.readUInt16LE(localOffset + 8);
  const localNameLength = buffer.readUInt16LE(localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localOffset + 28);
  if (localFlags !== flags || localMethod !== method) throw new Error("ZIP transport local/central metadata conflict");
  const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength);
  if (!localName.equals(nameBytes)) throw new Error("ZIP transport local/central member names conflict");
  const dataStart = localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataStart > centralOffset || dataEnd > centralOffset) throw new Error("ZIP transport member bounds are invalid");
  const compressed = buffer.subarray(dataStart, dataEnd);
  let decoded;
  try {
    decoded = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: WALMART_ITEM_REPORT_LIMITS.max_decoded_report_bytes });
  } catch {
    throw new Error("ZIP transport member decompression failed");
  }
  if (decoded.byteLength !== uncompressedSize) throw new Error("ZIP transport uncompressed size mismatch");
  if (crc32(decoded) !== expectedCrc) throw new Error("ZIP transport member CRC32 mismatch");
  return { name, bytes: new Uint8Array(decoded) };
}
function decodeTransport(transportBytes) {
  const validateDecoded = (decoded, container) => {
    if (decoded.byteLength > WALMART_ITEM_REPORT_LIMITS.max_decoded_report_bytes) {
      throw new Error("decoded ITEM report exceeds decoded-report safety cap");
    }
    if (container !== "plain" && decoded.byteLength > Math.max(1, transportBytes.byteLength) * WALMART_ITEM_REPORT_LIMITS.max_compression_ratio) {
      throw new Error("ITEM report compression ratio exceeds safety cap");
    }
    return decoded;
  };
  if (transportBytes[0] === 31 && transportBytes[1] === 139) {
    try {
      const decoded = new Uint8Array(gunzipSync(transportBytes, {
        maxOutputLength: WALMART_ITEM_REPORT_LIMITS.max_decoded_report_bytes
      }));
      return { container: "gzip", memberName: null, reportBytes: validateDecoded(decoded, "gzip") };
    } catch {
      throw new Error("gzip report transport decompression failed");
    }
  }
  if (transportBytes[0] === 80 && transportBytes[1] === 75 && (transportBytes[2] === 3 || transportBytes[2] === 5 || transportBytes[2] === 7) && (transportBytes[3] === 4 || transportBytes[3] === 6 || transportBytes[3] === 8)) {
    const member = extractSingleZipMember(transportBytes);
    return { container: "zip", memberName: member.name, reportBytes: validateDecoded(member.bytes, "zip") };
  }
  return {
    container: "plain",
    memberName: null,
    reportBytes: validateDecoded(new Uint8Array(transportBytes), "plain")
  };
}
function normalizeHeader(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/gu, "");
}
function resolveHeaderRole(normalized, role, aliases, required) {
  const accepted = new Set(aliases.map(normalizeHeader));
  const matches = normalized.map((name, index) => ({ name, index })).filter(({ name }) => accepted.has(name)).map(({ index }) => index);
  if (matches.length > 1) throw new Error(`ITEM report header has ambiguous ${role} columns at indexes ${matches.join(", ")}`);
  if (required && matches.length === 0) throw new Error(`ITEM report header is missing required ${role} column`);
  return matches[0] ?? null;
}
function selfDescribingProductIdentifierType(header) {
  const normalized = normalizeHeader(header);
  if (normalized === "upc") return "UPC";
  if (normalized === "gtin") return "GTIN";
  return null;
}
function resolveProductIdentifierMapping(normalized) {
  const explicitId = resolveHeaderRole(normalized, "product_id", ["ProductId"], false);
  const explicitType = resolveHeaderRole(normalized, "product_id_type", ["ProductIdType"], false);
  if (explicitId !== null || explicitType !== null) {
    if (explicitId === null) throw new Error("ITEM report header is missing required product_id column");
    if (explicitType === null) throw new Error("ITEM report header is missing required product_id_type column");
    return { product_id: explicitId, product_id_type: explicitType };
  }
  const upc = resolveHeaderRole(normalized, "product_id", ["UPC"], false);
  const gtin = resolveHeaderRole(normalized, "product_id", ["GTIN"], false);
  const selfDescribing = upc ?? gtin;
  if (selfDescribing === null) throw new Error("ITEM report header is missing required product_id column");
  return { product_id: selfDescribing, product_id_type: selfDescribing };
}
function findHeaderMapping(header, reportVersion) {
  const normalized = header.map(normalizeHeader);
  const productIdentifier = resolveProductIdentifierMapping(normalized);
  return {
    sku: resolveHeaderRole(normalized, "sku", REQUIRED_HEADER_ALIASES.sku, true),
    product_name: resolveHeaderRole(normalized, "product_name", REQUIRED_HEADER_ALIASES.product_name, true),
    product_id: productIdentifier.product_id,
    product_id_type: productIdentifier.product_id_type,
    published_status: resolveHeaderRole(
      normalized,
      "published_status",
      REQUIRED_HEADER_ALIASES.published_status,
      true
    ),
    lifecycle_status: resolveHeaderRole(
      normalized,
      "lifecycle_status",
      OPTIONAL_HEADER_ALIASES.lifecycle_status,
      false
    ),
    product_condition: resolveHeaderRole(
      normalized,
      "product_condition",
      OPTIONAL_HEADER_ALIASES.product_condition,
      reportVersion === "v6"
    ),
    legacy_item_id: resolveHeaderRole(
      normalized,
      "legacy_item_id",
      OPTIONAL_HEADER_ALIASES.legacy_item_id,
      false
    ),
    legacy_wpid: resolveHeaderRole(normalized, "legacy_wpid", OPTIONAL_HEADER_ALIASES.legacy_wpid, false)
  };
}
function productIdentifierEvidence(record7, header, mapping, recordPath) {
  const identifierHeader = header[mapping.product_id];
  const identifierTypeHeader = header[mapping.product_id_type];
  const identifier2 = exactString(record7[mapping.product_id], `${recordPath}.product_id`);
  if (mapping.product_id === mapping.product_id_type) {
    const identifierType = selfDescribingProductIdentifierType(identifierHeader);
    if (identifierType === null) {
      throw new Error(`${recordPath}.product_id self-describing header must be UPC or GTIN`);
    }
    return { identifier: identifier2, identifierType, identifierHeader, identifierTypeHeader };
  }
  return {
    identifier: identifier2,
    identifierType: exactString(record7[mapping.product_id_type], `${recordPath}.product_id_type`),
    identifierHeader,
    identifierTypeHeader
  };
}
function firstLogicalRecord(text) {
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && (char === "\n" || char === "\r")) return text.slice(0, index);
  }
  if (quoted) throw new Error("ITEM report header has an unterminated quoted field");
  return text;
}
function countUnquoted(recordText, needle) {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < recordText.length; index += 1) {
    const char = recordText[index];
    if (char === '"') {
      if (quoted && recordText[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && char === needle) count += 1;
  }
  if (quoted) throw new Error("ITEM report header has an unterminated quoted field");
  return count;
}
function detectDelimiter(text) {
  const header = firstLogicalRecord(text);
  const commas = countUnquoted(header, ",");
  const tabs = countUnquoted(header, "	");
  if (commas > 0 && tabs > 0) throw new Error("ITEM report header mixes comma and tab delimiters");
  if (commas === 0 && tabs === 0) throw new Error("ITEM report delimiter cannot be determined from the header");
  return tabs > 0 ? "	" : ",";
}
function detectLineEnding(text) {
  let crlf = 0;
  let lf = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r" && text[index + 1] === "\n") {
      crlf += 1;
      index += 1;
    } else if (text[index] === "\n") lf += 1;
    else if (text[index] === "\r") throw new Error("ITEM report contains a bare carriage return");
  }
  if (crlf && lf) return "MIXED";
  if (crlf) return "CRLF";
  if (lf) return "LF";
  return "NONE";
}
function parseDelimitedRecords(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let afterClosingQuote = false;
  const appendField = (value) => {
    if (field.length + value.length > WALMART_ITEM_REPORT_LIMITS.max_field_characters) {
      throw new Error("ITEM report field exceeds field-length safety cap");
    }
    field += value;
  };
  const pushField = () => {
    if (row.length >= WALMART_ITEM_REPORT_LIMITS.max_columns) {
      throw new Error("ITEM report record exceeds column-count safety cap");
    }
    row.push(field);
    field = "";
  };
  const pushRecord = () => {
    pushField();
    if (rows.length >= WALMART_ITEM_REPORT_LIMITS.max_logical_records) {
      throw new Error("ITEM report exceeds logical-record safety cap");
    }
    rows.push(row);
    row = [];
    afterClosingQuote = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          appendField('"');
          index += 1;
        } else {
          inQuotes = false;
          afterClosingQuote = true;
        }
      } else appendField(char);
      continue;
    }
    if (afterClosingQuote) {
      if (char === delimiter) {
        pushField();
        afterClosingQuote = false;
      } else if (char === "\n" || char === "\r") {
        if (char === "\r" && text[index + 1] === "\n") index += 1;
        pushRecord();
      } else throw new Error(`ITEM report has data after a closing quote at character ${index + 1}`);
    } else if (char === '"') {
      if (field.length) throw new Error(`ITEM report has a quote inside an unquoted field at character ${index + 1}`);
      inQuotes = true;
    } else if (char === delimiter) {
      pushField();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      pushRecord();
    } else appendField(char);
  }
  if (inQuotes) throw new Error("ITEM report has an unterminated quoted field");
  if (field.length || row.length || afterClosingQuote) pushRecord();
  return rows;
}
function parseReport(reportBytes, reportVersion) {
  const { text, bom } = decodeUtf8(reportBytes, "decoded ITEM report", true);
  if (!text.length) throw new Error("decoded ITEM report is empty");
  if (text.includes("\0")) throw new Error("decoded ITEM report contains NUL bytes");
  const lineEnding = detectLineEnding(text);
  const delimiter = detectDelimiter(text);
  const parsed = parseDelimitedRecords(text, delimiter);
  if (parsed.length < 2) throw new Error("ITEM report must contain a header and at least one data record");
  const header = parsed[0];
  if (header.some((name) => name.length === 0)) throw new Error("ITEM report header contains an empty column name");
  for (let index = 0; index < header.length; index += 1) {
    exactString(header[index], `ITEM report header[${index}]`);
  }
  const normalized = header.map(normalizeHeader);
  const duplicate = normalized.find((name, index) => normalized.indexOf(name) !== index);
  if (duplicate) throw new Error(`ITEM report has duplicate normalized header: ${duplicate}`);
  const headerMapping = findHeaderMapping(header, reportVersion);
  const records = parsed.slice(1).map((cells, index) => {
    const sourceRecordNumber = index + 2;
    if (cells.every((cell) => cell === "")) throw new Error(`ITEM report record ${sourceRecordNumber} is blank`);
    if (cells.length !== header.length) {
      throw new Error(`ITEM report record ${sourceRecordNumber} has ${cells.length} cells; expected ${header.length}`);
    }
    return { sourceRecordNumber, cells };
  });
  return {
    delimiter,
    mediaType: delimiter === "," ? "text/csv" : "text/tab-separated-values",
    utf8Bom: bom,
    lineEnding,
    header,
    headerMapping,
    records
  };
}
function normalizeStatus(value, path7) {
  if (!value.length) throw new Error(`${path7} must be non-empty`);
  if (value !== value.trim()) throw new Error(`${path7} must already be trimmed`);
  if (!/^[A-Za-z _-]+$/u.test(value)) throw new Error(`${path7} has unsupported characters`);
  return value.toUpperCase().replace(/[ -]+/gu, "_");
}
function parsePublishedStatus(value, path7) {
  const normalized = normalizeStatus(value, path7);
  if (!PUBLISHED_STATUSES.includes(normalized)) {
    throw new Error(`${path7} has unsupported published status: ${value}`);
  }
  return normalized;
}
function parseLifecycleStatus(value, path7) {
  const normalized = normalizeStatus(value, path7);
  if (!LIFECYCLE_STATUSES.includes(normalized)) {
    throw new Error(`${path7} has unsupported lifecycle status: ${value}`);
  }
  return normalized;
}
function parseOptionalLifecycleStatus(value, path7) {
  if (value.trim().length === 0) return null;
  return parseLifecycleStatus(value, path7);
}
function fixedStatusSemantics() {
  return {
    policy_id: WALMART_ITEM_REPORT_STATUS_POLICY,
    accepted_published_statuses: [...PUBLISHED_STATUSES],
    accepted_lifecycle_statuses: [...LIFECYCLE_STATUSES],
    inclusion_rule: { published_status: "PUBLISHED", lifecycle_filter: "NONE" },
    lifecycle_status_role: "OPTIONAL_EVIDENCE_ONLY"
  };
}
function optionalExactCell(record7, index, path7) {
  if (index === null) return null;
  return exactString(record7[index], path7);
}
function compileBody(capture, context) {
  assertTrustedExchangeBinding(
    capture.createRequestBytes,
    context.request_correlations.create_sha256,
    capture.createResponseBytes,
    capture.createResponseHttp,
    context.trusted_exchange_seals.create_response_sha256,
    "create response"
  );
  assertTrustedExchangeBinding(
    capture.readyRequestBytes,
    context.request_correlations.ready_status_sha256,
    capture.statusBytes,
    capture.readyStatusHttp,
    context.trusted_exchange_seals.ready_status_response_sha256,
    "READY status response"
  );
  assertTrustedExchangeBinding(
    capture.downloadLocatorRequestBytes,
    context.request_correlations.download_locator_sha256,
    capture.downloadLocatorResponseBytes,
    capture.downloadLocatorHttp,
    context.trusted_exchange_seals.download_locator_response_sha256,
    "download locator response"
  );
  assertTrustedExchangeBinding(
    capture.reportFileRequestBytes,
    context.request_correlations.report_file_sha256,
    capture.transportBytes,
    capture.downloadHttp,
    context.trusted_exchange_seals.download_response_sha256,
    "download response"
  );
  parseCreateRequestManifest(capture.createRequestBytes, context);
  const createResponse = parseCreateResponse(capture.createResponseBytes);
  if (Date.parse(createResponse.requestedAt) > Date.parse(context.ready_at)) {
    throw new Error("context.ready_at must be at or after create response requestSubmissionDate");
  }
  assertHttpEchoBindings(
    capture.createResponseHttp,
    context.request_correlations.create_sha256,
    createResponse.requestId,
    "capture.http.create_response"
  );
  parseReadyRequestManifest(capture.readyRequestBytes, createResponse.requestId, context);
  const readyEvidence = parseReadyStatus(
    capture.statusBytes,
    createResponse.requestId,
    createResponse.requestedAt,
    context.ready_at
  );
  assertHttpEchoBindings(
    capture.readyStatusHttp,
    context.request_correlations.ready_status_sha256,
    createResponse.requestId,
    "capture.http.ready_status_response"
  );
  parseDownloadLocatorRequestManifest(capture.downloadLocatorRequestBytes, createResponse.requestId, context);
  const locator = parseDownloadLocatorResponse(
    capture.downloadLocatorResponseBytes,
    createResponse.requestId,
    createResponse.requestedAt,
    context.ready_at,
    readyEvidence.reportGenerationAt
  );
  if (Date.parse(locator.expirationAt) < Date.parse(context.downloaded_at)) {
    throw new Error("downloadURLExpirationTime must cover the observed report download time");
  }
  assertHttpEchoBindings(
    capture.downloadLocatorHttp,
    context.request_correlations.download_locator_sha256,
    createResponse.requestId,
    "capture.http.download_locator_response"
  );
  const fileRequest = parseReportFileRequestManifest(capture.reportFileRequestBytes, locator.downloadUrl, context);
  assertHttpEchoBindings(
    capture.downloadHttp,
    context.request_correlations.report_file_sha256,
    createResponse.requestId,
    "capture.http.download_response"
  );
  const decoded = decodeTransport(capture.transportBytes);
  if (decoded.reportBytes.byteLength === 0) throw new Error("decoded ITEM report bytes are empty");
  const parsed = parseReport(decoded.reportBytes, "v6");
  const publishedCounts = new Map(PUBLISHED_STATUSES.map((status) => [status, 0]));
  const lifecycleCounts = new Map(LIFECYCLE_STATUSES.map((status) => [status, 0]));
  let lifecycleNotReportedCount = 0;
  const rows = [];
  const seenReportListings = /* @__PURE__ */ new Map();
  for (const reportRecord of parsed.records) {
    const recordPath = `ITEM report record ${reportRecord.sourceRecordNumber}`;
    const sku = exactString(reportRecord.cells[parsed.headerMapping.sku], `${recordPath}.sku`);
    const listingKey = walmartListingKey(context.account_scope.store_index, sku);
    const priorReportRecord = seenReportListings.get(listingKey);
    if (priorReportRecord) {
      const duplicate = canonicalWalmartItemReportJson(priorReportRecord.cells) === canonicalWalmartItemReportJson(reportRecord.cells);
      throw new Error(
        `${recordPath} ${duplicate ? "duplicates" : "conflicts with"} listing_key ${listingKey} (first seen at record ${priorReportRecord.sourceRecordNumber})`
      );
    }
    seenReportListings.set(listingKey, {
      sourceRecordNumber: reportRecord.sourceRecordNumber,
      cells: [...reportRecord.cells]
    });
    const published = parsePublishedStatus(
      reportRecord.cells[parsed.headerMapping.published_status],
      `${recordPath}.published_status`
    );
    const lifecycle = parsed.headerMapping.lifecycle_status === null ? null : parseOptionalLifecycleStatus(
      reportRecord.cells[parsed.headerMapping.lifecycle_status],
      `${recordPath}.lifecycle_status`
    );
    publishedCounts.set(published, (publishedCounts.get(published) ?? 0) + 1);
    if (lifecycle === null) lifecycleNotReportedCount += 1;
    else lifecycleCounts.set(lifecycle, (lifecycleCounts.get(lifecycle) ?? 0) + 1);
    if (published !== "PUBLISHED") continue;
    const productIdentifier = productIdentifierEvidence(
      reportRecord.cells,
      parsed.header,
      parsed.headerMapping,
      recordPath
    );
    const productName = exactText(
      reportRecord.cells[parsed.headerMapping.product_name],
      `${recordPath}.product_name`
    );
    const productCondition = optionalExactCell(
      reportRecord.cells,
      parsed.headerMapping.product_condition,
      `${recordPath}.product_condition`
    );
    const legacyItemId = optionalExactCell(
      reportRecord.cells,
      parsed.headerMapping.legacy_item_id,
      `${recordPath}.legacy_item_id`
    );
    const legacyWpid = optionalExactCell(
      reportRecord.cells,
      parsed.headerMapping.legacy_wpid,
      `${recordPath}.legacy_wpid`
    );
    const compiled = {
      channel: CHANNEL,
      store_index: context.account_scope.store_index,
      sku,
      listing_key: listingKey,
      reported_product_identifier_opaque: productIdentifier.identifier,
      reported_product_identifier_type_opaque: productIdentifier.identifierType,
      reported_product_identifier_header: productIdentifier.identifierHeader,
      reported_product_identifier_type_header: productIdentifier.identifierTypeHeader,
      reported_product_name: productName,
      reported_product_name_header: parsed.header[parsed.headerMapping.product_name],
      reported_product_condition: productCondition,
      reported_product_condition_header: parsed.headerMapping.product_condition === null ? null : parsed.header[parsed.headerMapping.product_condition],
      reported_lifecycle_status: lifecycle,
      reported_lifecycle_status_header: parsed.headerMapping.lifecycle_status === null ? null : parsed.header[parsed.headerMapping.lifecycle_status],
      reported_legacy_item_identifier_opaque: legacyItemId,
      reported_legacy_item_identifier_header: parsed.headerMapping.legacy_item_id === null ? null : parsed.header[parsed.headerMapping.legacy_item_id],
      reported_legacy_wpid_opaque: legacyWpid,
      reported_legacy_wpid_header: parsed.headerMapping.legacy_wpid === null ? null : parsed.header[parsed.headerMapping.legacy_wpid],
      published_status: "PUBLISHED",
      source_record_number: reportRecord.sourceRecordNumber,
      source_record_sha256: walmartItemReportSha256(reportRecord.cells)
    };
    rows.push(compiled);
  }
  rows.sort((left, right) => compareCodeUnits(left.listing_key, right.listing_key));
  const includedCount = rows.length;
  const dataCount = parsed.records.length;
  return {
    schema_version: WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA,
    account_scope: structuredClone(context.account_scope),
    report: {
      source_system: "walmart_marketplace_api",
      report_type: REPORT_TYPE,
      report_version: "v6",
      report_request_id: createResponse.requestId,
      requested_at: createResponse.requestedAt,
      cutoff_at: context.ready_at,
      cutoff_basis: "READY_OBSERVED_UPPER_BOUND",
      ready_at: context.ready_at,
      download_locator_at: context.download_locator_at,
      report_file_requested_at: context.report_file_requested_at,
      downloaded_at: context.downloaded_at,
      create_request: {
        manifest_schema_version: WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA,
        manifest_sha256: sha256Bytes(capture.createRequestBytes),
        manifest_byte_length: capture.createRequestBytes.byteLength,
        method: "POST",
        endpoint: "/v3/reports/reportRequests",
        report_type: REPORT_TYPE,
        report_version: "v6",
        content_type: "application/json",
        body_empty_object: true,
        unfiltered_full_report: true,
        account_scope_exact_match: true,
        request_correlation_id_sha256: context.request_correlations.create_sha256
      },
      create_response: {
        payload_sha256: sha256Bytes(capture.createResponseBytes),
        payload_byte_length: capture.createResponseBytes.byteLength,
        http_status: capture.createResponseHttp.status,
        http_content_type: capture.createResponseHttp.contentType,
        http_content_length: capture.createResponseHttp.contentLength,
        request_id_exact_match: true,
        request_submission_date_exact_match: true,
        trusted_exchange_policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
        trusted_exchange_sha256: context.trusted_exchange_seals.create_response_sha256,
        echoed_correlation_id_sha256: capture.createResponseHttp.echoedCorrelationIdSha256,
        echoed_report_request_id_sha256: capture.createResponseHttp.echoedReportRequestIdSha256
      },
      authority_evidence: {
        request_manifest_schema_version: WALMART_ITEM_REPORT_READY_REQUEST_MANIFEST_SCHEMA,
        request_manifest_sha256: sha256Bytes(capture.readyRequestBytes),
        request_manifest_byte_length: capture.readyRequestBytes.byteLength,
        method: "GET",
        endpoint: "/v3/reports/reportRequests/{requestId}",
        request_id_path_exact_match: true,
        account_scope_exact_match: true,
        request_correlation_id_sha256: context.request_correlations.ready_status_sha256,
        trusted_exchange_policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
        trusted_exchange_sha256: context.trusted_exchange_seals.ready_status_response_sha256,
        ready_status_payload_sha256: sha256Bytes(capture.statusBytes),
        ready_status_payload_byte_length: capture.statusBytes.byteLength,
        request_status: "READY",
        request_id_exact_match: true,
        report_type_exact_match: true,
        report_version_exact_match: true,
        http_status: capture.readyStatusHttp.status,
        http_content_type: capture.readyStatusHttp.contentType,
        http_content_length: capture.readyStatusHttp.contentLength,
        echoed_correlation_id_sha256: capture.readyStatusHttp.echoedCorrelationIdSha256,
        echoed_report_request_id_sha256: capture.readyStatusHttp.echoedReportRequestIdSha256
      },
      download_locator: {
        request_manifest_schema_version: WALMART_ITEM_REPORT_DOWNLOAD_LOCATOR_REQUEST_MANIFEST_SCHEMA,
        request_manifest_sha256: sha256Bytes(capture.downloadLocatorRequestBytes),
        request_manifest_byte_length: capture.downloadLocatorRequestBytes.byteLength,
        method: "GET",
        endpoint: "/v3/reports/downloadReport",
        request_id_exact_match: true,
        unfiltered_locator_request: true,
        account_scope_exact_match: true,
        request_correlation_id_sha256: context.request_correlations.download_locator_sha256,
        trusted_exchange_policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
        trusted_exchange_sha256: context.trusted_exchange_seals.download_locator_response_sha256,
        response_payload_sha256: sha256Bytes(capture.downloadLocatorResponseBytes),
        response_payload_byte_length: capture.downloadLocatorResponseBytes.byteLength,
        http_status: capture.downloadLocatorHttp.status,
        http_content_type: capture.downloadLocatorHttp.contentType,
        http_content_length: capture.downloadLocatorHttp.contentLength,
        download_url_sha256: fileRequest.initial.url_sha256,
        download_url_expiration_at: locator.expirationAt,
        echoed_correlation_id_sha256: capture.downloadLocatorHttp.echoedCorrelationIdSha256,
        echoed_report_request_id_sha256: capture.downloadLocatorHttp.echoedReportRequestIdSha256
      },
      report_file_request: {
        manifest_schema_version: WALMART_ITEM_REPORT_FILE_REQUEST_MANIFEST_SCHEMA,
        manifest_sha256: sha256Bytes(capture.reportFileRequestBytes),
        manifest_byte_length: capture.reportFileRequestBytes.byteLength,
        method: "GET",
        url_policy_id: WALMART_ITEM_REPORT_DOWNLOAD_URL_POLICY_ID,
        initial_url_sha256: fileRequest.initial.url_sha256,
        final_url_sha256: fileRequest.final.url_sha256,
        redirect_chain_sha256: fileRequest.redirectChainSha256,
        redirect_count: fileRequest.redirectCount,
        all_urls_policy_approved: true,
        locator_url_exact_match: true,
        account_scope_exact_match: true,
        request_correlation_id_sha256: context.request_correlations.report_file_sha256
      },
      download_transport: {
        bytes_sha256: sha256Bytes(capture.transportBytes),
        byte_length: capture.transportBytes.byteLength,
        http_content_type: capture.downloadHttp.contentType,
        http_content_length: capture.downloadHttp.contentLength,
        http_status: capture.downloadHttp.status,
        trusted_exchange_policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
        trusted_exchange_sha256: context.trusted_exchange_seals.download_response_sha256,
        echoed_correlation_id_sha256: capture.downloadHttp.echoedCorrelationIdSha256,
        echoed_report_request_id_sha256: capture.downloadHttp.echoedReportRequestIdSha256,
        detected_container: decoded.container,
        decoded_member_name: decoded.memberName
      },
      decoded_report: {
        bytes_sha256: sha256Bytes(decoded.reportBytes),
        byte_length: decoded.reportBytes.byteLength,
        text_encoding: TEXT_ENCODING,
        utf8_bom: parsed.utf8Bom,
        delimiter: parsed.delimiter,
        media_type: parsed.mediaType,
        line_ending: parsed.lineEnding,
        header: [...parsed.header],
        header_sha256: walmartItemReportSha256(parsed.header),
        header_mapping: { ...parsed.headerMapping },
        logical_record_count: dataCount + 1,
        data_record_count: dataCount
      }
    },
    status_semantics: fixedStatusSemantics(),
    reconciliation: {
      parsed_data_record_count: dataCount,
      included_published_count: includedCount,
      excluded_non_published_count: dataCount - includedCount,
      unique_published_listing_count: includedCount,
      output_row_count: includedCount,
      malformed_record_count: 0,
      duplicate_listing_key_count: 0,
      conflicting_listing_key_count: 0,
      published_status_counts: PUBLISHED_STATUSES.map((status) => ({
        status,
        count: publishedCounts.get(status) ?? 0
      })),
      lifecycle_status_counts: LIFECYCLE_STATUSES.map((status) => ({
        status,
        count: lifecycleCounts.get(status) ?? 0
      })),
      lifecycle_status_not_reported_count: lifecycleNotReportedCount
    },
    published_population_complete: true,
    rows
  };
}
function compileWalmartItemReportPublishedSource(captureInput, contextInput) {
  const capture = parseCapture(captureInput);
  const context = parseContext(contextInput);
  const body = compileBody(capture, context);
  const bodySha = walmartItemReportSha256(body);
  const source = {
    ...body,
    source_id: `walmart-item-report-published-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha
  };
  verifyWalmartItemReportPublishedSource(source);
  return source;
}
function parseCountArray(input, expectedStatuses, path7) {
  if (!Array.isArray(input) || input.length !== expectedStatuses.length) {
    throw new Error(`${path7} must contain exactly ${expectedStatuses.length} rows`);
  }
  return input.map((item, index) => {
    const row = asRecord(item, `${path7}[${index}]`);
    assertExactKeys3(row, ["status", "count"], `${path7}[${index}]`);
    if (row.status !== expectedStatuses[index]) throw new Error(`${path7}[${index}].status must be ${expectedStatuses[index]}`);
    return { status: expectedStatuses[index], count: nonNegativeInteger2(row.count, `${path7}[${index}].count`) };
  });
}
function parseHeaderMapping(input, header, reportVersion, path7) {
  const raw = asRecord(input, path7);
  const requiredRoles = Object.keys(REQUIRED_HEADER_ALIASES);
  const optionalRoles = Object.keys(OPTIONAL_HEADER_ALIASES);
  assertExactKeys3(raw, [...requiredRoles, ...optionalRoles], path7);
  const mapping = {};
  const used = [];
  for (const role of requiredRoles) {
    const index = nonNegativeInteger2(raw[role], `${path7}.${role}`);
    if (index >= header.length) throw new Error(`${path7}.${role} is outside the header`);
    const accepted = new Set(REQUIRED_HEADER_ALIASES[role].map(normalizeHeader));
    if (!accepted.has(normalizeHeader(header[index]))) throw new Error(`${path7}.${role} does not point at an accepted header`);
    mapping[role] = index;
    used.push(index);
  }
  for (const role of optionalRoles) {
    const value = raw[role];
    if (value === null) {
      mapping[role] = null;
      continue;
    }
    const index = nonNegativeInteger2(value, `${path7}.${role}`);
    if (index >= header.length) throw new Error(`${path7}.${role} is outside the header`);
    const accepted = new Set(OPTIONAL_HEADER_ALIASES[role].map(normalizeHeader));
    if (!accepted.has(normalizeHeader(header[index]))) throw new Error(`${path7}.${role} does not point at an accepted header`);
    mapping[role] = index;
    used.push(index);
  }
  const selfDescribingIdentifier = mapping.product_id === mapping.product_id_type && selfDescribingProductIdentifierType(header[mapping.product_id]) !== null;
  const expectedDistinctCount = selfDescribingIdentifier ? used.length - 1 : used.length;
  if (new Set(used).size !== expectedDistinctCount) {
    throw new Error(`${path7} roles must point at distinct columns except one self-describing UPC/GTIN identifier`);
  }
  if (reportVersion === "v6" && mapping.product_condition === null) {
    throw new Error(`${path7}.product_condition is required for reportVersion v6`);
  }
  return mapping;
}
function parsePublishedRow(input, index, accountScope, header, mapping) {
  const path7 = `source.rows[${index}]`;
  const raw = asRecord(input, path7);
  assertExactKeys3(raw, [
    "channel",
    "store_index",
    "sku",
    "listing_key",
    "reported_product_identifier_opaque",
    "reported_product_identifier_type_opaque",
    "reported_product_identifier_header",
    "reported_product_identifier_type_header",
    "reported_product_name",
    "reported_product_name_header",
    "reported_product_condition",
    "reported_product_condition_header",
    "reported_lifecycle_status",
    "reported_lifecycle_status_header",
    "reported_legacy_item_identifier_opaque",
    "reported_legacy_item_identifier_header",
    "reported_legacy_wpid_opaque",
    "reported_legacy_wpid_header",
    "published_status",
    "source_record_number",
    "source_record_sha256"
  ], path7);
  if (raw.channel !== CHANNEL || raw.channel !== accountScope.channel) throw new Error(`${path7}.channel must match account scope`);
  const storeIndex = positiveInteger3(raw.store_index, `${path7}.store_index`);
  if (storeIndex !== accountScope.store_index) throw new Error(`${path7}.store_index must match account scope`);
  const sku = exactString(raw.sku, `${path7}.sku`);
  const expectedKey = walmartListingKey(storeIndex, sku);
  if (raw.listing_key !== expectedKey) throw new Error(`${path7}.listing_key must be ${expectedKey}`);
  if (raw.published_status !== "PUBLISHED") throw new Error(`${path7}.published_status must be PUBLISHED`);
  const productIdentifier = exactString(
    raw.reported_product_identifier_opaque,
    `${path7}.reported_product_identifier_opaque`
  );
  const productIdentifierType = exactString(
    raw.reported_product_identifier_type_opaque,
    `${path7}.reported_product_identifier_type_opaque`
  );
  const productIdentifierHeader = exactString(
    raw.reported_product_identifier_header,
    `${path7}.reported_product_identifier_header`
  );
  const productIdentifierTypeHeader = exactString(
    raw.reported_product_identifier_type_header,
    `${path7}.reported_product_identifier_type_header`
  );
  const productName = exactText(raw.reported_product_name, `${path7}.reported_product_name`);
  const productNameHeader = exactString(raw.reported_product_name_header, `${path7}.reported_product_name_header`);
  if (productIdentifierHeader !== header[mapping.product_id] || productIdentifierTypeHeader !== header[mapping.product_id_type] || productNameHeader !== header[mapping.product_name]) {
    throw new Error(`${path7} documented product evidence headers do not match decoded header mapping`);
  }
  const selfDescribingType = mapping.product_id === mapping.product_id_type ? selfDescribingProductIdentifierType(productIdentifierHeader) : null;
  if (selfDescribingType !== null && productIdentifierType !== selfDescribingType) {
    throw new Error(`${path7}.reported_product_identifier_type_opaque must match its self-describing report header`);
  }
  const parseOptionalPair = (value, headerValue, mappingIndex, rolePath, allowNullWithPresentHeader = false) => {
    const parsedValue = value === null ? null : exactString(value, `${path7}.${rolePath}`);
    const parsedHeader = nullableHeaderString(headerValue, `${path7}.${rolePath}_header`);
    const expectedHeader = mappingIndex === null ? null : header[mappingIndex];
    if (parsedHeader !== expectedHeader || !allowNullWithPresentHeader && parsedValue === null !== (parsedHeader === null) || allowNullWithPresentHeader && parsedHeader === null && parsedValue !== null) {
      throw new Error(`${path7}.${rolePath} evidence/header does not match decoded header mapping`);
    }
    return { value: parsedValue, header: parsedHeader };
  };
  const condition = parseOptionalPair(
    raw.reported_product_condition,
    raw.reported_product_condition_header,
    mapping.product_condition,
    "reported_product_condition"
  );
  const lifecyclePair = parseOptionalPair(
    raw.reported_lifecycle_status,
    raw.reported_lifecycle_status_header,
    mapping.lifecycle_status,
    "reported_lifecycle_status",
    true
  );
  const lifecycle = lifecyclePair.value === null ? null : parseLifecycleStatus(lifecyclePair.value, `${path7}.reported_lifecycle_status`);
  const legacyItem = parseOptionalPair(
    raw.reported_legacy_item_identifier_opaque,
    raw.reported_legacy_item_identifier_header,
    mapping.legacy_item_id,
    "reported_legacy_item_identifier_opaque"
  );
  const legacyWpid = parseOptionalPair(
    raw.reported_legacy_wpid_opaque,
    raw.reported_legacy_wpid_header,
    mapping.legacy_wpid,
    "reported_legacy_wpid_opaque"
  );
  return {
    channel: CHANNEL,
    store_index: storeIndex,
    sku,
    listing_key: expectedKey,
    reported_product_identifier_opaque: productIdentifier,
    reported_product_identifier_type_opaque: productIdentifierType,
    reported_product_identifier_header: productIdentifierHeader,
    reported_product_identifier_type_header: productIdentifierTypeHeader,
    reported_product_name: productName,
    reported_product_name_header: productNameHeader,
    reported_product_condition: condition.value,
    reported_product_condition_header: condition.header,
    reported_lifecycle_status: lifecycle,
    reported_lifecycle_status_header: lifecyclePair.header,
    reported_legacy_item_identifier_opaque: legacyItem.value,
    reported_legacy_item_identifier_header: legacyItem.header,
    reported_legacy_wpid_opaque: legacyWpid.value,
    reported_legacy_wpid_header: legacyWpid.header,
    published_status: "PUBLISHED",
    source_record_number: positiveInteger3(raw.source_record_number, `${path7}.source_record_number`),
    source_record_sha256: sha256String2(raw.source_record_sha256, `${path7}.source_record_sha256`)
  };
}
function verifyWalmartItemReportPublishedSource(input) {
  const raw = asRecord(input, "source");
  assertExactKeys3(raw, [
    "schema_version",
    "account_scope",
    "report",
    "status_semantics",
    "reconciliation",
    "published_population_complete",
    "rows",
    "source_id",
    "body_sha256"
  ], "source");
  if (raw.schema_version !== WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA) {
    throw new Error(`source.schema_version must be ${WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA}`);
  }
  if (raw.published_population_complete !== true) {
    throw new Error("source.published_population_complete must be compiler-derived true");
  }
  const scope = asRecord(raw.account_scope, "source.account_scope");
  assertExactKeys3(scope, ["channel", "store_index", "seller_account_fingerprint_sha256"], "source.account_scope");
  if (scope.channel !== CHANNEL) throw new Error(`source.account_scope.channel must be ${CHANNEL}`);
  const accountScope = {
    channel: CHANNEL,
    store_index: positiveInteger3(scope.store_index, "source.account_scope.store_index"),
    seller_account_fingerprint_sha256: sha256String2(
      scope.seller_account_fingerprint_sha256,
      "source.account_scope.seller_account_fingerprint_sha256"
    )
  };
  const report = asRecord(raw.report, "source.report");
  assertExactKeys3(report, [
    "source_system",
    "report_type",
    "report_version",
    "report_request_id",
    "requested_at",
    "cutoff_at",
    "cutoff_basis",
    "ready_at",
    "download_locator_at",
    "report_file_requested_at",
    "downloaded_at",
    "create_request",
    "create_response",
    "authority_evidence",
    "download_locator",
    "report_file_request",
    "download_transport",
    "decoded_report"
  ], "source.report");
  if (report.source_system !== "walmart_marketplace_api") throw new Error("source.report.source_system is invalid");
  if (report.report_type !== REPORT_TYPE) throw new Error(`source.report.report_type must be ${REPORT_TYPE}`);
  if (report.report_version !== "v6") throw new Error("source.report.report_version must be v6 for complete population");
  const requestId = exactString(report.report_request_id, "source.report.report_request_id");
  const requestedAt = isoTimestamp(report.requested_at, "source.report.requested_at");
  const createRequest = asRecord(report.create_request, "source.report.create_request");
  const createResponse = asRecord(report.create_response, "source.report.create_response");
  const authority = asRecord(report.authority_evidence, "source.report.authority_evidence");
  const downloadLocator = asRecord(report.download_locator, "source.report.download_locator");
  const reportFileRequest = asRecord(report.report_file_request, "source.report.report_file_request");
  const transport = asRecord(report.download_transport, "source.report.download_transport");
  const context = parseContext({
    account_scope: accountScope,
    request_correlations: {
      create_sha256: createRequest.request_correlation_id_sha256,
      ready_status_sha256: authority.request_correlation_id_sha256,
      download_locator_sha256: downloadLocator.request_correlation_id_sha256,
      report_file_sha256: reportFileRequest.request_correlation_id_sha256
    },
    trusted_exchange_seals: {
      create_response_sha256: createResponse.trusted_exchange_sha256,
      ready_status_response_sha256: authority.trusted_exchange_sha256,
      download_locator_response_sha256: downloadLocator.trusted_exchange_sha256,
      download_response_sha256: transport.trusted_exchange_sha256
    },
    ready_at: report.ready_at,
    download_locator_at: report.download_locator_at,
    report_file_requested_at: report.report_file_requested_at,
    downloaded_at: report.downloaded_at
  });
  if (Date.parse(requestedAt) > Date.parse(context.ready_at)) {
    throw new Error("source.report.ready_at must be at or after requested_at");
  }
  const cutoffAt = isoTimestamp(report.cutoff_at, "source.report.cutoff_at");
  if (cutoffAt !== context.ready_at || report.cutoff_basis !== "READY_OBSERVED_UPPER_BOUND") {
    throw new Error("source.report cutoff must be the conservative READY-observed upper bound");
  }
  assertExactKeys3(createRequest, [
    "manifest_schema_version",
    "manifest_sha256",
    "manifest_byte_length",
    "method",
    "endpoint",
    "report_type",
    "report_version",
    "content_type",
    "body_empty_object",
    "unfiltered_full_report",
    "account_scope_exact_match",
    "request_correlation_id_sha256"
  ], "source.report.create_request");
  const createRequestSha = sha256String2(createRequest.manifest_sha256, "source.report.create_request.manifest_sha256");
  const createRequestLength = positiveInteger3(
    createRequest.manifest_byte_length,
    "source.report.create_request.manifest_byte_length"
  );
  if (createRequestLength > WALMART_ITEM_REPORT_LIMITS.max_create_request_bytes) {
    throw new Error("source.report.create_request exceeds request safety cap");
  }
  if (createRequest.manifest_schema_version !== WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA || createRequest.method !== "POST" || createRequest.endpoint !== "/v3/reports/reportRequests" || createRequest.report_type !== REPORT_TYPE || createRequest.report_version !== "v6" || createRequest.content_type !== "application/json" || createRequest.body_empty_object !== true || createRequest.unfiltered_full_report !== true || createRequest.account_scope_exact_match !== true || createRequest.request_correlation_id_sha256 !== context.request_correlations.create_sha256) {
    throw new Error("source.report.create_request must bind the full unfiltered ITEM v6 request");
  }
  assertExactKeys3(createResponse, [
    "payload_sha256",
    "payload_byte_length",
    "http_status",
    "http_content_type",
    "http_content_length",
    "request_id_exact_match",
    "request_submission_date_exact_match",
    "trusted_exchange_policy_id",
    "trusted_exchange_sha256",
    "echoed_correlation_id_sha256",
    "echoed_report_request_id_sha256"
  ], "source.report.create_response");
  const createResponseSha = sha256String2(createResponse.payload_sha256, "source.report.create_response.payload_sha256");
  const createResponseLength = positiveInteger3(
    createResponse.payload_byte_length,
    "source.report.create_response.payload_byte_length"
  );
  if (createResponseLength > WALMART_ITEM_REPORT_LIMITS.max_create_response_bytes) {
    throw new Error("source.report.create_response exceeds response safety cap");
  }
  const createResponseStatus = positiveInteger3(createResponse.http_status, "source.report.create_response.http_status");
  if (createResponseStatus !== 200 && createResponseStatus !== 201) {
    throw new Error("source.report.create_response.http_status must be 200 or 201");
  }
  const createResponseContentType = createResponse.http_content_type === null ? null : exactString(createResponse.http_content_type, "source.report.create_response.http_content_type");
  const createResponseContentLength = nullableNonNegativeInteger(
    createResponse.http_content_length,
    "source.report.create_response.http_content_length"
  );
  if (createResponseContentLength !== null && createResponseContentLength !== createResponseLength) {
    throw new Error("source.report.create_response HTTP/payload lengths do not match");
  }
  if (createResponse.request_id_exact_match !== true || createResponse.request_submission_date_exact_match !== true) {
    throw new Error("source.report.create_response must bind request ID and submission date");
  }
  if (createResponse.trusted_exchange_policy_id !== WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID || createResponse.trusted_exchange_sha256 !== context.trusted_exchange_seals.create_response_sha256) {
    throw new Error("source.report.create_response must bind the trusted atomic exchange seal");
  }
  const createResponseEchoCorrelation = nullableSha256String(
    createResponse.echoed_correlation_id_sha256,
    "source.report.create_response.echoed_correlation_id_sha256"
  );
  const createResponseEchoRequestId = nullableSha256String(
    createResponse.echoed_report_request_id_sha256,
    "source.report.create_response.echoed_report_request_id_sha256"
  );
  if (createResponseEchoCorrelation !== null && createResponseEchoCorrelation !== context.request_correlations.create_sha256) {
    throw new Error("source.report.create_response echoed correlation conflicts with request manifest");
  }
  if (createResponseEchoRequestId !== null && createResponseEchoRequestId !== walmartItemReportUtf8Sha256(requestId)) {
    throw new Error("source.report.create_response echoed report request ID conflicts with payload");
  }
  assertExactKeys3(authority, [
    "request_manifest_schema_version",
    "request_manifest_sha256",
    "request_manifest_byte_length",
    "method",
    "endpoint",
    "request_id_path_exact_match",
    "account_scope_exact_match",
    "request_correlation_id_sha256",
    "trusted_exchange_policy_id",
    "trusted_exchange_sha256",
    "ready_status_payload_sha256",
    "ready_status_payload_byte_length",
    "request_status",
    "request_id_exact_match",
    "report_type_exact_match",
    "report_version_exact_match",
    "http_status",
    "http_content_type",
    "http_content_length",
    "echoed_correlation_id_sha256",
    "echoed_report_request_id_sha256"
  ], "source.report.authority_evidence");
  const readyRequestManifestSha = sha256String2(
    authority.request_manifest_sha256,
    "source.report.authority_evidence.request_manifest_sha256"
  );
  const readyRequestManifestLength = positiveInteger3(
    authority.request_manifest_byte_length,
    "source.report.authority_evidence.request_manifest_byte_length"
  );
  if (readyRequestManifestLength > WALMART_ITEM_REPORT_LIMITS.max_ready_request_bytes) {
    throw new Error("source.report.authority_evidence READY request manifest exceeds safety cap");
  }
  if (authority.request_manifest_schema_version !== WALMART_ITEM_REPORT_READY_REQUEST_MANIFEST_SCHEMA || authority.method !== "GET" || authority.endpoint !== "/v3/reports/reportRequests/{requestId}" || authority.request_id_path_exact_match !== true || authority.account_scope_exact_match !== true || authority.request_correlation_id_sha256 !== context.request_correlations.ready_status_sha256) {
    throw new Error("source.report.authority_evidence must bind the exact scoped READY status GET");
  }
  if (authority.trusted_exchange_policy_id !== WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID || authority.trusted_exchange_sha256 !== context.trusted_exchange_seals.ready_status_response_sha256) {
    throw new Error("source.report.authority_evidence must bind the trusted atomic exchange seal");
  }
  const readyStatusSha = sha256String2(
    authority.ready_status_payload_sha256,
    "source.report.authority_evidence.ready_status_payload_sha256"
  );
  const readyStatusLength = positiveInteger3(
    authority.ready_status_payload_byte_length,
    "source.report.authority_evidence.ready_status_payload_byte_length"
  );
  if (readyStatusLength > WALMART_ITEM_REPORT_LIMITS.max_ready_status_bytes) {
    throw new Error("source.report.authority_evidence exceeds status safety cap");
  }
  if (authority.request_status !== "READY" || authority.request_id_exact_match !== true || authority.report_type_exact_match !== true || authority.report_version_exact_match !== true) {
    throw new Error("source.report.authority_evidence must bind exact READY/request/report evidence");
  }
  const readyHttpStatus = positiveInteger3(authority.http_status, "source.report.authority_evidence.http_status");
  if (readyHttpStatus !== 200) throw new Error("source.report.authority_evidence.http_status must be 200");
  const readyHttpContentType = authority.http_content_type === null ? null : exactString(authority.http_content_type, "source.report.authority_evidence.http_content_type");
  const readyHttpContentLength = nullableNonNegativeInteger(
    authority.http_content_length,
    "source.report.authority_evidence.http_content_length"
  );
  if (readyHttpContentLength !== null && readyHttpContentLength !== readyStatusLength) {
    throw new Error("source.report.authority_evidence HTTP/payload lengths do not match");
  }
  const readyEchoCorrelation = nullableSha256String(
    authority.echoed_correlation_id_sha256,
    "source.report.authority_evidence.echoed_correlation_id_sha256"
  );
  const readyEchoRequestId = nullableSha256String(
    authority.echoed_report_request_id_sha256,
    "source.report.authority_evidence.echoed_report_request_id_sha256"
  );
  if (readyEchoCorrelation !== null && readyEchoCorrelation !== context.request_correlations.ready_status_sha256) {
    throw new Error("source.report.authority_evidence echoed correlation conflicts with READY request manifest");
  }
  if (readyEchoRequestId !== null && readyEchoRequestId !== walmartItemReportUtf8Sha256(requestId)) {
    throw new Error("source.report.authority_evidence echoed report request ID conflicts with payload");
  }
  assertExactKeys3(downloadLocator, [
    "request_manifest_schema_version",
    "request_manifest_sha256",
    "request_manifest_byte_length",
    "method",
    "endpoint",
    "request_id_exact_match",
    "unfiltered_locator_request",
    "account_scope_exact_match",
    "request_correlation_id_sha256",
    "trusted_exchange_policy_id",
    "trusted_exchange_sha256",
    "response_payload_sha256",
    "response_payload_byte_length",
    "http_status",
    "http_content_type",
    "http_content_length",
    "download_url_sha256",
    "download_url_expiration_at",
    "echoed_correlation_id_sha256",
    "echoed_report_request_id_sha256"
  ], "source.report.download_locator");
  const locatorRequestManifestSha = sha256String2(
    downloadLocator.request_manifest_sha256,
    "source.report.download_locator.request_manifest_sha256"
  );
  const locatorRequestManifestLength = positiveInteger3(
    downloadLocator.request_manifest_byte_length,
    "source.report.download_locator.request_manifest_byte_length"
  );
  if (locatorRequestManifestLength > WALMART_ITEM_REPORT_LIMITS.max_download_locator_request_bytes) {
    throw new Error("source.report.download_locator request manifest exceeds safety cap");
  }
  if (downloadLocator.request_manifest_schema_version !== WALMART_ITEM_REPORT_DOWNLOAD_LOCATOR_REQUEST_MANIFEST_SCHEMA || downloadLocator.method !== "GET" || downloadLocator.endpoint !== "/v3/reports/downloadReport" || downloadLocator.request_id_exact_match !== true || downloadLocator.unfiltered_locator_request !== true || downloadLocator.account_scope_exact_match !== true || downloadLocator.request_correlation_id_sha256 !== context.request_correlations.download_locator_sha256) {
    throw new Error("source.report.download_locator must bind the exact scoped unfiltered locator GET");
  }
  if (downloadLocator.trusted_exchange_policy_id !== WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID || downloadLocator.trusted_exchange_sha256 !== context.trusted_exchange_seals.download_locator_response_sha256) {
    throw new Error("source.report.download_locator must bind the trusted atomic exchange seal");
  }
  const locatorResponseSha = sha256String2(
    downloadLocator.response_payload_sha256,
    "source.report.download_locator.response_payload_sha256"
  );
  const locatorResponseLength = positiveInteger3(
    downloadLocator.response_payload_byte_length,
    "source.report.download_locator.response_payload_byte_length"
  );
  if (locatorResponseLength > WALMART_ITEM_REPORT_LIMITS.max_download_locator_response_bytes) {
    throw new Error("source.report.download_locator response exceeds safety cap");
  }
  const locatorHttpStatus = positiveInteger3(downloadLocator.http_status, "source.report.download_locator.http_status");
  if (locatorHttpStatus !== 200) throw new Error("source.report.download_locator.http_status must be 200");
  const locatorHttpContentType = downloadLocator.http_content_type === null ? null : exactString(downloadLocator.http_content_type, "source.report.download_locator.http_content_type");
  const locatorHttpContentLength = nullableNonNegativeInteger(
    downloadLocator.http_content_length,
    "source.report.download_locator.http_content_length"
  );
  if (locatorHttpContentLength !== null && locatorHttpContentLength !== locatorResponseLength) {
    throw new Error("source.report.download_locator HTTP/payload lengths do not match");
  }
  const locatorUrlSha = sha256String2(
    downloadLocator.download_url_sha256,
    "source.report.download_locator.download_url_sha256"
  );
  const locatorExpirationAt = isoTimestamp(
    downloadLocator.download_url_expiration_at,
    "source.report.download_locator.download_url_expiration_at"
  );
  if (Date.parse(locatorExpirationAt) < Date.parse(context.downloaded_at)) {
    throw new Error("source.report.download_locator URL expiration must cover downloaded_at");
  }
  const locatorEchoCorrelation = nullableSha256String(
    downloadLocator.echoed_correlation_id_sha256,
    "source.report.download_locator.echoed_correlation_id_sha256"
  );
  const locatorEchoRequestId = nullableSha256String(
    downloadLocator.echoed_report_request_id_sha256,
    "source.report.download_locator.echoed_report_request_id_sha256"
  );
  if (locatorEchoCorrelation !== null && locatorEchoCorrelation !== context.request_correlations.download_locator_sha256) {
    throw new Error("source.report.download_locator echoed correlation conflicts with request manifest");
  }
  if (locatorEchoRequestId !== null && locatorEchoRequestId !== walmartItemReportUtf8Sha256(requestId)) {
    throw new Error("source.report.download_locator echoed report request ID conflicts with payload");
  }
  assertExactKeys3(reportFileRequest, [
    "manifest_schema_version",
    "manifest_sha256",
    "manifest_byte_length",
    "method",
    "url_policy_id",
    "initial_url_sha256",
    "final_url_sha256",
    "redirect_chain_sha256",
    "redirect_count",
    "all_urls_policy_approved",
    "locator_url_exact_match",
    "account_scope_exact_match",
    "request_correlation_id_sha256"
  ], "source.report.report_file_request");
  const fileRequestManifestSha = sha256String2(
    reportFileRequest.manifest_sha256,
    "source.report.report_file_request.manifest_sha256"
  );
  const fileRequestManifestLength = positiveInteger3(
    reportFileRequest.manifest_byte_length,
    "source.report.report_file_request.manifest_byte_length"
  );
  if (fileRequestManifestLength > WALMART_ITEM_REPORT_LIMITS.max_report_file_request_bytes) {
    throw new Error("source.report.report_file_request manifest exceeds safety cap");
  }
  const fileInitialUrlSha = sha256String2(
    reportFileRequest.initial_url_sha256,
    "source.report.report_file_request.initial_url_sha256"
  );
  const fileFinalUrlSha = sha256String2(
    reportFileRequest.final_url_sha256,
    "source.report.report_file_request.final_url_sha256"
  );
  const redirectChainSha = sha256String2(
    reportFileRequest.redirect_chain_sha256,
    "source.report.report_file_request.redirect_chain_sha256"
  );
  const redirectCount = nonNegativeInteger2(
    reportFileRequest.redirect_count,
    "source.report.report_file_request.redirect_count"
  );
  if (redirectCount > WALMART_ITEM_REPORT_LIMITS.max_redirects) {
    throw new Error("source.report.report_file_request redirect_count exceeds safety cap");
  }
  if (reportFileRequest.manifest_schema_version !== WALMART_ITEM_REPORT_FILE_REQUEST_MANIFEST_SCHEMA || reportFileRequest.method !== "GET" || reportFileRequest.url_policy_id !== WALMART_ITEM_REPORT_DOWNLOAD_URL_POLICY_ID || reportFileRequest.all_urls_policy_approved !== true || reportFileRequest.locator_url_exact_match !== true || reportFileRequest.account_scope_exact_match !== true || reportFileRequest.request_correlation_id_sha256 !== context.request_correlations.report_file_sha256 || fileInitialUrlSha !== locatorUrlSha) {
    throw new Error("source.report.report_file_request must bind the exact scoped approved locator URL chain");
  }
  assertExactKeys3(transport, [
    "bytes_sha256",
    "byte_length",
    "http_content_type",
    "http_content_length",
    "http_status",
    "trusted_exchange_policy_id",
    "trusted_exchange_sha256",
    "echoed_correlation_id_sha256",
    "echoed_report_request_id_sha256",
    "detected_container",
    "decoded_member_name"
  ], "source.report.download_transport");
  const transportSha = sha256String2(transport.bytes_sha256, "source.report.download_transport.bytes_sha256");
  const transportLength = positiveInteger3(transport.byte_length, "source.report.download_transport.byte_length");
  if (transportLength > WALMART_ITEM_REPORT_LIMITS.max_transport_bytes) {
    throw new Error("source.report.download_transport exceeds transport safety cap");
  }
  const httpContentType = transport.http_content_type === null ? null : exactString(transport.http_content_type, "source.report.download_transport.http_content_type");
  const httpContentLength = nullableNonNegativeInteger(
    transport.http_content_length,
    "source.report.download_transport.http_content_length"
  );
  if (httpContentLength !== null && httpContentLength !== transportLength) {
    throw new Error("source.report.download_transport HTTP/observed lengths do not match");
  }
  const downloadHttpStatus = positiveInteger3(transport.http_status, "source.report.download_transport.http_status");
  if (downloadHttpStatus !== 200) throw new Error("source.report.download_transport.http_status must be 200");
  if (transport.trusted_exchange_policy_id !== WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID || transport.trusted_exchange_sha256 !== context.trusted_exchange_seals.download_response_sha256) {
    throw new Error("source.report.download_transport must bind the trusted atomic exchange seal");
  }
  const downloadEchoCorrelation = nullableSha256String(
    transport.echoed_correlation_id_sha256,
    "source.report.download_transport.echoed_correlation_id_sha256"
  );
  const downloadEchoRequestId = nullableSha256String(
    transport.echoed_report_request_id_sha256,
    "source.report.download_transport.echoed_report_request_id_sha256"
  );
  if (downloadEchoCorrelation !== null && downloadEchoCorrelation !== context.request_correlations.report_file_sha256) {
    throw new Error("source.report.download_transport echoed correlation conflicts with file request manifest");
  }
  if (downloadEchoRequestId !== null && downloadEchoRequestId !== walmartItemReportUtf8Sha256(requestId)) {
    throw new Error("source.report.download_transport echoed report request ID conflicts with payload");
  }
  if (!(transport.detected_container === "plain" || transport.detected_container === "gzip" || transport.detected_container === "zip")) {
    throw new Error("source.report.download_transport.detected_container is invalid");
  }
  const memberName = transport.decoded_member_name === null ? null : exactText(transport.decoded_member_name, "source.report.download_transport.decoded_member_name");
  if (transport.detected_container === "zip" !== (memberName !== null)) {
    throw new Error("source.report.download_transport ZIP/member metadata is inconsistent");
  }
  const decoded = asRecord(report.decoded_report, "source.report.decoded_report");
  assertExactKeys3(decoded, [
    "bytes_sha256",
    "byte_length",
    "text_encoding",
    "utf8_bom",
    "delimiter",
    "media_type",
    "line_ending",
    "header",
    "header_sha256",
    "header_mapping",
    "logical_record_count",
    "data_record_count"
  ], "source.report.decoded_report");
  const decodedSha = sha256String2(decoded.bytes_sha256, "source.report.decoded_report.bytes_sha256");
  const decodedLength = positiveInteger3(decoded.byte_length, "source.report.decoded_report.byte_length");
  if (decodedLength > WALMART_ITEM_REPORT_LIMITS.max_decoded_report_bytes) {
    throw new Error("source.report.decoded_report exceeds decoded-report safety cap");
  }
  if (transport.detected_container !== "plain" && decodedLength > Math.max(1, transportLength) * WALMART_ITEM_REPORT_LIMITS.max_compression_ratio) {
    throw new Error("source.report decoded/transport compression ratio exceeds safety cap");
  }
  if (transport.detected_container === "plain" && (decodedLength !== transportLength || decodedSha !== transportSha)) {
    throw new Error("source.report plain transport must exactly equal decoded report bytes");
  }
  if (decoded.text_encoding !== TEXT_ENCODING) throw new Error(`source.report.decoded_report.text_encoding must be ${TEXT_ENCODING}`);
  if (typeof decoded.utf8_bom !== "boolean") throw new Error("source.report.decoded_report.utf8_bom must be boolean");
  if (decoded.delimiter !== "," && decoded.delimiter !== "	") {
    throw new Error("source.report.decoded_report.delimiter must be comma or tab");
  }
  const expectedMedia = decoded.delimiter === "," ? "text/csv" : "text/tab-separated-values";
  if (decoded.media_type !== expectedMedia) throw new Error("source.report.decoded_report.media_type does not match delimiter");
  if (!(decoded.line_ending === "LF" || decoded.line_ending === "CRLF" || decoded.line_ending === "MIXED" || decoded.line_ending === "NONE")) {
    throw new Error("source.report.decoded_report.line_ending is invalid");
  }
  if (!Array.isArray(decoded.header) || decoded.header.length === 0) {
    throw new Error("source.report.decoded_report.header must be a non-empty array");
  }
  if (decoded.header.length > WALMART_ITEM_REPORT_LIMITS.max_columns) {
    throw new Error("source.report.decoded_report.header exceeds column-count safety cap");
  }
  const header = decoded.header.map((value, index) => exactString(value, `source.report.decoded_report.header[${index}]`));
  const normalizedHeader = header.map(normalizeHeader);
  if (new Set(normalizedHeader).size !== header.length) throw new Error("source.report.decoded_report.header has duplicates");
  const headerSha = sha256String2(decoded.header_sha256, "source.report.decoded_report.header_sha256");
  if (headerSha !== walmartItemReportSha256(header)) throw new Error("source.report.decoded_report.header_sha256 mismatch");
  const headerMapping = parseHeaderMapping(
    decoded.header_mapping,
    header,
    "v6",
    "source.report.decoded_report.header_mapping"
  );
  const logicalRecords = positiveInteger3(decoded.logical_record_count, "source.report.decoded_report.logical_record_count");
  const dataRecords = positiveInteger3(decoded.data_record_count, "source.report.decoded_report.data_record_count");
  if (logicalRecords > WALMART_ITEM_REPORT_LIMITS.max_logical_records) {
    throw new Error("source.report.decoded_report exceeds logical-record safety cap");
  }
  if (logicalRecords !== dataRecords + 1) throw new Error("source.report.decoded_report record counts do not reconcile");
  const semantics = asRecord(raw.status_semantics, "source.status_semantics");
  assertExactKeys3(semantics, [
    "policy_id",
    "accepted_published_statuses",
    "accepted_lifecycle_statuses",
    "inclusion_rule",
    "lifecycle_status_role"
  ], "source.status_semantics");
  if (canonicalWalmartItemReportJson(semantics) !== canonicalWalmartItemReportJson(fixedStatusSemantics())) {
    throw new Error("source.status_semantics does not match the frozen policy");
  }
  const reconciliation = asRecord(raw.reconciliation, "source.reconciliation");
  assertExactKeys3(reconciliation, [
    "parsed_data_record_count",
    "included_published_count",
    "excluded_non_published_count",
    "unique_published_listing_count",
    "output_row_count",
    "malformed_record_count",
    "duplicate_listing_key_count",
    "conflicting_listing_key_count",
    "published_status_counts",
    "lifecycle_status_counts",
    "lifecycle_status_not_reported_count"
  ], "source.reconciliation");
  const parsedCount = positiveInteger3(reconciliation.parsed_data_record_count, "source.reconciliation.parsed_data_record_count");
  const includedCount = nonNegativeInteger2(reconciliation.included_published_count, "source.reconciliation.included_published_count");
  const excludedCount = nonNegativeInteger2(reconciliation.excluded_non_published_count, "source.reconciliation.excluded_non_published_count");
  const uniqueCount = nonNegativeInteger2(reconciliation.unique_published_listing_count, "source.reconciliation.unique_published_listing_count");
  const outputCount = nonNegativeInteger2(reconciliation.output_row_count, "source.reconciliation.output_row_count");
  for (const field of ["malformed_record_count", "duplicate_listing_key_count", "conflicting_listing_key_count"]) {
    if (reconciliation[field] !== 0) throw new Error(`source.reconciliation.${field} must be zero`);
  }
  const publishedStatusCounts = parseCountArray(
    reconciliation.published_status_counts,
    PUBLISHED_STATUSES,
    "source.reconciliation.published_status_counts"
  );
  const lifecycleStatusCounts = parseCountArray(
    reconciliation.lifecycle_status_counts,
    LIFECYCLE_STATUSES,
    "source.reconciliation.lifecycle_status_counts"
  );
  const lifecycleNotReportedCount = nonNegativeInteger2(
    reconciliation.lifecycle_status_not_reported_count,
    "source.reconciliation.lifecycle_status_not_reported_count"
  );
  if (!Array.isArray(raw.rows)) throw new Error("source.rows must be an array");
  const rows = raw.rows.map((row, index) => parsePublishedRow(row, index, accountScope, header, headerMapping));
  const listingKeys = rows.map((row) => row.listing_key);
  const sortedListingKeys = [...listingKeys].sort(compareCodeUnits);
  if (canonicalWalmartItemReportJson(listingKeys) !== canonicalWalmartItemReportJson(sortedListingKeys)) {
    throw new Error("source.rows must be sorted by listing_key using code-unit order");
  }
  if (new Set(listingKeys).size !== rows.length) throw new Error("source.rows has duplicate listing_key values");
  if (new Set(rows.map((row) => row.source_record_number)).size !== rows.length) {
    throw new Error("source.rows has duplicate source_record_number values");
  }
  if (rows.some((row) => row.source_record_number < 2 || row.source_record_number > logicalRecords)) {
    throw new Error("source.rows references a record outside the decoded report");
  }
  const sum = (values, getter) => values.reduce((total, value) => total + getter(value), 0);
  if (parsedCount !== dataRecords || parsedCount !== includedCount + excludedCount) {
    throw new Error("source.reconciliation parsed/included/excluded counts do not reconcile");
  }
  if (sum(publishedStatusCounts, (item) => item.count) !== parsedCount || sum(lifecycleStatusCounts, (item) => item.count) + lifecycleNotReportedCount !== parsedCount) {
    throw new Error("source.reconciliation status counts do not reconcile");
  }
  if (headerMapping.lifecycle_status === null && lifecycleNotReportedCount !== parsedCount) {
    throw new Error("source.reconciliation missing lifecycle count does not match absent header");
  }
  if (includedCount !== publishedStatusCounts[0].count || includedCount !== rows.length || uniqueCount !== rows.length || outputCount !== rows.length) {
    throw new Error("source.reconciliation output counts do not reconcile with rows");
  }
  const parsed = {
    schema_version: WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA,
    account_scope: accountScope,
    report: {
      source_system: "walmart_marketplace_api",
      report_type: REPORT_TYPE,
      report_version: "v6",
      report_request_id: requestId,
      requested_at: requestedAt,
      cutoff_at: context.ready_at,
      cutoff_basis: "READY_OBSERVED_UPPER_BOUND",
      ready_at: context.ready_at,
      download_locator_at: context.download_locator_at,
      report_file_requested_at: context.report_file_requested_at,
      downloaded_at: context.downloaded_at,
      create_request: {
        manifest_schema_version: WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA,
        manifest_sha256: createRequestSha,
        manifest_byte_length: createRequestLength,
        method: "POST",
        endpoint: "/v3/reports/reportRequests",
        report_type: REPORT_TYPE,
        report_version: "v6",
        content_type: "application/json",
        body_empty_object: true,
        unfiltered_full_report: true,
        account_scope_exact_match: true,
        request_correlation_id_sha256: context.request_correlations.create_sha256
      },
      create_response: {
        payload_sha256: createResponseSha,
        payload_byte_length: createResponseLength,
        http_status: createResponseStatus,
        http_content_type: createResponseContentType,
        http_content_length: createResponseContentLength,
        request_id_exact_match: true,
        request_submission_date_exact_match: true,
        trusted_exchange_policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
        trusted_exchange_sha256: context.trusted_exchange_seals.create_response_sha256,
        echoed_correlation_id_sha256: createResponseEchoCorrelation,
        echoed_report_request_id_sha256: createResponseEchoRequestId
      },
      authority_evidence: {
        request_manifest_schema_version: WALMART_ITEM_REPORT_READY_REQUEST_MANIFEST_SCHEMA,
        request_manifest_sha256: readyRequestManifestSha,
        request_manifest_byte_length: readyRequestManifestLength,
        method: "GET",
        endpoint: "/v3/reports/reportRequests/{requestId}",
        request_id_path_exact_match: true,
        account_scope_exact_match: true,
        request_correlation_id_sha256: context.request_correlations.ready_status_sha256,
        trusted_exchange_policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
        trusted_exchange_sha256: context.trusted_exchange_seals.ready_status_response_sha256,
        ready_status_payload_sha256: readyStatusSha,
        ready_status_payload_byte_length: readyStatusLength,
        request_status: "READY",
        request_id_exact_match: true,
        report_type_exact_match: true,
        report_version_exact_match: true,
        http_status: readyHttpStatus,
        http_content_type: readyHttpContentType,
        http_content_length: readyHttpContentLength,
        echoed_correlation_id_sha256: readyEchoCorrelation,
        echoed_report_request_id_sha256: readyEchoRequestId
      },
      download_locator: {
        request_manifest_schema_version: WALMART_ITEM_REPORT_DOWNLOAD_LOCATOR_REQUEST_MANIFEST_SCHEMA,
        request_manifest_sha256: locatorRequestManifestSha,
        request_manifest_byte_length: locatorRequestManifestLength,
        method: "GET",
        endpoint: "/v3/reports/downloadReport",
        request_id_exact_match: true,
        unfiltered_locator_request: true,
        account_scope_exact_match: true,
        request_correlation_id_sha256: context.request_correlations.download_locator_sha256,
        trusted_exchange_policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
        trusted_exchange_sha256: context.trusted_exchange_seals.download_locator_response_sha256,
        response_payload_sha256: locatorResponseSha,
        response_payload_byte_length: locatorResponseLength,
        http_status: locatorHttpStatus,
        http_content_type: locatorHttpContentType,
        http_content_length: locatorHttpContentLength,
        download_url_sha256: locatorUrlSha,
        download_url_expiration_at: locatorExpirationAt,
        echoed_correlation_id_sha256: locatorEchoCorrelation,
        echoed_report_request_id_sha256: locatorEchoRequestId
      },
      report_file_request: {
        manifest_schema_version: WALMART_ITEM_REPORT_FILE_REQUEST_MANIFEST_SCHEMA,
        manifest_sha256: fileRequestManifestSha,
        manifest_byte_length: fileRequestManifestLength,
        method: "GET",
        url_policy_id: WALMART_ITEM_REPORT_DOWNLOAD_URL_POLICY_ID,
        initial_url_sha256: fileInitialUrlSha,
        final_url_sha256: fileFinalUrlSha,
        redirect_chain_sha256: redirectChainSha,
        redirect_count: redirectCount,
        all_urls_policy_approved: true,
        locator_url_exact_match: true,
        account_scope_exact_match: true,
        request_correlation_id_sha256: context.request_correlations.report_file_sha256
      },
      download_transport: {
        bytes_sha256: transportSha,
        byte_length: transportLength,
        http_content_type: httpContentType,
        http_content_length: httpContentLength,
        http_status: downloadHttpStatus,
        trusted_exchange_policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
        trusted_exchange_sha256: context.trusted_exchange_seals.download_response_sha256,
        echoed_correlation_id_sha256: downloadEchoCorrelation,
        echoed_report_request_id_sha256: downloadEchoRequestId,
        detected_container: transport.detected_container,
        decoded_member_name: memberName
      },
      decoded_report: {
        bytes_sha256: decodedSha,
        byte_length: decodedLength,
        text_encoding: TEXT_ENCODING,
        utf8_bom: decoded.utf8_bom,
        delimiter: decoded.delimiter,
        media_type: expectedMedia,
        line_ending: decoded.line_ending,
        header,
        header_sha256: headerSha,
        header_mapping: headerMapping,
        logical_record_count: logicalRecords,
        data_record_count: dataRecords
      }
    },
    status_semantics: fixedStatusSemantics(),
    reconciliation: {
      parsed_data_record_count: parsedCount,
      included_published_count: includedCount,
      excluded_non_published_count: excludedCount,
      unique_published_listing_count: uniqueCount,
      output_row_count: outputCount,
      malformed_record_count: 0,
      duplicate_listing_key_count: 0,
      conflicting_listing_key_count: 0,
      published_status_counts: publishedStatusCounts,
      lifecycle_status_counts: lifecycleStatusCounts,
      lifecycle_status_not_reported_count: lifecycleNotReportedCount
    },
    published_population_complete: true,
    rows,
    source_id: exactString(raw.source_id, "source.source_id"),
    body_sha256: sha256String2(raw.body_sha256, "source.body_sha256")
  };
  const body = structuredClone(parsed);
  delete body.source_id;
  delete body.body_sha256;
  const expectedBodySha = walmartItemReportSha256(body);
  if (parsed.body_sha256 !== expectedBodySha) throw new Error("source.body_sha256 mismatch");
  const expectedSourceId = `walmart-item-report-published-${expectedBodySha.slice(0, 16)}`;
  if (parsed.source_id !== expectedSourceId) throw new Error(`source.source_id must be ${expectedSourceId}`);
  return parsed;
}
function verifyWalmartItemReportPublishedSourceAgainstCapture(input, captureInput, trustedContextInput) {
  const verified = verifyWalmartItemReportPublishedSource(input);
  const rebuilt = compileWalmartItemReportPublishedSource(captureInput, trustedContextInput);
  if (canonicalWalmartItemReportJson(verified) !== canonicalWalmartItemReportJson(rebuilt)) {
    throw new Error("source does not exactly recompile from the trusted ITEM report capture and context");
  }
  return verified;
}
var WALMART_ITEM_REPORT_SHADOW_PUBLISHED_SOURCE_SCHEMA = "walmart-shadow-published-catalog-source/v2";
function compileWalmartShadowPublishedCatalogSourceFromItemReport(upstreamInput) {
  const upstream = verifyWalmartItemReportPublishedSource(upstreamInput);
  const body = {
    schema_version: WALMART_ITEM_REPORT_SHADOW_PUBLISHED_SOURCE_SCHEMA,
    captured_at: upstream.report.cutoff_at,
    channel: CHANNEL,
    published_population_complete: true,
    source_artifact: {
      schema_version: WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA,
      source_id: upstream.source_id,
      body_sha256: upstream.body_sha256,
      raw_transport_sha256: upstream.report.download_transport.bytes_sha256,
      decoded_report_sha256: upstream.report.decoded_report.bytes_sha256,
      cutoff_at: upstream.report.cutoff_at
    },
    rows: upstream.rows.map((row) => ({
      channel: CHANNEL,
      store_index: row.store_index,
      sku: row.sku,
      listing_key: row.listing_key,
      published_status: "PUBLISHED"
    }))
  };
  const bodySha = walmartItemReportSha256(body);
  return {
    ...body,
    snapshot_id: `walmart-shadow-catalog-${bodySha.slice(0, 16)}`,
    body_sha256: bodySha
  };
}
function verifyWalmartShadowPublishedCatalogSource(input) {
  const raw = asRecord(input, "shadow published source");
  assertExactKeys3(raw, [
    "schema_version",
    "snapshot_id",
    "body_sha256",
    "captured_at",
    "channel",
    "published_population_complete",
    "source_artifact",
    "rows"
  ], "shadow published source");
  if (raw.schema_version !== WALMART_ITEM_REPORT_SHADOW_PUBLISHED_SOURCE_SCHEMA) {
    throw new Error(`shadow published source.schema_version must be ${WALMART_ITEM_REPORT_SHADOW_PUBLISHED_SOURCE_SCHEMA}`);
  }
  if (raw.channel !== CHANNEL || raw.published_population_complete !== true) {
    throw new Error("shadow published source scope/completeness is invalid");
  }
  const capturedAt = isoTimestamp(raw.captured_at, "shadow published source.captured_at");
  const binding2 = asRecord(raw.source_artifact, "shadow published source.source_artifact");
  assertExactKeys3(binding2, [
    "schema_version",
    "source_id",
    "body_sha256",
    "raw_transport_sha256",
    "decoded_report_sha256",
    "cutoff_at"
  ], "shadow published source.source_artifact");
  if (binding2.schema_version !== WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA) {
    throw new Error("shadow published source.source_artifact schema is invalid");
  }
  const cutoffAt = isoTimestamp(binding2.cutoff_at, "shadow published source.source_artifact.cutoff_at");
  if (capturedAt !== cutoffAt) throw new Error("shadow published source captured_at must equal source cutoff_at");
  if (!Array.isArray(raw.rows)) throw new Error("shadow published source.rows must be an array");
  const rows = raw.rows.map((inputRow, index) => {
    const path7 = `shadow published source.rows[${index}]`;
    const row = asRecord(inputRow, path7);
    assertExactKeys3(row, ["channel", "store_index", "sku", "listing_key", "published_status"], path7);
    if (row.channel !== CHANNEL || row.published_status !== "PUBLISHED") throw new Error(`${path7} scope/status is invalid`);
    const storeIndex = positiveInteger3(row.store_index, `${path7}.store_index`);
    const sku = exactString(row.sku, `${path7}.sku`);
    const listingKey = walmartListingKey(storeIndex, sku);
    if (row.listing_key !== listingKey) throw new Error(`${path7}.listing_key is invalid`);
    return { channel: CHANNEL, store_index: storeIndex, sku, listing_key: listingKey, published_status: "PUBLISHED" };
  });
  const keys = rows.map((row) => row.listing_key);
  if (new Set(keys).size !== keys.length || canonicalWalmartItemReportJson(keys) !== canonicalWalmartItemReportJson([...keys].sort(compareCodeUnits))) {
    throw new Error("shadow published source.rows must be unique and canonically sorted");
  }
  const parsed = {
    schema_version: WALMART_ITEM_REPORT_SHADOW_PUBLISHED_SOURCE_SCHEMA,
    snapshot_id: exactString(raw.snapshot_id, "shadow published source.snapshot_id"),
    body_sha256: sha256String2(raw.body_sha256, "shadow published source.body_sha256"),
    captured_at: capturedAt,
    channel: CHANNEL,
    published_population_complete: true,
    source_artifact: {
      schema_version: WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA,
      source_id: exactString(binding2.source_id, "shadow published source.source_artifact.source_id"),
      body_sha256: sha256String2(binding2.body_sha256, "shadow published source.source_artifact.body_sha256"),
      raw_transport_sha256: sha256String2(
        binding2.raw_transport_sha256,
        "shadow published source.source_artifact.raw_transport_sha256"
      ),
      decoded_report_sha256: sha256String2(
        binding2.decoded_report_sha256,
        "shadow published source.source_artifact.decoded_report_sha256"
      ),
      cutoff_at: cutoffAt
    },
    rows
  };
  const body = structuredClone(parsed);
  delete body.snapshot_id;
  delete body.body_sha256;
  const bodySha = walmartItemReportSha256(body);
  if (parsed.body_sha256 !== bodySha) throw new Error("shadow published source.body_sha256 mismatch");
  const snapshotId = `walmart-shadow-catalog-${bodySha.slice(0, 16)}`;
  if (parsed.snapshot_id !== snapshotId) throw new Error(`shadow published source.snapshot_id must be ${snapshotId}`);
  return parsed;
}
function verifyWalmartShadowPublishedCatalogSourceAgainstItemReportCapture(bridgeInput, upstreamInput, captureInput, trustedContextInput) {
  const bridge = verifyWalmartShadowPublishedCatalogSource(bridgeInput);
  const upstream = verifyWalmartItemReportPublishedSourceAgainstCapture(
    upstreamInput,
    captureInput,
    trustedContextInput
  );
  const rebuilt = compileWalmartShadowPublishedCatalogSourceFromItemReport(upstream);
  if (canonicalWalmartItemReportJson(bridge) !== canonicalWalmartItemReportJson(rebuilt)) {
    throw new Error("shadow published source does not exactly rebuild from the source-verified ITEM report");
  }
  return bridge;
}
function fixedCatalogStatusSemantics() {
  return {
    policy_id: WALMART_ITEM_REPORT_CATALOG_STATUS_POLICY,
    included_published_statuses: [...PUBLISHED_STATUSES],
    accepted_lifecycle_statuses: [...LIFECYCLE_STATUSES],
    inclusion_rule: "ALL_REPORT_ROWS",
    lifecycle_status_role: "OPTIONAL_EVIDENCE_ONLY"
  };
}
function findCatalogBrandIndex(header) {
  const accepted = normalizeHeader("Brand");
  const matches = header.map((value, index) => ({ value: normalizeHeader(value), index })).filter(({ value }) => value === accepted).map(({ index }) => index);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0 ? "ITEM v6 catalog source is missing required Brand column" : `ITEM v6 catalog source has ambiguous Brand columns at indexes ${matches.join(", ")}`
    );
  }
  return matches[0];
}
function optionalCatalogCell(record7, index, path7) {
  if (index === null || record7[index] === "") return null;
  return exactString(record7[index], path7);
}
function compileCatalogRow(reportRecord, parsed, brandIndex, accountScope) {
  const recordPath = `ITEM report record ${reportRecord.sourceRecordNumber}`;
  const cells = reportRecord.cells;
  const sku = exactString(cells[parsed.headerMapping.sku], `${recordPath}.sku`);
  const publishedStatus = parsePublishedStatus(
    cells[parsed.headerMapping.published_status],
    `${recordPath}.published_status`
  );
  const lifecycleStatus = parsed.headerMapping.lifecycle_status === null ? null : parseOptionalLifecycleStatus(
    cells[parsed.headerMapping.lifecycle_status],
    `${recordPath}.lifecycle_status`
  );
  const productCondition = optionalCatalogCell(
    cells,
    parsed.headerMapping.product_condition,
    `${recordPath}.product_condition`
  );
  const productIdentifier = productIdentifierEvidence(
    cells,
    parsed.header,
    parsed.headerMapping,
    recordPath
  );
  return {
    channel: CHANNEL,
    store_index: accountScope.store_index,
    sku,
    listing_key: walmartListingKey(accountScope.store_index, sku),
    reported_product_identifier_opaque: productIdentifier.identifier,
    reported_product_identifier_type_opaque: productIdentifier.identifierType,
    reported_product_identifier_header: productIdentifier.identifierHeader,
    reported_product_identifier_type_header: productIdentifier.identifierTypeHeader,
    reported_product_name: exactText(
      cells[parsed.headerMapping.product_name],
      `${recordPath}.product_name`
    ),
    reported_product_name_header: parsed.header[parsed.headerMapping.product_name],
    reported_brand: cells[brandIndex] === "" ? null : exactText(cells[brandIndex], `${recordPath}.brand`),
    reported_brand_header: parsed.header[brandIndex],
    reported_product_condition: productCondition,
    reported_product_condition_header: parsed.header[parsed.headerMapping.product_condition],
    reported_lifecycle_status: lifecycleStatus,
    reported_lifecycle_status_header: parsed.headerMapping.lifecycle_status === null ? null : parsed.header[parsed.headerMapping.lifecycle_status],
    reported_legacy_item_identifier_opaque: optionalCatalogCell(
      cells,
      parsed.headerMapping.legacy_item_id,
      `${recordPath}.legacy_item_id`
    ),
    reported_legacy_item_identifier_header: parsed.headerMapping.legacy_item_id === null ? null : parsed.header[parsed.headerMapping.legacy_item_id],
    reported_legacy_wpid_opaque: optionalCatalogCell(
      cells,
      parsed.headerMapping.legacy_wpid,
      `${recordPath}.legacy_wpid`
    ),
    reported_legacy_wpid_header: parsed.headerMapping.legacy_wpid === null ? null : parsed.header[parsed.headerMapping.legacy_wpid],
    published_status: publishedStatus,
    source_record_number: reportRecord.sourceRecordNumber,
    source_record_sha256: walmartItemReportSha256(cells)
  };
}
function compileWalmartItemReportCatalogSource(captureInput, trustedContextInput) {
  const publishedSource = compileWalmartItemReportPublishedSource(
    captureInput,
    trustedContextInput
  );
  const capture = parseCapture(captureInput);
  const context = parseContext(trustedContextInput);
  const decoded = decodeTransport(capture.transportBytes);
  const parsed = parseReport(decoded.reportBytes, "v6");
  const brandIndex = findCatalogBrandIndex(parsed.header);
  if (sha256Bytes(capture.transportBytes) !== publishedSource.report.download_transport.bytes_sha256 || sha256Bytes(decoded.reportBytes) !== publishedSource.report.decoded_report.bytes_sha256 || parsed.records.length !== publishedSource.report.decoded_report.data_record_count) {
    throw new Error("ITEM v6 catalog projection does not match the compiled published source bytes");
  }
  const rows = parsed.records.map((record7) => compileCatalogRow(
    record7,
    parsed,
    brandIndex,
    context.account_scope
  ));
  rows.sort((left, right) => compareCodeUnits(left.listing_key, right.listing_key));
  if (new Set(rows.map((row) => row.listing_key)).size !== rows.length) {
    throw new Error("ITEM v6 catalog projection contains duplicate listing_key values");
  }
  const publishedCounts = new Map(
    PUBLISHED_STATUSES.map((status) => [status, 0])
  );
  const lifecycleCounts = new Map(
    LIFECYCLE_STATUSES.map((status) => [status, 0])
  );
  let lifecycleNotReportedCount = 0;
  for (const row of rows) {
    publishedCounts.set(row.published_status, (publishedCounts.get(row.published_status) ?? 0) + 1);
    if (row.reported_lifecycle_status === null) lifecycleNotReportedCount += 1;
    else {
      lifecycleCounts.set(
        row.reported_lifecycle_status,
        (lifecycleCounts.get(row.reported_lifecycle_status) ?? 0) + 1
      );
    }
  }
  const publishedStatusCounts = PUBLISHED_STATUSES.map((status) => ({
    status,
    count: publishedCounts.get(status) ?? 0
  }));
  const lifecycleStatusCounts = LIFECYCLE_STATUSES.map((status) => ({
    status,
    count: lifecycleCounts.get(status) ?? 0
  }));
  if (canonicalWalmartItemReportJson(publishedStatusCounts) !== canonicalWalmartItemReportJson(publishedSource.reconciliation.published_status_counts) || canonicalWalmartItemReportJson(lifecycleStatusCounts) !== canonicalWalmartItemReportJson(publishedSource.reconciliation.lifecycle_status_counts) || lifecycleNotReportedCount !== publishedSource.reconciliation.lifecycle_status_not_reported_count) {
    throw new Error("ITEM v6 catalog projection status counts conflict with published-source reconciliation");
  }
  const body = {
    schema_version: WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA,
    account_scope: structuredClone(context.account_scope),
    report: {
      source_system: "walmart_marketplace_api",
      report_type: REPORT_TYPE,
      report_version: "v6",
      report_request_id: publishedSource.report.report_request_id,
      report_request_id_sha256: walmartItemReportUtf8Sha256(
        publishedSource.report.report_request_id
      ),
      requested_at: publishedSource.report.requested_at,
      cutoff_at: publishedSource.report.cutoff_at,
      cutoff_basis: "READY_OBSERVED_UPPER_BOUND",
      downloaded_at: publishedSource.report.downloaded_at,
      raw_transport_sha256: publishedSource.report.download_transport.bytes_sha256,
      decoded_report_sha256: publishedSource.report.decoded_report.bytes_sha256,
      parsed_data_record_count: parsed.records.length
    },
    published_source: {
      schema_version: WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA,
      source_id: publishedSource.source_id,
      body_sha256: publishedSource.body_sha256
    },
    status_semantics: fixedCatalogStatusSemantics(),
    reconciliation: {
      parsed_data_record_count: parsed.records.length,
      output_row_count: rows.length,
      unique_listing_count: rows.length,
      rows_sha256: walmartItemReportSha256(rows),
      published_row_count: rows.filter((row) => row.published_status === "PUBLISHED").length,
      published_rows_sha256: walmartItemReportSha256(
        rows.filter((row) => row.published_status === "PUBLISHED")
      ),
      malformed_record_count: 0,
      duplicate_listing_key_count: 0,
      conflicting_listing_key_count: 0,
      published_status_counts: publishedStatusCounts,
      lifecycle_status_counts: lifecycleStatusCounts,
      lifecycle_status_not_reported_count: lifecycleNotReportedCount
    },
    catalog_population_complete: true,
    rows
  };
  const bodySha256 = walmartItemReportSha256(body);
  const source = {
    ...body,
    source_id: `walmart-item-report-catalog-${bodySha256.slice(0, 16)}`,
    body_sha256: bodySha256
  };
  verifyWalmartItemReportCatalogSource(source);
  return source;
}
function exactCatalogHeader(value, aliases, path7) {
  const header = exactString(value, path7);
  if (!new Set(aliases.map(normalizeHeader)).has(normalizeHeader(header))) {
    throw new Error(`${path7} is not an accepted ITEM v6 header`);
  }
  return header;
}
function parseCatalogOptionalEvidence(value, headerValue, aliases, path7, parseValue = exactString) {
  const header = headerValue === null ? null : exactCatalogHeader(headerValue, aliases, `${path7}_header`);
  if (value === null) return { value: null, header };
  if (header === null) throw new Error(`${path7} cannot be present without its report header`);
  return { value: parseValue(value, path7), header };
}
function parseCatalogRow(input, index, accountScope) {
  const path7 = `catalog source.rows[${index}]`;
  const raw = asRecord(input, path7);
  assertExactKeys3(raw, [
    "channel",
    "store_index",
    "sku",
    "listing_key",
    "reported_product_identifier_opaque",
    "reported_product_identifier_type_opaque",
    "reported_product_identifier_header",
    "reported_product_identifier_type_header",
    "reported_product_name",
    "reported_product_name_header",
    "reported_brand",
    "reported_brand_header",
    "reported_product_condition",
    "reported_product_condition_header",
    "reported_lifecycle_status",
    "reported_lifecycle_status_header",
    "reported_legacy_item_identifier_opaque",
    "reported_legacy_item_identifier_header",
    "reported_legacy_wpid_opaque",
    "reported_legacy_wpid_header",
    "published_status",
    "source_record_number",
    "source_record_sha256"
  ], path7);
  if (raw.channel !== CHANNEL || raw.channel !== accountScope.channel) {
    throw new Error(`${path7}.channel must match account scope`);
  }
  const storeIndex = positiveInteger3(raw.store_index, `${path7}.store_index`);
  if (storeIndex !== accountScope.store_index) {
    throw new Error(`${path7}.store_index must match account scope`);
  }
  const sku = exactString(raw.sku, `${path7}.sku`);
  const listingKey = walmartListingKey(storeIndex, sku);
  if (raw.listing_key !== listingKey) throw new Error(`${path7}.listing_key must be ${listingKey}`);
  if (!PUBLISHED_STATUSES.includes(raw.published_status)) {
    throw new Error(`${path7}.published_status is not supported`);
  }
  const publishedStatus = raw.published_status;
  const productIdentifierHeader = exactCatalogHeader(
    raw.reported_product_identifier_header,
    REQUIRED_HEADER_ALIASES.product_id,
    `${path7}.reported_product_identifier_header`
  );
  const productIdentifierTypeHeader = exactCatalogHeader(
    raw.reported_product_identifier_type_header,
    REQUIRED_HEADER_ALIASES.product_id_type,
    `${path7}.reported_product_identifier_type_header`
  );
  const productNameHeader = exactCatalogHeader(
    raw.reported_product_name_header,
    REQUIRED_HEADER_ALIASES.product_name,
    `${path7}.reported_product_name_header`
  );
  const productIdentifier = exactString(
    raw.reported_product_identifier_opaque,
    `${path7}.reported_product_identifier_opaque`
  );
  const productIdentifierType = exactString(
    raw.reported_product_identifier_type_opaque,
    `${path7}.reported_product_identifier_type_opaque`
  );
  const selfDescribingType = productIdentifierHeader === productIdentifierTypeHeader ? selfDescribingProductIdentifierType(productIdentifierHeader) : null;
  if (selfDescribingType !== null && productIdentifierType !== selfDescribingType) {
    throw new Error(`${path7}.reported_product_identifier_type_opaque must match its self-describing report header`);
  }
  const brandHeader = exactCatalogHeader(
    raw.reported_brand_header,
    ["Brand"],
    `${path7}.reported_brand_header`
  );
  const condition = parseCatalogOptionalEvidence(
    raw.reported_product_condition,
    raw.reported_product_condition_header,
    OPTIONAL_HEADER_ALIASES.product_condition,
    `${path7}.reported_product_condition`
  );
  if (condition.header === null) {
    throw new Error(`${path7}.reported_product_condition_header is required for ITEM v6`);
  }
  const lifecyclePair = parseCatalogOptionalEvidence(
    raw.reported_lifecycle_status,
    raw.reported_lifecycle_status_header,
    OPTIONAL_HEADER_ALIASES.lifecycle_status,
    `${path7}.reported_lifecycle_status`,
    (value, valuePath) => {
      const parsed = parseLifecycleStatus(value, valuePath);
      if (parsed !== value) throw new Error(`${valuePath} must use the canonical lifecycle status`);
      return parsed;
    }
  );
  const legacyItem = parseCatalogOptionalEvidence(
    raw.reported_legacy_item_identifier_opaque,
    raw.reported_legacy_item_identifier_header,
    OPTIONAL_HEADER_ALIASES.legacy_item_id,
    `${path7}.reported_legacy_item_identifier_opaque`
  );
  const legacyWpid = parseCatalogOptionalEvidence(
    raw.reported_legacy_wpid_opaque,
    raw.reported_legacy_wpid_header,
    OPTIONAL_HEADER_ALIASES.legacy_wpid,
    `${path7}.reported_legacy_wpid_opaque`
  );
  return {
    channel: CHANNEL,
    store_index: storeIndex,
    sku,
    listing_key: listingKey,
    reported_product_identifier_opaque: productIdentifier,
    reported_product_identifier_type_opaque: productIdentifierType,
    reported_product_identifier_header: productIdentifierHeader,
    reported_product_identifier_type_header: productIdentifierTypeHeader,
    reported_product_name: exactText(raw.reported_product_name, `${path7}.reported_product_name`),
    reported_product_name_header: productNameHeader,
    reported_brand: raw.reported_brand === null ? null : exactText(raw.reported_brand, `${path7}.reported_brand`),
    reported_brand_header: brandHeader,
    reported_product_condition: condition.value,
    reported_product_condition_header: condition.header,
    reported_lifecycle_status: lifecyclePair.value,
    reported_lifecycle_status_header: lifecyclePair.header,
    reported_legacy_item_identifier_opaque: legacyItem.value,
    reported_legacy_item_identifier_header: legacyItem.header,
    reported_legacy_wpid_opaque: legacyWpid.value,
    reported_legacy_wpid_header: legacyWpid.header,
    published_status: publishedStatus,
    source_record_number: positiveInteger3(raw.source_record_number, `${path7}.source_record_number`),
    source_record_sha256: sha256String2(raw.source_record_sha256, `${path7}.source_record_sha256`)
  };
}
function verifyWalmartItemReportCatalogSource(input) {
  const raw = asRecord(input, "catalog source");
  assertExactKeys3(raw, [
    "schema_version",
    "account_scope",
    "report",
    "published_source",
    "status_semantics",
    "reconciliation",
    "catalog_population_complete",
    "rows",
    "source_id",
    "body_sha256"
  ], "catalog source");
  if (raw.schema_version !== WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA) {
    throw new Error(`catalog source.schema_version must be ${WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA}`);
  }
  if (raw.catalog_population_complete !== true) {
    throw new Error("catalog source.catalog_population_complete must be compiler-derived true");
  }
  const accountScope = parseAccountScope(raw.account_scope, "catalog source.account_scope");
  const report = asRecord(raw.report, "catalog source.report");
  assertExactKeys3(report, [
    "source_system",
    "report_type",
    "report_version",
    "report_request_id",
    "report_request_id_sha256",
    "requested_at",
    "cutoff_at",
    "cutoff_basis",
    "downloaded_at",
    "raw_transport_sha256",
    "decoded_report_sha256",
    "parsed_data_record_count"
  ], "catalog source.report");
  if (report.source_system !== "walmart_marketplace_api" || report.report_type !== REPORT_TYPE || report.report_version !== "v6" || report.cutoff_basis !== "READY_OBSERVED_UPPER_BOUND") {
    throw new Error("catalog source.report must bind the full ITEM v6 READY-cutoff source");
  }
  const reportRequestId = exactString(report.report_request_id, "catalog source.report.report_request_id");
  const reportRequestIdSha256 = sha256String2(
    report.report_request_id_sha256,
    "catalog source.report.report_request_id_sha256"
  );
  if (reportRequestIdSha256 !== walmartItemReportUtf8Sha256(reportRequestId)) {
    throw new Error("catalog source.report.report_request_id_sha256 mismatch");
  }
  const requestedAt = isoTimestamp(report.requested_at, "catalog source.report.requested_at");
  const cutoffAt = isoTimestamp(report.cutoff_at, "catalog source.report.cutoff_at");
  const downloadedAt = isoTimestamp(report.downloaded_at, "catalog source.report.downloaded_at");
  if (Date.parse(requestedAt) > Date.parse(cutoffAt) || Date.parse(cutoffAt) > Date.parse(downloadedAt)) {
    throw new Error("catalog source.report chronology must satisfy requested_at <= cutoff_at <= downloaded_at");
  }
  const rawTransportSha256 = sha256String2(
    report.raw_transport_sha256,
    "catalog source.report.raw_transport_sha256"
  );
  const decodedReportSha256 = sha256String2(
    report.decoded_report_sha256,
    "catalog source.report.decoded_report_sha256"
  );
  const reportParsedCount = positiveInteger3(
    report.parsed_data_record_count,
    "catalog source.report.parsed_data_record_count"
  );
  const publishedSource = asRecord(raw.published_source, "catalog source.published_source");
  assertExactKeys3(
    publishedSource,
    ["schema_version", "source_id", "body_sha256"],
    "catalog source.published_source"
  );
  if (publishedSource.schema_version !== WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA) {
    throw new Error("catalog source.published_source schema is invalid");
  }
  const publishedBodySha256 = sha256String2(
    publishedSource.body_sha256,
    "catalog source.published_source.body_sha256"
  );
  const expectedPublishedSourceId = `walmart-item-report-published-${publishedBodySha256.slice(0, 16)}`;
  const publishedSourceId = exactString(
    publishedSource.source_id,
    "catalog source.published_source.source_id"
  );
  if (publishedSourceId !== expectedPublishedSourceId) {
    throw new Error(`catalog source.published_source.source_id must be ${expectedPublishedSourceId}`);
  }
  const statusSemantics = asRecord(raw.status_semantics, "catalog source.status_semantics");
  if (canonicalWalmartItemReportJson(statusSemantics) !== canonicalWalmartItemReportJson(fixedCatalogStatusSemantics())) {
    throw new Error("catalog source.status_semantics does not match the all-status policy");
  }
  const reconciliation = asRecord(raw.reconciliation, "catalog source.reconciliation");
  assertExactKeys3(reconciliation, [
    "parsed_data_record_count",
    "output_row_count",
    "unique_listing_count",
    "rows_sha256",
    "published_row_count",
    "published_rows_sha256",
    "malformed_record_count",
    "duplicate_listing_key_count",
    "conflicting_listing_key_count",
    "published_status_counts",
    "lifecycle_status_counts",
    "lifecycle_status_not_reported_count"
  ], "catalog source.reconciliation");
  const parsedCount = positiveInteger3(
    reconciliation.parsed_data_record_count,
    "catalog source.reconciliation.parsed_data_record_count"
  );
  const outputCount = positiveInteger3(
    reconciliation.output_row_count,
    "catalog source.reconciliation.output_row_count"
  );
  const uniqueCount = positiveInteger3(
    reconciliation.unique_listing_count,
    "catalog source.reconciliation.unique_listing_count"
  );
  const rowsSha256 = sha256String2(reconciliation.rows_sha256, "catalog source.reconciliation.rows_sha256");
  const publishedRowCount = nonNegativeInteger2(
    reconciliation.published_row_count,
    "catalog source.reconciliation.published_row_count"
  );
  const publishedRowsSha256 = sha256String2(
    reconciliation.published_rows_sha256,
    "catalog source.reconciliation.published_rows_sha256"
  );
  for (const field of [
    "malformed_record_count",
    "duplicate_listing_key_count",
    "conflicting_listing_key_count"
  ]) {
    if (reconciliation[field] !== 0) {
      throw new Error(`catalog source.reconciliation.${field} must be zero`);
    }
  }
  const publishedStatusCounts = parseCountArray(
    reconciliation.published_status_counts,
    PUBLISHED_STATUSES,
    "catalog source.reconciliation.published_status_counts"
  );
  const lifecycleStatusCounts = parseCountArray(
    reconciliation.lifecycle_status_counts,
    LIFECYCLE_STATUSES,
    "catalog source.reconciliation.lifecycle_status_counts"
  );
  const lifecycleNotReportedCount = nonNegativeInteger2(
    reconciliation.lifecycle_status_not_reported_count,
    "catalog source.reconciliation.lifecycle_status_not_reported_count"
  );
  if (!Array.isArray(raw.rows)) throw new Error("catalog source.rows must be an array");
  const rows = raw.rows.map((row, index) => parseCatalogRow(row, index, accountScope));
  const listingKeys = rows.map((row) => row.listing_key);
  if (canonicalWalmartItemReportJson(listingKeys) !== canonicalWalmartItemReportJson([...listingKeys].sort(compareCodeUnits))) {
    throw new Error("catalog source.rows must be sorted by listing_key using code-unit order");
  }
  if (new Set(listingKeys).size !== rows.length) {
    throw new Error("catalog source.rows has duplicate listing_key values");
  }
  const sourceRecordNumbers = rows.map((row) => row.source_record_number);
  if (new Set(sourceRecordNumbers).size !== rows.length || sourceRecordNumbers.some((number) => number < 2 || number > parsedCount + 1)) {
    throw new Error("catalog source.rows must cover unique decoded source record numbers");
  }
  if (reportParsedCount !== parsedCount || parsedCount !== rows.length || outputCount !== rows.length || uniqueCount !== rows.length) {
    throw new Error("catalog source record/output counts do not reconcile");
  }
  if (rowsSha256 !== walmartItemReportSha256(rows)) {
    throw new Error("catalog source.reconciliation.rows_sha256 mismatch");
  }
  const publishedRows = rows.filter((row) => row.published_status === "PUBLISHED");
  if (publishedRowCount !== publishedRows.length || publishedRowsSha256 !== walmartItemReportSha256(publishedRows)) {
    throw new Error("catalog source PUBLISHED projection count/hash mismatch");
  }
  const countRows = (statuses, selector) => statuses.map((status) => ({
    status,
    count: rows.filter((row) => selector(row) === status).length
  }));
  if (canonicalWalmartItemReportJson(publishedStatusCounts) !== canonicalWalmartItemReportJson(countRows(PUBLISHED_STATUSES, (row) => row.published_status)) || canonicalWalmartItemReportJson(lifecycleStatusCounts) !== canonicalWalmartItemReportJson(countRows(LIFECYCLE_STATUSES, (row) => row.reported_lifecycle_status)) || lifecycleNotReportedCount !== rows.filter((row) => row.reported_lifecycle_status === null).length) {
    throw new Error("catalog source status counts do not reconcile with rows");
  }
  const parsed = {
    schema_version: WALMART_ITEM_REPORT_CATALOG_SOURCE_SCHEMA,
    account_scope: accountScope,
    report: {
      source_system: "walmart_marketplace_api",
      report_type: REPORT_TYPE,
      report_version: "v6",
      report_request_id: reportRequestId,
      report_request_id_sha256: reportRequestIdSha256,
      requested_at: requestedAt,
      cutoff_at: cutoffAt,
      cutoff_basis: "READY_OBSERVED_UPPER_BOUND",
      downloaded_at: downloadedAt,
      raw_transport_sha256: rawTransportSha256,
      decoded_report_sha256: decodedReportSha256,
      parsed_data_record_count: reportParsedCount
    },
    published_source: {
      schema_version: WALMART_ITEM_REPORT_PUBLISHED_SOURCE_SCHEMA,
      source_id: publishedSourceId,
      body_sha256: publishedBodySha256
    },
    status_semantics: fixedCatalogStatusSemantics(),
    reconciliation: {
      parsed_data_record_count: parsedCount,
      output_row_count: outputCount,
      unique_listing_count: uniqueCount,
      rows_sha256: rowsSha256,
      published_row_count: publishedRowCount,
      published_rows_sha256: publishedRowsSha256,
      malformed_record_count: 0,
      duplicate_listing_key_count: 0,
      conflicting_listing_key_count: 0,
      published_status_counts: publishedStatusCounts,
      lifecycle_status_counts: lifecycleStatusCounts,
      lifecycle_status_not_reported_count: lifecycleNotReportedCount
    },
    catalog_population_complete: true,
    rows,
    source_id: exactString(raw.source_id, "catalog source.source_id"),
    body_sha256: sha256String2(raw.body_sha256, "catalog source.body_sha256")
  };
  const body = structuredClone(parsed);
  delete body.source_id;
  delete body.body_sha256;
  const expectedBodySha256 = walmartItemReportSha256(body);
  if (parsed.body_sha256 !== expectedBodySha256) {
    throw new Error("catalog source.body_sha256 mismatch");
  }
  const expectedSourceId = `walmart-item-report-catalog-${expectedBodySha256.slice(0, 16)}`;
  if (parsed.source_id !== expectedSourceId) {
    throw new Error(`catalog source.source_id must be ${expectedSourceId}`);
  }
  return parsed;
}
function verifyWalmartItemReportCatalogSourceAgainstCapture(input, captureInput, trustedContextInput) {
  const verified = verifyWalmartItemReportCatalogSource(input);
  const rebuilt = compileWalmartItemReportCatalogSource(captureInput, trustedContextInput);
  if (canonicalWalmartItemReportJson(verified) !== canonicalWalmartItemReportJson(rebuilt)) {
    throw new Error("catalog source does not exactly recompile from the trusted ITEM report capture and context");
  }
  return verified;
}

// src/lib/walmart/item-report-reissue-consumption-ledger-v2.ts
import { createHash as createHash4, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink
} from "node:fs/promises";
import path from "node:path";
var WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_IDENTITY_SCHEMA = "walmart-item-report-reissue-consumption-ledger-identity/v1";
var WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_CLAIM_SCHEMA = "walmart-item-report-reissue-authorization-claim/v1";
var WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_REQUESTING_SCHEMA = "walmart-item-report-reissue-authorization-requesting/v1";
var WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_TERMINAL_SCHEMA = "walmart-item-report-reissue-authorization-terminal/v1";
var WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_HEAD_SCHEMA = "walmart-item-report-reissue-consumption-ledger-head/v1";
var LEDGER_POLICY_ID = "walmart-item-report-reissue-consumption-ledger/1.0.0";
var RESERVATION_FILENAME_POLICY = "authorization-sha256.json/exclusive-create/v1";
var IDENTITY_FILE_NAME = ".ledger-identity.json";
var HEAD_FILE_NAME = ".ledger-head.json";
var HEAD_TEMP_FILE_PATTERN = /^\.ledger-head\.[0-9a-f-]+\.tmp$/u;
var PRIVATE_DIRECTORY_MODE = 448;
var IMMUTABLE_FILE_MODE = 256;
var MAX_LEDGER_FILE_BYTES = 256 * 1024;
var DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
var SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
var RESERVATION_FILE_PATTERN = /^([a-f0-9]{64})\.json$/u;
var REQUESTING_FILE_PATTERN = /^\.([a-f0-9]{64})\.requesting\.json$/u;
var TERMINAL_FILE_PATTERN = /^\.([a-f0-9]{64})\.terminal\.json$/u;
var WalmartItemReportReissueConsumptionLedgerV2Error = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WalmartItemReportReissueConsumptionLedgerV2Error";
    this.code = code;
  }
};
function fail(code, message) {
  throw new WalmartItemReportReissueConsumptionLedgerV2Error(code, message);
}
function isRecord4(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value, label) {
  if (!isRecord4(value)) fail("LEDGER_CORRUPT", `${label} must be an object`);
  return value;
}
function exactKeys(value, expected, label, code = "LEDGER_CORRUPT") {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code, `${label} has missing or extra fields`);
  }
}
function sha256(value) {
  return createHash4("sha256").update(value).digest("hex");
}
function digest(value, label, code = "INVALID_INPUT") {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    fail(code, `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}
function nonNegativeInteger3(value, label, code = "LEDGER_CORRUPT") {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    fail(code, `${label} must be a non-negative safe integer`);
  }
  return value;
}
function safeIdentifier(value, label, code = "INVALID_INPUT") {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || value !== value.trim() || !SAFE_IDENTIFIER_PATTERN.test(value) || value.includes("//") || value.endsWith("/")) {
    fail(code, `${label} must be a safe identifier`);
  }
  return value;
}
function strictInstant(value, label, fallback = /* @__PURE__ */ new Date()) {
  const text = value instanceof Date ? value.toISOString() : value ?? fallback.toISOString();
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(text) || !Number.isFinite(Date.parse(text)) || new Date(Date.parse(text)).toISOString() !== text) {
    fail("INVALID_INPUT", `${label} must be canonical UTC milliseconds`);
  }
  return text;
}
function normalizedStateDirectory(value) {
  if (typeof value !== "string" || value.length < 1 || value !== value.trim()) {
    fail("LEDGER_CUSTODY_INVALID", "state_directory must be a non-empty exact path");
  }
  const directory = path.resolve(value);
  if (!path.isAbsolute(directory) || directory === path.parse(directory).root) {
    fail("LEDGER_CUSTODY_INVALID", "state_directory must be an absolute non-root path");
  }
  return directory;
}
function requiredNoFollowFlag() {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    fail("UNSUPPORTED_PLATFORM", "O_NOFOLLOW is required for ledger custody");
  }
  return fsConstants.O_NOFOLLOW;
}
function requiredDirectoryFlag() {
  if (typeof fsConstants.O_DIRECTORY !== "number") {
    fail("UNSUPPORTED_PLATFORM", "O_DIRECTORY is required for ledger custody");
  }
  return fsConstants.O_DIRECTORY;
}
function statIdentity(info) {
  return { device: String(info.dev), inode: String(info.ino) };
}
function sameFileIdentity(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}
function sameStableFileStat(left, right) {
  return sameFileIdentity(left, right) && left.size === right.size && left.mode === right.mode && left.nlink === right.nlink && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
async function inspectDirectoryCustody(value) {
  const directory = normalizedStateDirectory(value);
  let pathBefore;
  try {
    pathBefore = await lstat(directory);
  } catch (error) {
    const code = error?.code;
    fail(
      "LEDGER_CUSTODY_INVALID",
      `state directory cannot be inspected${code ? ` (${code})` : ""}`
    );
  }
  if (!pathBefore.isDirectory() || pathBefore.isSymbolicLink() || (pathBefore.mode & 511) !== PRIVATE_DIRECTORY_MODE) {
    fail("LEDGER_CUSTODY_INVALID", "state directory must be a real mode-0700 directory");
  }
  const canonicalBefore = await realpath(directory).catch(() => {
    fail("LEDGER_CUSTODY_INVALID", "state directory realpath cannot be resolved");
  });
  const flags = fsConstants.O_RDONLY | requiredNoFollowFlag() | requiredDirectoryFlag();
  let handle;
  try {
    handle = await open(directory, flags);
  } catch (error) {
    const code = error?.code;
    fail(
      "LEDGER_CUSTODY_INVALID",
      `state directory cannot be opened without following links${code ? ` (${code})` : ""}`
    );
  }
  let descriptorInfo;
  try {
    descriptorInfo = await handle.stat();
  } finally {
    await handle.close();
  }
  const pathAfter = await lstat(directory).catch(() => {
    fail("LEDGER_CUSTODY_INVALID", "state directory changed while being inspected");
  });
  const canonicalAfter = await realpath(directory).catch(() => {
    fail("LEDGER_CUSTODY_INVALID", "state directory realpath changed while being inspected");
  });
  if (!descriptorInfo.isDirectory() || !sameFileIdentity(pathBefore, descriptorInfo) || !sameFileIdentity(descriptorInfo, pathAfter) || (descriptorInfo.mode & 511) !== PRIVATE_DIRECTORY_MODE || (pathAfter.mode & 511) !== PRIVATE_DIRECTORY_MODE || canonicalBefore !== canonicalAfter) {
    fail("LEDGER_CUSTODY_INVALID", "state directory identity or mode is unstable");
  }
  const identity = statIdentity(descriptorInfo);
  return {
    directory,
    canonical_path: canonicalAfter,
    ...identity,
    state_directory_path_sha256: sha256(Buffer.from(canonicalAfter, "utf8")),
    directory_identity_sha256: sha256(Buffer.from(canonicalWalmartItemReportJson(identity), "utf8"))
  };
}
function assertSameDirectoryCustody(before, after) {
  if (before.directory !== after.directory || before.canonical_path !== after.canonical_path || before.device !== after.device || before.inode !== after.inode || before.state_directory_path_sha256 !== after.state_directory_path_sha256 || before.directory_identity_sha256 !== after.directory_identity_sha256) {
    fail("LEDGER_CUSTODY_INVALID", "state directory identity changed during ledger operation");
  }
}
async function fsyncDirectory(custody) {
  const flags = fsConstants.O_RDONLY | requiredNoFollowFlag() | requiredDirectoryFlag();
  let handle;
  try {
    handle = await open(custody.directory, flags);
  } catch {
    fail("LEDGER_CUSTODY_INVALID", "state directory cannot be opened for fsync");
  }
  try {
    const info = await handle.stat();
    if (!info.isDirectory() || String(info.dev) !== custody.device || String(info.ino) !== custody.inode || (info.mode & 511) !== PRIVATE_DIRECTORY_MODE) {
      fail("LEDGER_CUSTODY_INVALID", "state directory changed before fsync");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  assertSameDirectoryCustody(custody, await inspectDirectoryCustody(custody.directory));
}
async function readBoundJsonFile(file, label) {
  let pathBefore;
  try {
    pathBefore = await lstat(file);
  } catch (error) {
    const code = error?.code;
    fail("LEDGER_CORRUPT", `${label} cannot be inspected${code ? ` (${code})` : ""}`);
  }
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink !== 1 || (pathBefore.mode & 511) !== IMMUTABLE_FILE_MODE || pathBefore.size > MAX_LEDGER_FILE_BYTES) {
    fail(
      "LEDGER_CORRUPT",
      `${label} must be a mode-0400, nlink-1 regular file within its byte cap`
    );
  }
  const flags = fsConstants.O_RDONLY | requiredNoFollowFlag();
  let handle;
  try {
    handle = await open(file, flags);
  } catch {
    fail("LEDGER_CORRUPT", `${label} cannot be opened without following links`);
  }
  let bytes;
  let before;
  let after;
  try {
    before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 511) !== IMMUTABLE_FILE_MODE || !sameFileIdentity(pathBefore, before)) {
      fail("LEDGER_CORRUPT", `${label} descriptor custody is invalid`);
    }
    bytes = await handle.readFile();
    after = await handle.stat();
  } finally {
    await handle.close();
  }
  const pathAfter = await lstat(file).catch(() => {
    fail("LEDGER_CORRUPT", `${label} disappeared while being read`);
  });
  if (!sameStableFileStat(before, after) || !sameFileIdentity(after, pathAfter) || pathAfter.nlink !== 1 || (pathAfter.mode & 511) !== IMMUTABLE_FILE_MODE || bytes.byteLength !== after.size) {
    fail("LEDGER_CORRUPT", `${label} changed while being read`);
  }
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail("LEDGER_CORRUPT", `${label} must contain valid UTF-8 JSON`);
  }
  const canonicalBytes2 = Buffer.from(`${canonicalWalmartItemReportJson(value)}
`, "utf8");
  if (!Buffer.from(bytes).equals(canonicalBytes2)) {
    fail("LEDGER_CORRUPT", `${label} bytes are not canonical`);
  }
  return { bytes: Buffer.from(bytes), value, sha256: sha256(bytes) };
}
async function writeExclusiveJsonFile(file, value, label) {
  const bytes = Buffer.from(`${canonicalWalmartItemReportJson(value)}
`, "utf8");
  if (bytes.byteLength > MAX_LEDGER_FILE_BYTES) {
    fail("INVALID_INPUT", `${label} exceeds its byte cap`);
  }
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | requiredNoFollowFlag();
  let handle;
  try {
    handle = await open(file, flags, IMMUTABLE_FILE_MODE);
  } catch (error) {
    if (error?.code === "EEXIST") throw error;
    fail("LEDGER_CUSTODY_INVALID", `${label} cannot be exclusively created`);
  }
  try {
    await handle.writeFile(bytes);
    await handle.chmod(IMMUTABLE_FILE_MODE);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 511) !== IMMUTABLE_FILE_MODE || info.size !== bytes.byteLength) {
      fail("LEDGER_CUSTODY_INVALID", `${label} created with unsafe custody`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  const loaded = await readBoundJsonFile(file, label);
  if (!loaded.bytes.equals(bytes)) {
    fail("LEDGER_CORRUPT", `${label} exact bytes changed after exclusive create`);
  }
  return loaded;
}
function parseBinding(value, code = "LEDGER_BINDING_MISMATCH") {
  const raw = record(value, "consumption ledger binding");
  exactKeys(raw, [
    "directory_identity_sha256",
    "distributed_at_most_once_claimed",
    "identity_artifact_sha256",
    "ledger_epoch",
    "ledger_id",
    "policy_id",
    "reservation_filename_policy",
    "state_directory_path_sha256",
    "trusted_single_custody_host_only"
  ], "consumption ledger binding", code);
  if (raw.policy_id !== LEDGER_POLICY_ID || raw.reservation_filename_policy !== RESERVATION_FILENAME_POLICY || raw.trusted_single_custody_host_only !== true || raw.distributed_at_most_once_claimed !== false) {
    fail(code, "consumption ledger binding safety policy is invalid");
  }
  return {
    policy_id: LEDGER_POLICY_ID,
    ledger_id: safeIdentifier(raw.ledger_id, "ledger_id", code),
    ledger_epoch: safeIdentifier(raw.ledger_epoch, "ledger_epoch", code),
    state_directory_path_sha256: digest(raw.state_directory_path_sha256, "path SHA", code),
    directory_identity_sha256: digest(raw.directory_identity_sha256, "directory SHA", code),
    identity_artifact_sha256: digest(raw.identity_artifact_sha256, "identity artifact SHA", code),
    reservation_filename_policy: RESERVATION_FILENAME_POLICY,
    trusted_single_custody_host_only: true,
    distributed_at_most_once_claimed: false
  };
}
function exactJsonEqual(left, right) {
  return canonicalWalmartItemReportJson(left) === canonicalWalmartItemReportJson(right);
}
function parseIdentity2(value, exactBytesSha2562, custody) {
  const raw = record(value, "ledger identity");
  exactKeys(raw, ["body", "body_sha256", "schema_version"], "ledger identity");
  if (raw.schema_version !== WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_IDENTITY_SCHEMA) {
    fail("LEDGER_CORRUPT", "ledger identity schema is invalid");
  }
  const bodyRaw = record(raw.body, "ledger identity body");
  exactKeys(bodyRaw, [
    "created_at",
    "directory_identity_sha256",
    "ledger_epoch",
    "ledger_id",
    "state_directory_path_sha256"
  ], "ledger identity body");
  const body = {
    ledger_id: safeIdentifier(bodyRaw.ledger_id, "identity ledger_id", "LEDGER_CORRUPT"),
    ledger_epoch: safeIdentifier(
      bodyRaw.ledger_epoch,
      "identity ledger_epoch",
      "LEDGER_CORRUPT"
    ),
    state_directory_path_sha256: digest(
      bodyRaw.state_directory_path_sha256,
      "identity path SHA",
      "LEDGER_CORRUPT"
    ),
    directory_identity_sha256: digest(
      bodyRaw.directory_identity_sha256,
      "identity directory SHA",
      "LEDGER_CORRUPT"
    ),
    created_at: strictInstant(
      typeof bodyRaw.created_at === "string" ? bodyRaw.created_at : "",
      "identity created_at"
    )
  };
  const bodySha = digest(raw.body_sha256, "identity body SHA", "LEDGER_CORRUPT");
  if (bodySha !== sha256(canonicalWalmartItemReportJson(body)) || body.state_directory_path_sha256 !== custody.state_directory_path_sha256 || body.directory_identity_sha256 !== custody.directory_identity_sha256) {
    fail("LEDGER_CUSTODY_INVALID", "ledger identity does not match directory custody");
  }
  digest(exactBytesSha2562, "identity exact bytes SHA", "LEDGER_CORRUPT");
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_IDENTITY_SCHEMA,
    body,
    body_sha256: bodySha
  };
}
function bindingFromIdentity(identity, identityArtifactSha256) {
  return {
    policy_id: LEDGER_POLICY_ID,
    ledger_id: identity.body.ledger_id,
    ledger_epoch: identity.body.ledger_epoch,
    state_directory_path_sha256: identity.body.state_directory_path_sha256,
    directory_identity_sha256: identity.body.directory_identity_sha256,
    identity_artifact_sha256: identityArtifactSha256,
    reservation_filename_policy: RESERVATION_FILENAME_POLICY,
    trusted_single_custody_host_only: true,
    distributed_at_most_once_claimed: false
  };
}
function parseHeadEvent(value, index) {
  const raw = record(value, `ledger head event ${index}`);
  exactKeys(raw, [
    "authorization_sha256",
    "file_name",
    "file_sha256",
    "state"
  ], `ledger head event ${index}`);
  const fileName = typeof raw.file_name === "string" ? raw.file_name : "";
  const claim = RESERVATION_FILE_PATTERN.exec(fileName);
  const requesting = REQUESTING_FILE_PATTERN.exec(fileName);
  const terminal = TERMINAL_FILE_PATTERN.exec(fileName);
  const authorizationFromName = (claim ?? requesting ?? terminal)?.[1];
  const authorizationSha256 = digest(
    raw.authorization_sha256,
    `ledger head event ${index} authorization SHA`,
    "LEDGER_CORRUPT"
  );
  const state = raw.state;
  if (!authorizationFromName || authorizationFromName !== authorizationSha256 || claim && state !== "CLAIMED" || requesting && state !== "REQUESTING" || terminal && state !== "SUCCEEDED" && state !== "AMBIGUOUS" && state !== "FAILED") {
    fail("LEDGER_CORRUPT", `ledger head event ${index} filename/state binding is invalid`);
  }
  return {
    file_name: fileName,
    file_sha256: digest(
      raw.file_sha256,
      `ledger head event ${index} file SHA`,
      "LEDGER_CORRUPT"
    ),
    authorization_sha256: authorizationSha256,
    state
  };
}
function parseLedgerHead(value, artifactSha256, identityArtifactSha256, actualEvents) {
  const raw = record(value, "ledger head");
  exactKeys(raw, ["body", "body_sha256", "schema_version"], "ledger head");
  if (raw.schema_version !== WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_HEAD_SCHEMA) {
    fail("LEDGER_CORRUPT", "ledger head schema is invalid or legacy head is missing");
  }
  const bodyRaw = record(raw.body, "ledger head body");
  exactKeys(bodyRaw, [
    "at_most_once_scope",
    "distributed_at_most_once_claimed",
    "event_count",
    "events",
    "events_sha256",
    "hostile_same_uid_resistance_claimed",
    "identity_artifact_sha256",
    "previous_head_artifact_sha256",
    "updated_at"
  ], "ledger head body");
  if (!Array.isArray(bodyRaw.events)) fail("LEDGER_CORRUPT", "ledger head events must be an array");
  const events = bodyRaw.events.map(parseHeadEvent);
  const sorted = [...events].sort((left, right) => left.file_name < right.file_name ? -1 : left.file_name > right.file_name ? 1 : 0);
  const previous = bodyRaw.previous_head_artifact_sha256 === null ? null : digest(
    bodyRaw.previous_head_artifact_sha256,
    "ledger previous head SHA",
    "LEDGER_CORRUPT"
  );
  const body = {
    identity_artifact_sha256: digest(
      bodyRaw.identity_artifact_sha256,
      "ledger head identity SHA",
      "LEDGER_CORRUPT"
    ),
    previous_head_artifact_sha256: previous,
    event_count: nonNegativeInteger3(bodyRaw.event_count, "ledger head event_count"),
    events,
    events_sha256: digest(bodyRaw.events_sha256, "ledger head events SHA", "LEDGER_CORRUPT"),
    updated_at: strictInstant(
      typeof bodyRaw.updated_at === "string" ? bodyRaw.updated_at : "",
      "ledger head updated_at"
    ),
    at_most_once_scope: bodyRaw.at_most_once_scope === "INTACT_SINGLE_CUSTODY_DIRECTORY" ? "INTACT_SINGLE_CUSTODY_DIRECTORY" : fail("LEDGER_CORRUPT", "ledger head at-most-once scope is invalid"),
    hostile_same_uid_resistance_claimed: bodyRaw.hostile_same_uid_resistance_claimed === false ? false : fail("LEDGER_CORRUPT", "ledger head must not claim hostile same-UID resistance"),
    distributed_at_most_once_claimed: bodyRaw.distributed_at_most_once_claimed === false ? false : fail("LEDGER_CORRUPT", "ledger head must not claim distributed at-most-once")
  };
  const bodySha = digest(raw.body_sha256, "ledger head body SHA", "LEDGER_CORRUPT");
  if (body.identity_artifact_sha256 !== identityArtifactSha256 || body.event_count !== events.length || !exactJsonEqual(events, sorted) || new Set(events.map((event) => event.file_name)).size !== events.length || body.events_sha256 !== sha256(canonicalWalmartItemReportJson(events)) || !exactJsonEqual(events, actualEvents) || bodySha !== sha256(canonicalWalmartItemReportJson(body))) {
    fail("LEDGER_ROLLBACK_OR_DELETION_DETECTED", "ledger head and event inventory differ");
  }
  digest(artifactSha256, "ledger head artifact SHA", "LEDGER_CORRUPT");
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_HEAD_SCHEMA,
    body,
    body_sha256: bodySha
  };
}
function buildLedgerHead(identityArtifactSha256, previousHeadArtifactSha256, events, updatedAt) {
  const sortedEvents = [...events].sort((left, right) => left.file_name < right.file_name ? -1 : left.file_name > right.file_name ? 1 : 0);
  const body = {
    identity_artifact_sha256: identityArtifactSha256,
    previous_head_artifact_sha256: previousHeadArtifactSha256,
    event_count: sortedEvents.length,
    events: sortedEvents,
    events_sha256: sha256(canonicalWalmartItemReportJson(sortedEvents)),
    updated_at: updatedAt,
    at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY",
    hostile_same_uid_resistance_claimed: false,
    distributed_at_most_once_claimed: false
  };
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_HEAD_SCHEMA,
    body,
    body_sha256: sha256(canonicalWalmartItemReportJson(body))
  };
}
function parseClaimArtifact(value, authorizationSha256, expectedBinding) {
  const raw = record(value, `authorization ${authorizationSha256} claim`);
  exactKeys(raw, ["body", "body_sha256", "schema_version"], "claim artifact");
  if (raw.schema_version !== WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_CLAIM_SCHEMA) {
    fail("LEDGER_CORRUPT", "claim artifact schema is invalid");
  }
  const bodyRaw = record(raw.body, "claim artifact body");
  exactKeys(bodyRaw, [
    "authorization_sha256",
    "claim_id",
    "claimed_at",
    "consumption_ledger",
    "state"
  ], "claim artifact body");
  const body = {
    authorization_sha256: digest(
      bodyRaw.authorization_sha256,
      "claim authorization SHA",
      "LEDGER_CORRUPT"
    ),
    state: bodyRaw.state === "CLAIMED" ? "CLAIMED" : fail("LEDGER_CORRUPT", "claim state must be CLAIMED"),
    claim_id: safeIdentifier(bodyRaw.claim_id, "claim_id", "LEDGER_CORRUPT"),
    claimed_at: strictInstant(
      typeof bodyRaw.claimed_at === "string" ? bodyRaw.claimed_at : "",
      "claimed_at"
    ),
    consumption_ledger: parseBinding(bodyRaw.consumption_ledger, "LEDGER_CORRUPT")
  };
  const bodySha = digest(raw.body_sha256, "claim body SHA", "LEDGER_CORRUPT");
  if (body.authorization_sha256 !== authorizationSha256 || !exactJsonEqual(body.consumption_ledger, expectedBinding) || bodySha !== sha256(canonicalWalmartItemReportJson(body))) {
    fail("LEDGER_CORRUPT", "claim artifact binding or body SHA is invalid");
  }
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_CLAIM_SCHEMA,
    body,
    body_sha256: bodySha
  };
}
function parseRequestingArtifact(value, authorizationSha256, expectedBinding, claim, reservationFileSha256) {
  const raw = record(value, `authorization ${authorizationSha256} requesting fence`);
  exactKeys(raw, ["body", "body_sha256", "schema_version"], "requesting artifact");
  if (raw.schema_version !== WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_REQUESTING_SCHEMA) {
    fail("LEDGER_CORRUPT", "requesting artifact schema is invalid");
  }
  const bodyRaw = record(raw.body, "requesting artifact body");
  exactKeys(bodyRaw, [
    "authorization_sha256",
    "claim_id",
    "claimed_at",
    "consumption_ledger",
    "requesting_at",
    "reservation_file_sha256",
    "state"
  ], "requesting artifact body");
  const body = {
    authorization_sha256: digest(
      bodyRaw.authorization_sha256,
      "requesting authorization SHA",
      "LEDGER_CORRUPT"
    ),
    state: bodyRaw.state === "REQUESTING" ? "REQUESTING" : fail("LEDGER_CORRUPT", "requesting state must be REQUESTING"),
    claim_id: safeIdentifier(bodyRaw.claim_id, "requesting claim_id", "LEDGER_CORRUPT"),
    claimed_at: strictInstant(
      typeof bodyRaw.claimed_at === "string" ? bodyRaw.claimed_at : "",
      "requesting claimed_at"
    ),
    requesting_at: strictInstant(
      typeof bodyRaw.requesting_at === "string" ? bodyRaw.requesting_at : "",
      "requesting_at"
    ),
    reservation_file_sha256: digest(
      bodyRaw.reservation_file_sha256,
      "requesting reservation file SHA",
      "LEDGER_CORRUPT"
    ),
    consumption_ledger: parseBinding(bodyRaw.consumption_ledger, "LEDGER_CORRUPT")
  };
  const bodySha = digest(raw.body_sha256, "requesting body SHA", "LEDGER_CORRUPT");
  if (body.authorization_sha256 !== authorizationSha256 || body.claim_id !== claim.body.claim_id || body.claimed_at !== claim.body.claimed_at || Date.parse(body.requesting_at) < Date.parse(body.claimed_at) || body.reservation_file_sha256 !== reservationFileSha256 || !exactJsonEqual(body.consumption_ledger, expectedBinding) || bodySha !== sha256(canonicalWalmartItemReportJson(body))) {
    fail("LEDGER_CORRUPT", "requesting artifact binding or body SHA is invalid");
  }
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_REQUESTING_SCHEMA,
    body,
    body_sha256: bodySha
  };
}
function nullableDigest(value, label, code = "INVALID_INPUT") {
  return value === null ? null : digest(value, label, code);
}
function nullableErrorCode(value, label, code = "INVALID_INPUT") {
  return value === null ? null : safeIdentifier(value, label, code);
}
function terminalState(value, label, code) {
  if (value !== "SUCCEEDED" && value !== "AMBIGUOUS" && value !== "FAILED") {
    fail(code, `${label} is invalid`);
  }
  return value;
}
function nullableHttpStatus(value, label, code) {
  if (value !== null && (!Number.isSafeInteger(value) || typeof value !== "number" || value < 100 || value > 599)) {
    fail(code, `${label} is invalid`);
  }
  return value;
}
function parseTerminalArtifact(value, authorizationSha256, expectedBinding, claim, requesting, reservationFileSha256, requestingFileSha256) {
  const raw = record(value, `authorization ${authorizationSha256} terminal artifact`);
  exactKeys(raw, ["body", "body_sha256", "schema_version"], "terminal artifact");
  if (raw.schema_version !== WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_TERMINAL_SCHEMA) {
    fail("LEDGER_CORRUPT", "terminal artifact schema is invalid");
  }
  const bodyRaw = record(raw.body, "terminal artifact body");
  exactKeys(bodyRaw, [
    "authorization_sha256",
    "claim_id",
    "claimed_at",
    "consumption_ledger",
    "error_code",
    "http_status",
    "report_request_id_sha256",
    "requesting_at",
    "requesting_file_sha256",
    "reservation_file_sha256",
    "response_body_sha256",
    "state",
    "terminal_at"
  ], "terminal artifact body");
  const parsedTerminalState = terminalState(
    bodyRaw.state,
    "terminal state",
    "LEDGER_CORRUPT"
  );
  const httpStatus = nullableHttpStatus(
    bodyRaw.http_status,
    "terminal HTTP status",
    "LEDGER_CORRUPT"
  );
  const body = {
    authorization_sha256: digest(
      bodyRaw.authorization_sha256,
      "terminal authorization SHA",
      "LEDGER_CORRUPT"
    ),
    state: parsedTerminalState,
    claim_id: safeIdentifier(bodyRaw.claim_id, "terminal claim_id", "LEDGER_CORRUPT"),
    claimed_at: strictInstant(
      typeof bodyRaw.claimed_at === "string" ? bodyRaw.claimed_at : "",
      "terminal claimed_at"
    ),
    requesting_at: strictInstant(
      typeof bodyRaw.requesting_at === "string" ? bodyRaw.requesting_at : "",
      "terminal requesting_at"
    ),
    terminal_at: strictInstant(
      typeof bodyRaw.terminal_at === "string" ? bodyRaw.terminal_at : "",
      "terminal_at"
    ),
    reservation_file_sha256: digest(
      bodyRaw.reservation_file_sha256,
      "terminal reservation file SHA",
      "LEDGER_CORRUPT"
    ),
    requesting_file_sha256: digest(
      bodyRaw.requesting_file_sha256,
      "terminal requesting file SHA",
      "LEDGER_CORRUPT"
    ),
    http_status: httpStatus,
    response_body_sha256: nullableDigest(
      bodyRaw.response_body_sha256,
      "terminal response body SHA",
      "LEDGER_CORRUPT"
    ),
    report_request_id_sha256: nullableDigest(
      bodyRaw.report_request_id_sha256,
      "terminal report request ID SHA",
      "LEDGER_CORRUPT"
    ),
    error_code: nullableErrorCode(
      bodyRaw.error_code,
      "terminal error_code",
      "LEDGER_CORRUPT"
    ),
    consumption_ledger: parseBinding(bodyRaw.consumption_ledger, "LEDGER_CORRUPT")
  };
  const bodySha = digest(raw.body_sha256, "terminal body SHA", "LEDGER_CORRUPT");
  if (body.authorization_sha256 !== authorizationSha256 || body.claim_id !== claim.body.claim_id || body.claimed_at !== claim.body.claimed_at || body.requesting_at !== requesting.body.requesting_at || Date.parse(body.terminal_at) < Date.parse(body.requesting_at) || body.reservation_file_sha256 !== reservationFileSha256 || body.requesting_file_sha256 !== requestingFileSha256 || !exactJsonEqual(body.consumption_ledger, expectedBinding) || bodySha !== sha256(canonicalWalmartItemReportJson(body))) {
    fail("LEDGER_CORRUPT", "terminal artifact binding or body SHA is invalid");
  }
  if (body.state === "SUCCEEDED" && (body.http_status === null || body.http_status < 200 || body.http_status > 299 || body.response_body_sha256 === null || body.report_request_id_sha256 === null || body.error_code !== null)) {
    fail("LEDGER_CORRUPT", "SUCCEEDED terminal evidence is incomplete");
  }
  if (body.state !== "SUCCEEDED" && body.error_code === null) {
    fail("LEDGER_CORRUPT", "non-success terminal evidence requires an error_code");
  }
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_TERMINAL_SCHEMA,
    body,
    body_sha256: bodySha
  };
}
function reservationPath(directory, authorizationSha256) {
  return path.join(directory, `${authorizationSha256}.json`);
}
function requestingPath(directory, authorizationSha256) {
  return path.join(directory, `.${authorizationSha256}.requesting.json`);
}
function terminalPath(directory, authorizationSha256) {
  return path.join(directory, `.${authorizationSha256}.terminal.json`);
}
function claimReceipt(directory, artifact2, fileSha256) {
  return {
    authorization_sha256: artifact2.body.authorization_sha256,
    state: "CLAIMED",
    claim_id: artifact2.body.claim_id,
    claimed_at: artifact2.body.claimed_at,
    reservation_path: reservationPath(directory, artifact2.body.authorization_sha256),
    reservation_file_sha256: fileSha256,
    consumption_ledger: artifact2.body.consumption_ledger
  };
}
function requestingReceipt(directory, claim, claimFileSha256, artifact2, fileSha256) {
  return {
    authorization_sha256: artifact2.body.authorization_sha256,
    state: "REQUESTING",
    claim_id: artifact2.body.claim_id,
    claimed_at: artifact2.body.claimed_at,
    requesting_at: artifact2.body.requesting_at,
    reservation_path: reservationPath(directory, artifact2.body.authorization_sha256),
    reservation_file_sha256: claimFileSha256,
    requesting_path: requestingPath(directory, artifact2.body.authorization_sha256),
    requesting_file_sha256: fileSha256,
    consumption_ledger: claim.body.consumption_ledger
  };
}
function terminalReceipt(requestingReceiptValue, artifact2, fileSha256) {
  return {
    ...requestingReceiptValue,
    state: artifact2.body.state,
    terminal_at: artifact2.body.terminal_at,
    terminal_path: terminalPath(
      path.dirname(requestingReceiptValue.reservation_path),
      artifact2.body.authorization_sha256
    ),
    terminal_file_sha256: fileSha256,
    http_status: artifact2.body.http_status,
    response_body_sha256: artifact2.body.response_body_sha256,
    report_request_id_sha256: artifact2.body.report_request_id_sha256,
    error_code: artifact2.body.error_code
  };
}
async function scanAuthorizations(custody, binding2) {
  const namesBefore = (await readdir(custody.directory)).sort();
  const allowed = namesBefore.filter(
    (name) => name !== IDENTITY_FILE_NAME && name !== HEAD_FILE_NAME
  );
  const claims = /* @__PURE__ */ new Map();
  const requesting = /* @__PURE__ */ new Map();
  const terminal = /* @__PURE__ */ new Map();
  for (const name of allowed) {
    const claimMatch = RESERVATION_FILE_PATTERN.exec(name);
    const requestingMatch = REQUESTING_FILE_PATTERN.exec(name);
    const terminalMatch = TERMINAL_FILE_PATTERN.exec(name);
    if (!claimMatch && !requestingMatch && !terminalMatch) {
      fail("LEDGER_CORRUPT", `ledger contains unexpected entry: ${name}`);
    }
    const authorizationSha256 = (claimMatch ?? requestingMatch ?? terminalMatch)?.[1];
    if (!authorizationSha256) fail("LEDGER_CORRUPT", `ledger entry name is invalid: ${name}`);
    const target = claimMatch ? claims : requestingMatch ? requesting : terminal;
    if (target.has(authorizationSha256)) {
      fail("LEDGER_CORRUPT", `ledger contains duplicate state for ${authorizationSha256}`);
    }
    target.set(
      authorizationSha256,
      await readBoundJsonFile(path.join(custody.directory, name), `ledger entry ${name}`)
    );
  }
  const namesAfter = (await readdir(custody.directory)).sort();
  if (!exactJsonEqual(namesBefore, namesAfter)) {
    fail("LEDGER_CHANGED_DURING_READ", "ledger inventory changed while being read");
  }
  assertSameDirectoryCustody(custody, await inspectDirectoryCustody(custody.directory));
  const result = /* @__PURE__ */ new Map();
  const allAuthorizationShas = [.../* @__PURE__ */ new Set([
    ...claims.keys(),
    ...requesting.keys(),
    ...terminal.keys()
  ])].sort();
  for (const authorizationSha256 of allAuthorizationShas) {
    const claimFile = claims.get(authorizationSha256);
    if (!claimFile) {
      fail("LEDGER_CORRUPT", `authorization ${authorizationSha256} has state without claim`);
    }
    const claim = parseClaimArtifact(claimFile.value, authorizationSha256, binding2);
    const requestingFile = requesting.get(authorizationSha256) ?? null;
    const parsedRequesting = requestingFile ? parseRequestingArtifact(
      requestingFile.value,
      authorizationSha256,
      binding2,
      claim,
      claimFile.sha256
    ) : null;
    const terminalFile = terminal.get(authorizationSha256) ?? null;
    if (terminalFile && !parsedRequesting) {
      fail("LEDGER_CORRUPT", `authorization ${authorizationSha256} is terminal without REQUESTING`);
    }
    const parsedTerminal = terminalFile && parsedRequesting && requestingFile ? parseTerminalArtifact(
      terminalFile.value,
      authorizationSha256,
      binding2,
      claim,
      parsedRequesting,
      claimFile.sha256,
      requestingFile.sha256
    ) : null;
    result.set(authorizationSha256, {
      claim,
      claim_file_sha256: claimFile.sha256,
      requesting: parsedRequesting,
      requesting_file_sha256: requestingFile?.sha256 ?? null,
      terminal: parsedTerminal,
      terminal_file_sha256: terminalFile?.sha256 ?? null
    });
  }
  return result;
}
function ledgerHeadEventsFromScan(scanned) {
  const events = [];
  for (const [authorizationSha256, entry] of scanned.entries()) {
    events.push({
      file_name: path.basename(reservationPath("/", authorizationSha256)),
      file_sha256: entry.claim_file_sha256,
      authorization_sha256: authorizationSha256,
      state: "CLAIMED"
    });
    if (entry.requesting && entry.requesting_file_sha256) {
      events.push({
        file_name: path.basename(requestingPath("/", authorizationSha256)),
        file_sha256: entry.requesting_file_sha256,
        authorization_sha256: authorizationSha256,
        state: "REQUESTING"
      });
    }
    if (entry.terminal && entry.terminal_file_sha256) {
      events.push({
        file_name: path.basename(terminalPath("/", authorizationSha256)),
        file_sha256: entry.terminal_file_sha256,
        authorization_sha256: authorizationSha256,
        state: entry.terminal.body.state
      });
    }
  }
  return events.sort((left, right) => left.file_name < right.file_name ? -1 : left.file_name > right.file_name ? 1 : 0);
}
function ledgerHeadSnapshot(directory, artifact2, artifactSha256) {
  return {
    artifact_path: path.join(directory, HEAD_FILE_NAME),
    artifact_sha256: artifactSha256,
    previous_head_artifact_sha256: artifact2.body.previous_head_artifact_sha256,
    event_count: artifact2.body.event_count,
    events: artifact2.body.events,
    events_sha256: artifact2.body.events_sha256,
    updated_at: artifact2.body.updated_at,
    at_most_once_scope: "INTACT_SINGLE_CUSTODY_DIRECTORY",
    hostile_same_uid_resistance_claimed: false,
    distributed_at_most_once_claimed: false
  };
}
async function advanceLedgerHead(custody, identityArtifactSha256, previous, actualEvents, updatedAt) {
  const headPath = path.join(custody.directory, HEAD_FILE_NAME);
  const sortedActualEvents = [...actualEvents].sort((left, right) => left.file_name < right.file_name ? -1 : left.file_name > right.file_name ? 1 : 0);
  const current = await readBoundJsonFile(headPath, "ledger head before advance");
  if (current.sha256 !== previous.artifact_sha256) {
    fail("LEDGER_CONCURRENT_UPDATE", "ledger head changed before event commit");
  }
  const next = buildLedgerHead(
    identityArtifactSha256,
    previous.artifact_sha256,
    sortedActualEvents,
    strictInstant(updatedAt, "ledger head updated_at")
  );
  const temporaryName = `.ledger-head.${randomUUID()}.tmp`;
  if (!HEAD_TEMP_FILE_PATTERN.test(temporaryName)) {
    fail("INVALID_INPUT", "ledger head temporary filename is invalid");
  }
  const temporaryPath = path.join(custody.directory, temporaryName);
  let temporaryWritten = false;
  try {
    await writeExclusiveJsonFile(temporaryPath, next, "next ledger head");
    temporaryWritten = true;
    const currentAgain = await readBoundJsonFile(headPath, "ledger head before atomic replace");
    if (currentAgain.sha256 !== previous.artifact_sha256) {
      fail("LEDGER_CONCURRENT_UPDATE", "ledger head changed during event commit");
    }
    await rename(temporaryPath, headPath);
    temporaryWritten = false;
    await fsyncDirectory(custody);
    const written = await readBoundJsonFile(headPath, "ledger head after atomic replace");
    const parsed = parseLedgerHead(
      written.value,
      written.sha256,
      identityArtifactSha256,
      sortedActualEvents
    );
    return ledgerHeadSnapshot(custody.directory, parsed, written.sha256);
  } finally {
    if (temporaryWritten) await unlink(temporaryPath).catch(() => {
    });
  }
}
function entryReceipt(directory, entry) {
  const claimed = claimReceipt(directory, entry.claim, entry.claim_file_sha256);
  if (!entry.requesting || !entry.requesting_file_sha256) return claimed;
  const request = requestingReceipt(
    directory,
    entry.claim,
    entry.claim_file_sha256,
    entry.requesting,
    entry.requesting_file_sha256
  );
  if (!entry.terminal || !entry.terminal_file_sha256) return request;
  return terminalReceipt(request, entry.terminal, entry.terminal_file_sha256);
}
function assertExpectedBindingMatches(expected, actual) {
  if (!exactJsonEqual(expected, actual)) {
    fail("LEDGER_BINDING_MISMATCH", "signed ledger binding does not match local custody");
  }
}
async function bootstrapWalmartItemReportReissueConsumptionLedgerV2(options) {
  const directory = normalizedStateDirectory(options.state_directory);
  try {
    await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      fail("LEDGER_CUSTODY_INVALID", "state directory cannot be created");
    }
  }
  const custody = await inspectDirectoryCustody(directory);
  const entries = await readdir(directory);
  if (entries.length !== 0) {
    fail("LEDGER_ALREADY_INITIALIZED", "ledger bootstrap requires an empty custody directory");
  }
  const uuid = options.random_uuid ?? randomUUID;
  const ledgerUuid = uuid();
  const epochUuid = uuid();
  if (!UUID_PATTERN.test(ledgerUuid) || !UUID_PATTERN.test(epochUuid)) {
    fail("INVALID_INPUT", "ledger bootstrap UUID source returned invalid UUIDs");
  }
  const body = {
    ledger_id: `ledger-${ledgerUuid}`,
    ledger_epoch: `epoch-${epochUuid}`,
    state_directory_path_sha256: custody.state_directory_path_sha256,
    directory_identity_sha256: custody.directory_identity_sha256,
    created_at: strictInstant(options.now, "ledger created_at")
  };
  const identity = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_IDENTITY_SCHEMA,
    body,
    body_sha256: sha256(canonicalWalmartItemReportJson(body))
  };
  const identityPath = path.join(directory, IDENTITY_FILE_NAME);
  let written;
  try {
    written = await writeExclusiveJsonFile(identityPath, identity, "ledger identity artifact");
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("LEDGER_ALREADY_INITIALIZED", "ledger identity already exists");
    }
    throw error;
  }
  await fsyncDirectory(custody);
  const parsedIdentity = parseIdentity2(written.value, written.sha256, custody);
  const binding2 = bindingFromIdentity(parsedIdentity, written.sha256);
  const headPath = path.join(directory, HEAD_FILE_NAME);
  const initialHead = buildLedgerHead(
    written.sha256,
    null,
    [],
    body.created_at
  );
  const writtenHead = await writeExclusiveJsonFile(
    headPath,
    initialHead,
    "initial ledger head"
  ).catch((error) => {
    if (error?.code === "EEXIST") {
      fail("LEDGER_ALREADY_INITIALIZED", "ledger head already exists");
    }
    throw error;
  });
  await fsyncDirectory(custody);
  parseLedgerHead(writtenHead.value, writtenHead.sha256, written.sha256, []);
  return {
    state_directory: directory,
    identity_artifact_path: identityPath,
    head_artifact_path: headPath,
    head_artifact_sha256: writtenHead.sha256,
    binding: binding2
  };
}
async function openWalmartItemReportReissueConsumptionLedgerV2(options) {
  const expected = parseBinding(options.expected_binding);
  const custody = await inspectDirectoryCustody(options.state_directory);
  if (expected.state_directory_path_sha256 !== custody.state_directory_path_sha256 || expected.directory_identity_sha256 !== custody.directory_identity_sha256) {
    fail("LEDGER_BINDING_MISMATCH", "signed path/directory identity does not match custody");
  }
  const identityPath = path.join(custody.directory, IDENTITY_FILE_NAME);
  const identityFile = await readBoundJsonFile(identityPath, "ledger identity artifact");
  const identity = parseIdentity2(identityFile.value, identityFile.sha256, custody);
  const actual = bindingFromIdentity(identity, identityFile.sha256);
  assertExpectedBindingMatches(expected, actual);
  const scanned = await scanAuthorizations(custody, actual);
  const actualEvents = ledgerHeadEventsFromScan(scanned);
  const headPath = path.join(custody.directory, HEAD_FILE_NAME);
  const headFile = await readBoundJsonFile(headPath, "ledger head");
  const headArtifact = parseLedgerHead(
    headFile.value,
    headFile.sha256,
    identityFile.sha256,
    actualEvents
  );
  const namesAfterHead = (await readdir(custody.directory)).sort();
  if (namesAfterHead.some((name) => HEAD_TEMP_FILE_PATTERN.test(name))) {
    fail("LEDGER_CORRUPT", "ledger contains an incomplete head update");
  }
  assertSameDirectoryCustody(custody, await inspectDirectoryCustody(custody.directory));
  return {
    state_directory: custody.directory,
    identity_artifact_path: identityPath,
    binding: actual,
    head: ledgerHeadSnapshot(custody.directory, headArtifact, headFile.sha256),
    authorizations: [...scanned.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, entry]) => entryReceipt(custody.directory, entry))
  };
}
function parseClaimReceipt(value, directory, binding2) {
  const raw = record(value, "claim receipt");
  exactKeys(raw, [
    "authorization_sha256",
    "claim_id",
    "claimed_at",
    "consumption_ledger",
    "reservation_file_sha256",
    "reservation_path",
    "state"
  ], "claim receipt", "CLAIM_BINDING_MISMATCH");
  const authorizationSha256 = digest(
    raw.authorization_sha256,
    "claim receipt authorization SHA",
    "CLAIM_BINDING_MISMATCH"
  );
  const parsed = {
    authorization_sha256: authorizationSha256,
    state: raw.state === "CLAIMED" ? "CLAIMED" : fail("CLAIM_BINDING_MISMATCH", "claim receipt state is invalid"),
    claim_id: safeIdentifier(raw.claim_id, "claim receipt claim_id", "CLAIM_BINDING_MISMATCH"),
    claimed_at: strictInstant(
      typeof raw.claimed_at === "string" ? raw.claimed_at : "",
      "claim receipt claimed_at"
    ),
    reservation_path: typeof raw.reservation_path === "string" ? raw.reservation_path : fail("CLAIM_BINDING_MISMATCH", "claim receipt reservation_path is invalid"),
    reservation_file_sha256: digest(
      raw.reservation_file_sha256,
      "claim receipt file SHA",
      "CLAIM_BINDING_MISMATCH"
    ),
    consumption_ledger: parseBinding(raw.consumption_ledger, "CLAIM_BINDING_MISMATCH")
  };
  if (parsed.reservation_path !== reservationPath(directory, authorizationSha256) || !exactJsonEqual(parsed.consumption_ledger, binding2)) {
    fail("CLAIM_BINDING_MISMATCH", "claim receipt path/ledger binding is invalid");
  }
  return parsed;
}
function parseRequestingReceipt(value, directory, binding2) {
  const raw = record(value, "REQUESTING receipt");
  exactKeys(raw, [
    "authorization_sha256",
    "claim_id",
    "claimed_at",
    "consumption_ledger",
    "requesting_at",
    "requesting_file_sha256",
    "requesting_path",
    "reservation_file_sha256",
    "reservation_path",
    "state"
  ], "REQUESTING receipt", "REQUESTING_BINDING_MISMATCH");
  const authorizationSha256 = digest(
    raw.authorization_sha256,
    "REQUESTING receipt authorization SHA",
    "REQUESTING_BINDING_MISMATCH"
  );
  const claimedAt = strictInstant(
    typeof raw.claimed_at === "string" ? raw.claimed_at : "",
    "REQUESTING receipt claimed_at"
  );
  const requestingAt = strictInstant(
    typeof raw.requesting_at === "string" ? raw.requesting_at : "",
    "REQUESTING receipt requesting_at"
  );
  if (Date.parse(requestingAt) < Date.parse(claimedAt)) {
    fail("REQUESTING_BINDING_MISMATCH", "REQUESTING receipt time order is invalid");
  }
  const parsed = {
    authorization_sha256: authorizationSha256,
    state: raw.state === "REQUESTING" ? "REQUESTING" : fail("REQUESTING_BINDING_MISMATCH", "REQUESTING receipt state is invalid"),
    claim_id: safeIdentifier(
      raw.claim_id,
      "REQUESTING receipt claim_id",
      "REQUESTING_BINDING_MISMATCH"
    ),
    claimed_at: claimedAt,
    requesting_at: requestingAt,
    reservation_path: typeof raw.reservation_path === "string" ? raw.reservation_path : fail("REQUESTING_BINDING_MISMATCH", "REQUESTING receipt reservation_path is invalid"),
    reservation_file_sha256: digest(
      raw.reservation_file_sha256,
      "REQUESTING receipt reservation SHA",
      "REQUESTING_BINDING_MISMATCH"
    ),
    requesting_path: typeof raw.requesting_path === "string" ? raw.requesting_path : fail("REQUESTING_BINDING_MISMATCH", "REQUESTING receipt path is invalid"),
    requesting_file_sha256: digest(
      raw.requesting_file_sha256,
      "REQUESTING receipt file SHA",
      "REQUESTING_BINDING_MISMATCH"
    ),
    consumption_ledger: parseBinding(
      raw.consumption_ledger,
      "REQUESTING_BINDING_MISMATCH"
    )
  };
  if (parsed.reservation_path !== reservationPath(directory, authorizationSha256) || parsed.requesting_path !== requestingPath(directory, authorizationSha256) || !exactJsonEqual(parsed.consumption_ledger, binding2)) {
    fail("REQUESTING_BINDING_MISMATCH", "REQUESTING receipt path/ledger binding is invalid");
  }
  return parsed;
}
function newClaimId(randomUuid) {
  const uuid = randomUuid();
  if (!UUID_PATTERN.test(uuid)) fail("INVALID_INPUT", "claim UUID source returned an invalid UUID");
  return `claim-${uuid}`;
}
async function claimWalmartItemReportReissueAuthorizationV2(options) {
  const authorizationSha256 = digest(options.authorization_sha256, "authorization_sha256");
  const opened = await openWalmartItemReportReissueConsumptionLedgerV2(options);
  if (opened.authorizations.some((entry) => entry.authorization_sha256 === authorizationSha256)) {
    fail("AUTHORIZATION_ALREADY_CONSUMED", "authorization SHA is already claimed or consumed");
  }
  const body = {
    authorization_sha256: authorizationSha256,
    state: "CLAIMED",
    claim_id: newClaimId(options.random_uuid ?? randomUUID),
    claimed_at: strictInstant(options.claimed_at, "claimed_at"),
    consumption_ledger: opened.binding
  };
  const artifact2 = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_CLAIM_SCHEMA,
    body,
    body_sha256: sha256(canonicalWalmartItemReportJson(body))
  };
  const custody = await inspectDirectoryCustody(opened.state_directory);
  let written;
  try {
    written = await writeExclusiveJsonFile(
      reservationPath(opened.state_directory, authorizationSha256),
      artifact2,
      "authorization claim"
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("AUTHORIZATION_ALREADY_CONSUMED", "authorization SHA lost exclusive-create race");
    }
    throw error;
  }
  await fsyncDirectory(custody);
  const parsed = parseClaimArtifact(written.value, authorizationSha256, opened.binding);
  await advanceLedgerHead(
    custody,
    opened.binding.identity_artifact_sha256,
    opened.head,
    [
      ...opened.head.events,
      {
        file_name: path.basename(reservationPath("/", authorizationSha256)),
        file_sha256: written.sha256,
        authorization_sha256: authorizationSha256,
        state: "CLAIMED"
      }
    ],
    body.claimed_at
  );
  const verified = await openWalmartItemReportReissueConsumptionLedgerV2(options);
  const receipt = verified.authorizations.find(
    (entry) => entry.authorization_sha256 === authorizationSha256
  );
  if (!receipt || receipt.state !== "CLAIMED" || receipt.reservation_file_sha256 !== written.sha256 || receipt.claim_id !== parsed.body.claim_id) {
    fail("LEDGER_CORRUPT", "durable claim could not be re-read exactly");
  }
  return receipt;
}
async function markWalmartItemReportReissueAuthorizationRequestingV2(options) {
  const opened = await openWalmartItemReportReissueConsumptionLedgerV2(options);
  const claim = parseClaimReceipt(options.claim, opened.state_directory, opened.binding);
  const current = opened.authorizations.find(
    (entry) => entry.authorization_sha256 === claim.authorization_sha256
  );
  if (!current || current.state !== "CLAIMED") {
    fail("AUTHORIZATION_ALREADY_CONSUMED", "authorization is not in the unique CLAIMED state");
  }
  if (!exactJsonEqual(current, claim)) {
    fail("CLAIM_BINDING_MISMATCH", "claim receipt differs from durable claim bytes");
  }
  const requestingAt = strictInstant(options.requesting_at, "requesting_at");
  if (Date.parse(requestingAt) < Date.parse(claim.claimed_at)) {
    fail("INVALID_INPUT", "requesting_at cannot precede claimed_at");
  }
  const body = {
    authorization_sha256: claim.authorization_sha256,
    state: "REQUESTING",
    claim_id: claim.claim_id,
    claimed_at: claim.claimed_at,
    requesting_at: requestingAt,
    reservation_file_sha256: claim.reservation_file_sha256,
    consumption_ledger: opened.binding
  };
  const artifact2 = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_REQUESTING_SCHEMA,
    body,
    body_sha256: sha256(canonicalWalmartItemReportJson(body))
  };
  const custody = await inspectDirectoryCustody(opened.state_directory);
  let written;
  try {
    written = await writeExclusiveJsonFile(
      requestingPath(opened.state_directory, claim.authorization_sha256),
      artifact2,
      "authorization REQUESTING fence"
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("AUTHORIZATION_ALREADY_CONSUMED", "authorization is already REQUESTING or terminal");
    }
    throw error;
  }
  await fsyncDirectory(custody);
  const parsed = parseRequestingArtifact(
    written.value,
    claim.authorization_sha256,
    opened.binding,
    {
      schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_CLAIM_SCHEMA,
      body: {
        authorization_sha256: claim.authorization_sha256,
        state: "CLAIMED",
        claim_id: claim.claim_id,
        claimed_at: claim.claimed_at,
        consumption_ledger: claim.consumption_ledger
      },
      body_sha256: ""
    },
    claim.reservation_file_sha256
  );
  await advanceLedgerHead(
    custody,
    opened.binding.identity_artifact_sha256,
    opened.head,
    [
      ...opened.head.events,
      {
        file_name: path.basename(requestingPath("/", claim.authorization_sha256)),
        file_sha256: written.sha256,
        authorization_sha256: claim.authorization_sha256,
        state: "REQUESTING"
      }
    ],
    body.requesting_at
  );
  const verified = await openWalmartItemReportReissueConsumptionLedgerV2(options);
  const receipt = verified.authorizations.find(
    (entry) => entry.authorization_sha256 === claim.authorization_sha256
  );
  if (!receipt || receipt.state !== "REQUESTING" || receipt.requesting_file_sha256 !== written.sha256 || receipt.claim_id !== parsed.body.claim_id) {
    fail("LEDGER_CORRUPT", "durable REQUESTING fence could not be re-read exactly");
  }
  return receipt;
}
async function consumeWalmartItemReportReissueAuthorizationV2(options) {
  const claim = await claimWalmartItemReportReissueAuthorizationV2(options);
  return markWalmartItemReportReissueAuthorizationRequestingV2({
    state_directory: options.state_directory,
    expected_binding: options.expected_binding,
    claim,
    requesting_at: options.requesting_at
  });
}
function parseTerminalOutcome(value, requestingAt) {
  const raw = record(value, "terminal outcome");
  exactKeys(raw, [
    "error_code",
    "http_status",
    "report_request_id_sha256",
    "response_body_sha256",
    "state",
    "terminal_at"
  ], "terminal outcome", "INVALID_INPUT");
  const parsedTerminalState = terminalState(
    raw.state,
    "terminal outcome state",
    "INVALID_INPUT"
  );
  const terminalAt = strictInstant(
    raw.terminal_at instanceof Date || typeof raw.terminal_at === "string" ? raw.terminal_at : void 0,
    "terminal_at"
  );
  if (Date.parse(terminalAt) < Date.parse(requestingAt)) {
    fail("INVALID_INPUT", "terminal_at cannot precede requesting_at");
  }
  const httpStatus = nullableHttpStatus(
    raw.http_status,
    "terminal outcome HTTP status",
    "INVALID_INPUT"
  );
  const parsed = {
    state: parsedTerminalState,
    terminal_at: terminalAt,
    http_status: httpStatus,
    response_body_sha256: nullableDigest(raw.response_body_sha256, "response body SHA"),
    report_request_id_sha256: nullableDigest(
      raw.report_request_id_sha256,
      "report request ID SHA"
    ),
    error_code: nullableErrorCode(raw.error_code, "terminal error_code")
  };
  if (parsed.state === "SUCCEEDED" && (parsed.http_status === null || parsed.http_status < 200 || parsed.http_status > 299 || parsed.response_body_sha256 === null || parsed.report_request_id_sha256 === null || parsed.error_code !== null)) {
    fail("INVALID_INPUT", "SUCCEEDED outcome requires complete successful response evidence");
  }
  if (parsed.state !== "SUCCEEDED" && parsed.error_code === null) {
    fail("INVALID_INPUT", "non-success outcome requires an error_code");
  }
  return parsed;
}
async function terminalizeWalmartItemReportReissueAuthorizationV2(options) {
  const opened = await openWalmartItemReportReissueConsumptionLedgerV2(options);
  const request = parseRequestingReceipt(
    options.requesting,
    opened.state_directory,
    opened.binding
  );
  const current = opened.authorizations.find(
    (entry) => entry.authorization_sha256 === request.authorization_sha256
  );
  if (!current || current.state !== "REQUESTING") {
    fail("AUTHORIZATION_ALREADY_CONSUMED", "authorization is not in terminalizable REQUESTING");
  }
  if (!exactJsonEqual(current, request)) {
    fail("REQUESTING_BINDING_MISMATCH", "REQUESTING receipt differs from durable bytes");
  }
  const outcome = parseTerminalOutcome(options.outcome, request.requesting_at);
  const body = {
    authorization_sha256: request.authorization_sha256,
    state: outcome.state,
    claim_id: request.claim_id,
    claimed_at: request.claimed_at,
    requesting_at: request.requesting_at,
    terminal_at: outcome.terminal_at,
    reservation_file_sha256: request.reservation_file_sha256,
    requesting_file_sha256: request.requesting_file_sha256,
    http_status: outcome.http_status,
    response_body_sha256: outcome.response_body_sha256,
    report_request_id_sha256: outcome.report_request_id_sha256,
    error_code: outcome.error_code,
    consumption_ledger: opened.binding
  };
  const artifact2 = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_CONSUMPTION_LEDGER_V2_TERMINAL_SCHEMA,
    body,
    body_sha256: sha256(canonicalWalmartItemReportJson(body))
  };
  const custody = await inspectDirectoryCustody(opened.state_directory);
  let written;
  try {
    written = await writeExclusiveJsonFile(
      terminalPath(opened.state_directory, request.authorization_sha256),
      artifact2,
      "authorization terminal artifact"
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail("AUTHORIZATION_ALREADY_CONSUMED", "authorization already has a terminal outcome");
    }
    throw error;
  }
  await fsyncDirectory(custody);
  await advanceLedgerHead(
    custody,
    opened.binding.identity_artifact_sha256,
    opened.head,
    [
      ...opened.head.events,
      {
        file_name: path.basename(terminalPath("/", request.authorization_sha256)),
        file_sha256: written.sha256,
        authorization_sha256: request.authorization_sha256,
        state: outcome.state
      }
    ],
    body.terminal_at
  );
  const verified = await openWalmartItemReportReissueConsumptionLedgerV2(options);
  const receipt = verified.authorizations.find(
    (entry) => entry.authorization_sha256 === request.authorization_sha256
  );
  if (!receipt || receipt.state !== outcome.state || !("terminal_file_sha256" in receipt) || receipt.terminal_file_sha256 !== written.sha256) {
    fail("LEDGER_CORRUPT", "durable terminal artifact could not be re-read exactly");
  }
  return receipt;
}

// src/lib/walmart/item-report-reissue-permit.ts
import { createHash as createHash5 } from "node:crypto";
var WALMART_ITEM_REPORT_REISSUE_PERMIT_SCHEMA = "walmart-item-report-reissue-permit/v1";
var WALMART_ITEM_REPORT_REISSUE_ACTION = "WALMART_ITEM_V6_REPORT_CREATE_REISSUE";
var WALMART_ITEM_REPORT_REISSUE_SESSION_SCHEMA = "walmart-item-report-capture-session/v1";
var WALMART_ITEM_REPORT_REISSUE_CAPTURE_ROOT_POLICY = "default-gitignored-capture-root/direct-child/v1";
var WALMART_ITEM_REPORT_REISSUE_MAX_PERMIT_TTL_MS = 30 * 60 * 1e3;
var WALMART_ITEM_REPORT_REISSUE_MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1e3;
var WALMART_ITEM_REPORT_REISSUE_CLOCK_SKEW_MS = 5 * 60 * 1e3;
var WALMART_ITEM_REPORT_REISSUE_CONFIRMATION_PREFIX = "REISSUE_WALMART_ITEM_REPORT_V1";
var WALMART_ITEM_REPORT_REISSUE_EMPTY_BODY_SHA256 = createHash5("sha256").update("{}", "utf8").digest("hex");
var WalmartItemReportReissuePermitError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WalmartItemReportReissuePermitError";
    this.code = code;
  }
};
function fail2(code, message) {
  throw new WalmartItemReportReissuePermitError(code, message);
}
function isRecord5(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function asRecord2(value, label) {
  if (!isRecord5(value)) fail2("INVALID_PERMIT", `${label} must be an object`);
  return value;
}
function assertExactKeys4(raw, expected, label) {
  const actual = Object.keys(raw).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail2("INVALID_PERMIT", `${label} has missing or extra fields`);
  }
}
function exactString2(value, label, maximum = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail2("INVALID_PERMIT", `${label} is invalid`);
  }
  return value;
}
function exactDigest(value, label) {
  const digest5 = exactString2(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(digest5)) {
    fail2("INVALID_PERMIT", `${label} must be a lowercase SHA-256 digest`);
  }
  return digest5;
}
function positiveInteger4(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail2("INVALID_PERMIT", `${label} must be a positive safe integer`);
  }
  return Number(value);
}
function literalZero(value, label) {
  if (value !== 0) fail2("INVALID_PERMIT", `${label} must be zero`);
  return 0;
}
function strictInstant2(value, label) {
  const instant = exactString2(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(instant)) {
    fail2("INVALID_PERMIT", `${label} must be canonical UTC ISO-8601 milliseconds`);
  }
  const parsed = Date.parse(instant);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== instant) {
    fail2("INVALID_PERMIT", `${label} is not a real canonical instant`);
  }
  return instant;
}
function safeIdentifier2(value, label, maximum = 200) {
  const identifier2 = exactString2(value, label, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(identifier2) || identifier2.includes("//") || identifier2.endsWith("/")) {
    fail2("INVALID_PERMIT", `${label} is not a safe identifier`);
  }
  return identifier2;
}
function safeSessionName(value, label) {
  const sessionName = exactString2(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(sessionName) || sessionName === "." || sessionName === "..") {
    fail2("INVALID_PERMIT", `${label} must be one direct-child session name`);
  }
  return sessionName;
}
function decisionReference(value) {
  const reference = exactString2(value, "decision_ref", 2048);
  let parsed;
  try {
    parsed = new URL(reference);
  } catch {
    fail2("INVALID_PERMIT", "decision_ref must be an absolute external reference");
  }
  if (!(/* @__PURE__ */ new Set(["https:", "urn:"])).has(parsed.protocol)) {
    fail2("INVALID_PERMIT", "decision_ref protocol is not approved");
  }
  return reference;
}
function sha256Bytes2(bytes) {
  return createHash5("sha256").update(bytes).digest("hex");
}
function sameCanonical(left, right) {
  return canonicalWalmartItemReportJson(left) === canonicalWalmartItemReportJson(right);
}
function assertDeepExact(actual, expected, label) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      fail2("BINDING_MISMATCH", `${label} differs from the exact expected value`);
    }
    expected.forEach((value, index) => assertDeepExact(actual[index], value, `${label}[${index}]`));
    return;
  }
  if (isRecord5(expected)) {
    const raw = asRecord2(actual, label);
    assertExactKeys4(raw, Object.keys(expected), label);
    for (const key of Object.keys(expected)) {
      assertDeepExact(raw[key], expected[key], `${label}.${key}`);
    }
    return;
  }
  if (!Object.is(actual, expected)) {
    fail2("BINDING_MISMATCH", `${label} differs from the exact expected value`);
  }
}
function parseAccountScope2(value, label) {
  const raw = asRecord2(value, label);
  assertExactKeys4(raw, [
    "channel",
    "seller_account_fingerprint_sha256",
    "store_index"
  ], label);
  if (raw.channel !== "WALMART_US") fail2("INVALID_PERMIT", `${label}.channel is invalid`);
  return {
    channel: "WALMART_US",
    store_index: positiveInteger4(raw.store_index, `${label}.store_index`),
    seller_account_fingerprint_sha256: exactDigest(
      raw.seller_account_fingerprint_sha256,
      `${label}.seller_account_fingerprint_sha256`
    )
  };
}
function parseCorrelation(value, label) {
  const raw = asRecord2(value, label);
  assertExactKeys4(raw, ["id", "sha256"], label);
  const id = exactString2(raw.id, `${label}.id`, 256);
  const sha2567 = exactDigest(raw.sha256, `${label}.sha256`);
  if (sha2567 !== walmartItemReportUtf8Sha256(id)) {
    fail2("INVALID_SESSION_AUTHORITY", `${label} digest does not bind its exact ID`);
  }
  return { id, sha256: sha2567 };
}
function parseWalmartItemReportReissueSessionAuthority(value) {
  const raw = asRecord2(value, "replacement SessionAuthority");
  assertExactKeys4(raw, [
    "account_scope",
    "created_at",
    "primary_correlations",
    "schema_version",
    "session_id",
    "trust_statement"
  ], "replacement SessionAuthority");
  if (raw.schema_version !== WALMART_ITEM_REPORT_REISSUE_SESSION_SCHEMA) {
    fail2("INVALID_SESSION_AUTHORITY", "replacement SessionAuthority schema is invalid");
  }
  const correlations = asRecord2(
    raw.primary_correlations,
    "replacement SessionAuthority.primary_correlations"
  );
  assertExactKeys4(correlations, [
    "create",
    "download_locator",
    "ready_status",
    "report_file"
  ], "replacement SessionAuthority.primary_correlations");
  const trust = asRecord2(raw.trust_statement, "replacement SessionAuthority.trust_statement");
  assertExactKeys4(trust, [
    "adapter_atomic_integrity",
    "tls_server_authenticity_claimed_by_artifact",
    "walmart_signature_claimed"
  ], "replacement SessionAuthority.trust_statement");
  if (trust.adapter_atomic_integrity !== true || trust.walmart_signature_claimed !== false || trust.tls_server_authenticity_claimed_by_artifact !== false) {
    fail2("INVALID_SESSION_AUTHORITY", "replacement SessionAuthority trust statement is invalid");
  }
  const parsed = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_SESSION_SCHEMA,
    session_id: safeIdentifier2(raw.session_id, "replacement SessionAuthority.session_id", 256),
    created_at: strictInstant2(raw.created_at, "replacement SessionAuthority.created_at"),
    account_scope: parseAccountScope2(
      raw.account_scope,
      "replacement SessionAuthority.account_scope"
    ),
    primary_correlations: {
      create: parseCorrelation(correlations.create, "replacement create correlation"),
      ready_status: parseCorrelation(correlations.ready_status, "replacement READY correlation"),
      download_locator: parseCorrelation(
        correlations.download_locator,
        "replacement locator correlation"
      ),
      report_file: parseCorrelation(correlations.report_file, "replacement file correlation")
    },
    trust_statement: {
      adapter_atomic_integrity: true,
      walmart_signature_claimed: false,
      tls_server_authenticity_claimed_by_artifact: false
    }
  };
  const ids = Object.values(parsed.primary_correlations).map((correlation) => correlation.id);
  const digests = Object.values(parsed.primary_correlations).map((correlation) => correlation.sha256);
  if (new Set(ids).size !== 4 || new Set(digests).size !== 4) {
    fail2("INVALID_SESSION_AUTHORITY", "replacement correlations must be distinct");
  }
  return parsed;
}
function parsePriorAbsenceOnly(value) {
  const raw = asRecord2(value, "prior_absence_only");
  assertExactKeys4(raw, [
    "candidate_count",
    "create_manifest_sha256",
    "duplicate_request_id_count",
    "exact_correlation_match_count",
    "manual_review_reason_code",
    "manual_review_retry_forbidden",
    "manual_review_sha256",
    "observed_row_count",
    "original_request_complete_written",
    "outcome",
    "reconciliation_complete_sha256",
    "reconciliation_completed_at",
    "reconciliation_id",
    "reconciliation_result_sha256",
    "reconciliation_scope_sha256",
    "request_id_adopted",
    "request_reserved_sha256",
    "response_set_sha256",
    "session_authority_sha256",
    "session_id",
    "session_name"
  ], "prior_absence_only");
  if (raw.manual_review_reason_code !== "AMBIGUOUS_POST_NETWORK_OUTCOME" || raw.manual_review_retry_forbidden !== true || raw.outcome !== "ABSENCE_ONLY" || raw.request_id_adopted !== false || raw.original_request_complete_written !== false) {
    fail2("PRIOR_EVIDENCE_NOT_ABSENCE_ONLY", "prior evidence is not the exact safe reissue basis");
  }
  const reconciliationId = exactString2(raw.reconciliation_id, "prior reconciliation_id", 64);
  if (!/^[a-f0-9]{24}$/u.test(reconciliationId)) {
    fail2("INVALID_PERMIT", "prior reconciliation_id is invalid");
  }
  return {
    session_name: safeSessionName(raw.session_name, "prior session_name"),
    session_id: safeIdentifier2(raw.session_id, "prior session_id", 256),
    session_authority_sha256: exactDigest(
      raw.session_authority_sha256,
      "prior session_authority_sha256"
    ),
    create_manifest_sha256: exactDigest(
      raw.create_manifest_sha256,
      "prior create_manifest_sha256"
    ),
    request_reserved_sha256: exactDigest(
      raw.request_reserved_sha256,
      "prior request_reserved_sha256"
    ),
    manual_review_sha256: exactDigest(raw.manual_review_sha256, "prior manual_review_sha256"),
    manual_review_reason_code: "AMBIGUOUS_POST_NETWORK_OUTCOME",
    manual_review_retry_forbidden: true,
    reconciliation_id: reconciliationId,
    reconciliation_scope_sha256: exactDigest(
      raw.reconciliation_scope_sha256,
      "prior reconciliation_scope_sha256"
    ),
    reconciliation_result_sha256: exactDigest(
      raw.reconciliation_result_sha256,
      "prior reconciliation_result_sha256"
    ),
    reconciliation_complete_sha256: exactDigest(
      raw.reconciliation_complete_sha256,
      "prior reconciliation_complete_sha256"
    ),
    response_set_sha256: exactDigest(raw.response_set_sha256, "prior response_set_sha256"),
    reconciliation_completed_at: strictInstant2(
      raw.reconciliation_completed_at,
      "prior reconciliation_completed_at"
    ),
    outcome: "ABSENCE_ONLY",
    observed_row_count: literalZero(raw.observed_row_count, "prior observed_row_count"),
    candidate_count: literalZero(raw.candidate_count, "prior candidate_count"),
    exact_correlation_match_count: literalZero(
      raw.exact_correlation_match_count,
      "prior exact_correlation_match_count"
    ),
    duplicate_request_id_count: literalZero(
      raw.duplicate_request_id_count,
      "prior duplicate_request_id_count"
    ),
    request_id_adopted: false,
    original_request_complete_written: false
  };
}
function replacementBinding(input) {
  const accountScope = parseAccountScope2(input.account_scope, "replacement account_scope");
  const authority = parseWalmartItemReportReissueSessionAuthority(input.session_authority);
  if (!sameCanonical(accountScope, authority.account_scope)) {
    fail2("ACCOUNT_SCOPE_MISMATCH", "replacement SessionAuthority account scope differs");
  }
  const expectedManifest = buildWalmartItemReportV6CreateRequestManifest({
    account_scope: accountScope,
    request_correlation_id_sha256: authority.primary_correlations.create.sha256
  });
  assertDeepExact(
    input.create_request_manifest,
    expectedManifest,
    "replacement create request manifest"
  );
  return {
    capture_root_policy_id: WALMART_ITEM_REPORT_REISSUE_CAPTURE_ROOT_POLICY,
    session_name: safeSessionName(input.session_name, "replacement session_name"),
    session_id: authority.session_id,
    session_authority_schema_version: WALMART_ITEM_REPORT_REISSUE_SESSION_SCHEMA,
    session_authority: authority,
    session_authority_sha256: walmartItemReportSha256(authority),
    create_request_manifest_schema_version: WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA,
    create_request_manifest: expectedManifest,
    create_request_manifest_sha256: walmartItemReportSha256(expectedManifest),
    create_request_correlation_id_sha256: authority.primary_correlations.create.sha256
  };
}
function parseReplacement(value) {
  const raw = asRecord2(value, "replacement");
  assertExactKeys4(raw, [
    "capture_root_policy_id",
    "create_request_correlation_id_sha256",
    "create_request_manifest",
    "create_request_manifest_schema_version",
    "create_request_manifest_sha256",
    "session_authority",
    "session_authority_schema_version",
    "session_authority_sha256",
    "session_id",
    "session_name"
  ], "replacement");
  if (raw.capture_root_policy_id !== WALMART_ITEM_REPORT_REISSUE_CAPTURE_ROOT_POLICY || raw.session_authority_schema_version !== WALMART_ITEM_REPORT_REISSUE_SESSION_SCHEMA || raw.create_request_manifest_schema_version !== WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA) {
    fail2("INVALID_PERMIT", "replacement schema/root policy is invalid");
  }
  const authority = parseWalmartItemReportReissueSessionAuthority(raw.session_authority);
  const expectedManifest = buildWalmartItemReportV6CreateRequestManifest({
    account_scope: authority.account_scope,
    request_correlation_id_sha256: authority.primary_correlations.create.sha256
  });
  assertDeepExact(raw.create_request_manifest, expectedManifest, "replacement.create_request_manifest");
  const sessionId = safeIdentifier2(raw.session_id, "replacement session_id", 256);
  const sessionAuthoritySha = exactDigest(
    raw.session_authority_sha256,
    "replacement session_authority_sha256"
  );
  const createManifestSha = exactDigest(
    raw.create_request_manifest_sha256,
    "replacement create_request_manifest_sha256"
  );
  const createCorrelationSha = exactDigest(
    raw.create_request_correlation_id_sha256,
    "replacement create_request_correlation_id_sha256"
  );
  if (sessionId !== authority.session_id || sessionAuthoritySha !== walmartItemReportSha256(authority) || createManifestSha !== walmartItemReportSha256(expectedManifest) || createCorrelationSha !== authority.primary_correlations.create.sha256) {
    fail2("BINDING_MISMATCH", "replacement full preimages do not match their exact identities/hashes");
  }
  return {
    capture_root_policy_id: WALMART_ITEM_REPORT_REISSUE_CAPTURE_ROOT_POLICY,
    session_name: safeSessionName(raw.session_name, "replacement session_name"),
    session_id: sessionId,
    session_authority_schema_version: WALMART_ITEM_REPORT_REISSUE_SESSION_SCHEMA,
    session_authority: authority,
    session_authority_sha256: sessionAuthoritySha,
    create_request_manifest_schema_version: WALMART_ITEM_REPORT_CREATE_REQUEST_MANIFEST_SCHEMA,
    create_request_manifest: expectedManifest,
    create_request_manifest_sha256: createManifestSha,
    create_request_correlation_id_sha256: createCorrelationSha
  };
}
function fixedAuthorization() {
  return {
    report_create_post_authorized: true,
    maximum_create_post_calls: 1,
    maximum_oauth_token_calls: 1,
    maximum_walmart_api_calls: 1,
    maximum_request_timeout_ms: 6e4,
    retry_attempts_allowed: 0,
    automatic_replay_allowed: false,
    paid_provider_calls_allowed: false,
    method: "POST",
    endpoint: "/v3/reports/reportRequests",
    report_type: "ITEM",
    report_version: "v6",
    request_body_sha256: WALMART_ITEM_REPORT_REISSUE_EMPTY_BODY_SHA256,
    request_id_adoption_from_prior: false,
    original_session_mutation_allowed: false,
    database_writes_allowed: false,
    model_calls_allowed: false,
    listing_mutations_allowed: false,
    scheduled_execution_allowed: false
  };
}
function fixedTrustBoundary() {
  return {
    external_owner_custody_required: true,
    independently_supplied_permit_sha256_required: true,
    exact_canonical_artifact_bytes_required: true,
    cryptographic_owner_authentication: false,
    artifact_alone_proves_owner_authorship: false
  };
}
function fixedRiskAcknowledgement() {
  return {
    absence_only_is_not_proof_original_post_failed: true,
    duplicate_report_request_risk_accepted: true,
    original_session_remains_manual_review: true,
    original_request_id_must_not_be_adopted: true
  };
}
function parseFixedObject(value, expected, label) {
  assertDeepExact(value, expected, label);
  return expected;
}
function parseFreshness(value) {
  const raw = asRecord2(value, "freshness");
  assertExactKeys4(raw, ["expires_at", "issued_at", "prior_evidence_fresh_until"], "freshness");
  return {
    issued_at: strictInstant2(raw.issued_at, "freshness.issued_at"),
    expires_at: strictInstant2(raw.expires_at, "freshness.expires_at"),
    prior_evidence_fresh_until: strictInstant2(
      raw.prior_evidence_fresh_until,
      "freshness.prior_evidence_fresh_until"
    )
  };
}
function validateFreshnessShape(prior, replacement, freshness) {
  const completedAt = Date.parse(prior.reconciliation_completed_at);
  const replacementPreparedAt = Date.parse(replacement.session_authority.created_at);
  const issuedAt = Date.parse(freshness.issued_at);
  const expiresAt = Date.parse(freshness.expires_at);
  const evidenceFreshUntil = Date.parse(freshness.prior_evidence_fresh_until);
  if (replacementPreparedAt < completedAt || replacementPreparedAt > issuedAt || issuedAt - replacementPreparedAt > WALMART_ITEM_REPORT_REISSUE_MAX_PERMIT_TTL_MS || issuedAt < completedAt || evidenceFreshUntil <= completedAt || evidenceFreshUntil - completedAt > WALMART_ITEM_REPORT_REISSUE_MAX_EVIDENCE_AGE_MS || expiresAt <= issuedAt || expiresAt - issuedAt > WALMART_ITEM_REPORT_REISSUE_MAX_PERMIT_TTL_MS || issuedAt > evidenceFreshUntil || expiresAt > evidenceFreshUntil) {
    fail2("INVALID_FRESHNESS", "permit or prior ABSENCE_ONLY freshness bounds are invalid");
  }
}
function parsePermitBody(value) {
  const raw = asRecord2(value, "permit body");
  assertExactKeys4(raw, [
    "account_scope",
    "action",
    "approved_by",
    "authorization",
    "decision_ref",
    "freshness",
    "owner_risk_acknowledgement",
    "permit_id",
    "prior_absence_only",
    "replacement",
    "source_evidence_release_sha256",
    "trust_boundary"
  ], "permit body");
  if (raw.action !== WALMART_ITEM_REPORT_REISSUE_ACTION) {
    fail2("INVALID_PERMIT", "permit action is invalid");
  }
  const prior = parsePriorAbsenceOnly(raw.prior_absence_only);
  const replacement = parseReplacement(raw.replacement);
  const freshness = parseFreshness(raw.freshness);
  const accountScope = parseAccountScope2(raw.account_scope, "permit account_scope");
  validateFreshnessShape(prior, replacement, freshness);
  if (!sameCanonical(accountScope, replacement.session_authority.account_scope)) {
    fail2("ACCOUNT_SCOPE_MISMATCH", "permit account scope differs from replacement SessionAuthority");
  }
  if (prior.session_name === replacement.session_name || prior.session_id === replacement.session_id || prior.session_authority_sha256 === replacement.session_authority_sha256 || prior.create_manifest_sha256 === replacement.create_request_manifest_sha256) {
    fail2("REPLACEMENT_NOT_DISTINCT", "replacement must be a distinct exact session and POST");
  }
  return {
    permit_id: safeIdentifier2(raw.permit_id, "permit_id"),
    action: WALMART_ITEM_REPORT_REISSUE_ACTION,
    approved_by: exactString2(raw.approved_by, "approved_by", 256),
    decision_ref: decisionReference(raw.decision_ref),
    source_evidence_release_sha256: exactDigest(
      raw.source_evidence_release_sha256,
      "source_evidence_release_sha256"
    ),
    account_scope: accountScope,
    prior_absence_only: prior,
    replacement,
    freshness,
    authorization: parseFixedObject(
      raw.authorization,
      fixedAuthorization(),
      "authorization"
    ),
    owner_risk_acknowledgement: parseFixedObject(
      raw.owner_risk_acknowledgement,
      fixedRiskAcknowledgement(),
      "owner_risk_acknowledgement"
    ),
    trust_boundary: parseFixedObject(
      raw.trust_boundary,
      fixedTrustBoundary(),
      "trust_boundary"
    )
  };
}
function permitPreimage(body, bodySha256) {
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_PERMIT_SCHEMA,
    body,
    body_sha256: bodySha256
  };
}
function parseWalmartItemReportReissuePermit(value) {
  const raw = asRecord2(value, "reissue permit");
  assertExactKeys4(raw, ["body", "body_sha256", "permit_sha256", "schema_version"], "reissue permit");
  if (raw.schema_version !== WALMART_ITEM_REPORT_REISSUE_PERMIT_SCHEMA) {
    fail2("INVALID_PERMIT", "reissue permit schema is invalid");
  }
  const body = parsePermitBody(raw.body);
  const bodySha256 = exactDigest(raw.body_sha256, "body_sha256");
  const permitSha256 = exactDigest(raw.permit_sha256, "permit_sha256");
  if (bodySha256 !== walmartItemReportSha256(body) || permitSha256 !== walmartItemReportSha256(permitPreimage(body, bodySha256))) {
    fail2("PERMIT_HASH_MISMATCH", "permit body or envelope hash is invalid");
  }
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_PERMIT_SCHEMA,
    body,
    body_sha256: bodySha256,
    permit_sha256: permitSha256
  };
}
function buildWalmartItemReportReissuePermit(input) {
  const accountScope = parseAccountScope2(input.account_scope, "input account_scope");
  const prior = parsePriorAbsenceOnly(input.prior_absence_only);
  const replacement = replacementBinding({
    account_scope: accountScope,
    session_name: input.replacement_session_name,
    session_authority: input.replacement_session_authority,
    create_request_manifest: input.replacement_create_request_manifest
  });
  const body = {
    permit_id: safeIdentifier2(input.permit_id, "permit_id"),
    action: WALMART_ITEM_REPORT_REISSUE_ACTION,
    approved_by: exactString2(input.approved_by, "approved_by", 256),
    decision_ref: decisionReference(input.decision_ref),
    source_evidence_release_sha256: exactDigest(
      input.source_evidence_release_sha256,
      "source_evidence_release_sha256"
    ),
    account_scope: accountScope,
    prior_absence_only: prior,
    replacement,
    freshness: {
      issued_at: strictInstant2(input.issued_at, "issued_at"),
      expires_at: strictInstant2(input.expires_at, "expires_at"),
      prior_evidence_fresh_until: strictInstant2(
        input.prior_evidence_fresh_until,
        "prior_evidence_fresh_until"
      )
    },
    authorization: fixedAuthorization(),
    owner_risk_acknowledgement: fixedRiskAcknowledgement(),
    trust_boundary: fixedTrustBoundary()
  };
  validateFreshnessShape(prior, replacement, body.freshness);
  const bodySha256 = walmartItemReportSha256(body);
  return parseWalmartItemReportReissuePermit({
    ...permitPreimage(body, bodySha256),
    permit_sha256: walmartItemReportSha256(permitPreimage(body, bodySha256))
  });
}
function canonicalWalmartItemReportReissuePermitBytes(value) {
  const permit = parseWalmartItemReportReissuePermit(value);
  return new TextEncoder().encode(canonicalWalmartItemReportJson(permit));
}
function walmartItemReportReissuePermitArtifactSha256(bytes) {
  return sha256Bytes2(bytes);
}
function walmartItemReportReissueOwnerConfirmation(value) {
  const permit = parseWalmartItemReportReissuePermit(value);
  return `${WALMART_ITEM_REPORT_REISSUE_CONFIRMATION_PREFIX}:${permit.permit_sha256}:${permit.body.permit_id}`;
}
function assertWalmartItemReportReissueOwnerConfirmation(value, confirmation) {
  if (confirmation !== walmartItemReportReissueOwnerConfirmation(value)) {
    fail2(
      "OWNER_CONFIRMATION_MISMATCH",
      "owner confirmation does not bind the exact reissue permit"
    );
  }
}
function parseWalmartItemReportReissuePermitBytes(bytes) {
  if (bytes.byteLength >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) {
    fail2("NON_CANONICAL_PERMIT_BYTES", "permit artifact must not contain a UTF-8 BOM");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail2("INVALID_PERMIT_BYTES", "permit artifact is not exact UTF-8 JSON");
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    fail2("INVALID_PERMIT_BYTES", "permit artifact is not valid JSON");
  }
  const permit = parseWalmartItemReportReissuePermit(raw);
  const canonical = canonicalWalmartItemReportJson(permit);
  if (text !== canonical) {
    fail2("NON_CANONICAL_PERMIT_BYTES", "permit artifact bytes are not exact canonical JSON");
  }
  return permit;
}
function expectedReplacement(context) {
  return replacementBinding({
    account_scope: context.account_scope,
    session_name: context.replacement_session_name,
    session_authority: context.replacement_session_authority,
    create_request_manifest: context.replacement_create_request_manifest
  });
}
function verifyWalmartItemReportReissuePermit(value, context) {
  const permit = parseWalmartItemReportReissuePermit(value);
  const expectedPermitSha = exactDigest(
    context.expected_permit_sha256,
    "externally supplied expected_permit_sha256"
  );
  if (permit.permit_sha256 !== expectedPermitSha) {
    fail2("EXTERNAL_CUSTODY_HASH_MISMATCH", "permit differs from the externally supplied owner-custody hash");
  }
  const expectedReleaseSha = exactDigest(
    context.expected_source_evidence_release_sha256,
    "expected_source_evidence_release_sha256"
  );
  if (permit.body.source_evidence_release_sha256 !== expectedReleaseSha) {
    fail2("SOURCE_EVIDENCE_RELEASE_MISMATCH", "permit targets a different source-evidence release");
  }
  const accountScope = parseAccountScope2(context.account_scope, "active account_scope");
  const prior = parsePriorAbsenceOnly(context.prior_absence_only);
  const replacement = expectedReplacement(context);
  if (!sameCanonical(permit.body.account_scope, accountScope) || !sameCanonical(permit.body.prior_absence_only, prior) || !sameCanonical(permit.body.replacement, replacement)) {
    fail2("BINDING_MISMATCH", "permit differs from active account/prior/replacement bindings");
  }
  if (!(context.now instanceof Date) || !Number.isFinite(context.now.getTime())) {
    fail2("INVALID_VERIFICATION_TIME", "verification now must be a valid Date");
  }
  const now = context.now.getTime();
  const issuedAt = Date.parse(permit.body.freshness.issued_at);
  const expiresAt = Date.parse(permit.body.freshness.expires_at);
  const evidenceFreshUntil = Date.parse(permit.body.freshness.prior_evidence_fresh_until);
  if (issuedAt > now + WALMART_ITEM_REPORT_REISSUE_CLOCK_SKEW_MS || now > expiresAt || now > evidenceFreshUntil) {
    fail2("PERMIT_EXPIRED_OR_NOT_CURRENT", "permit or prior ABSENCE_ONLY evidence is not current");
  }
  return permit;
}
function verifyWalmartItemReportReissuePermitBytes(bytes, context) {
  const expectedArtifactSha = exactDigest(
    context.expected_artifact_sha256,
    "externally supplied expected_artifact_sha256"
  );
  if (walmartItemReportReissuePermitArtifactSha256(bytes) !== expectedArtifactSha) {
    fail2(
      "EXTERNAL_CUSTODY_ARTIFACT_HASH_MISMATCH",
      "permit artifact bytes differ from the externally supplied owner-custody hash"
    );
  }
  const permit = parseWalmartItemReportReissuePermitBytes(bytes);
  return verifyWalmartItemReportReissuePermit(permit, context);
}

// src/lib/walmart/item-report-reissue-source-evidence-v2.ts
import { createHash as createHash6 } from "node:crypto";
import { constants as fsConstants2 } from "node:fs";
import { lstat as lstat2, open as open2, readdir as readdir2, realpath as realpath2 } from "node:fs/promises";
import path2 from "node:path";
var WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_SCHEMA = "walmart-item-report-reissue-source-evidence/v2";
var WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_POLICY = "walmart-item-v6-independent-disposition-probe/2.0.0";
var WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var EXPECTED_EVIDENCE_ROOT_NAME = "item-v6-disposition-probe-store1-20260719-claude-v1";
var EXPECTED_PRIOR_SESSION_NAME = "item-v6-store1-20260718-codex-v1";
var EXPECTED_RELEASE_ID = "walmart-item-v6-reissue-source-evidence-store1-20260719-v2";
var EXPECTED_EMPTY_RESPONSE = '{"page":1,"totalCount":0,"limit":0,"requests":[]}';
var EXACT_QUERY = Object.freeze({
  reportType: "ITEM",
  reportVersion: "v6",
  src: "API",
  requestSubmissionStartDate: "2026-07-19T03:55:00Z",
  requestSubmissionEndDate: "2026-07-19T04:00:00Z"
});
var EXPECTED_ACCOUNT = Object.freeze({
  channel: "WALMART_US",
  store_index: 1,
  seller_id: "10001624309",
  seller_account_fingerprint_sha256: "a135315771d89961b51864ae27a80fc5e1f72c27ce9cbe1a4bf4ba7f93505127"
});
function freezeExpectedFiles(files) {
  return Object.freeze(files.map((entry) => Object.freeze(entry)));
}
var PROBE_FILES = freezeExpectedFiles([
  {
    path: "broad-48h/report-requests-48h.json",
    byte_length: 4893,
    sha256: "9ebc02e7db35eb468fb7d76d34347a70bd965d63367654503b79c4fa8ed3fc55"
  },
  {
    path: "broad-48h/sanitized-request-metadata.json",
    byte_length: 3771,
    sha256: "fcec6a53e27e75286af67997f9ce965cd33598ec41719c36f4586309b68c2f5e"
  },
  {
    path: "exact-v6/request-manifest.json",
    byte_length: 1703,
    sha256: "e233a428a53657b2f835dc61cd48d463e7e9495c5d0fd81b6f981a74d04d9fe0"
  },
  {
    path: "exact-v6/response-raw.bytes",
    byte_length: 49,
    sha256: "fe1f5edce085101e740636b9a577fa1bdee5c36c33c4971f743cb18933249873"
  },
  {
    path: "exact-v6/parsed-summary.json",
    byte_length: 221,
    sha256: "c5b036d462cf9f8fb71e3323872c17b81855b95f7bc152542fd413422c40a385"
  },
  {
    path: "exact-v6/sanitized-http-metadata.json",
    byte_length: 2239,
    sha256: "236f4ec40c2b0d84007689c45bd537a7b354e92d198c9aac0897910bd12ac4ef"
  }
]);
var QUARANTINE_FILES = freezeExpectedFiles([
  {
    path: "capture/10-create-request-manifest.json",
    byte_length: 494,
    sha256: "fdd21b9cd0028845d96d0b395443195334d37dfbd0809ac75a44931fe85011b9"
  },
  {
    path: "capture/60-item-request-reconcile-8e1f6dc39d35a577f7620c9b-scope.json",
    byte_length: 1516,
    sha256: "be7c292fed5080d1fad8d6c426f19abdb950d02762af6f2201f27e602332a83e"
  },
  {
    path: "capture/61-item-request-reconcile-8e1f6dc39d35a577f7620c9b-page-0001-request.json",
    byte_length: 944,
    sha256: "28730ec71da8a73ba9dd4da95bfcbcf9d667342e737668311c12333c40841636"
  },
  {
    path: "capture/62-item-request-reconcile-8e1f6dc39d35a577f7620c9b-page-0001-response.bin",
    byte_length: 49,
    sha256: "fe1f5edce085101e740636b9a577fa1bdee5c36c33c4971f743cb18933249873"
  },
  {
    path: "capture/63-item-request-reconcile-8e1f6dc39d35a577f7620c9b-page-0001-http.json",
    byte_length: 1718,
    sha256: "9eb0d689c7b9529ade16c232f76ea0a4dfae8213c146287ee634a770cb2139f3"
  },
  {
    path: "checkpoints/10-request-reserved.json",
    byte_length: 367,
    sha256: "21a099d748e9efa214c251c44f708412a8094932f226a2095314eda817ae6eb9"
  },
  {
    path: "checkpoints/19-request-manual-review.json",
    byte_length: 215,
    sha256: "91db33f675c07f8b91fe56f33d2d447cf2510d43d48a157778bb4058b900eeb2"
  },
  {
    path: "checkpoints/61-item-request-reconcile-8e1f6dc39d35a577f7620c9b-page-0001-reserved.json",
    byte_length: 436,
    sha256: "e683f64efe56a02dec2a9b4ec138c539d302289f9e215854b007f8e345b6ba58"
  },
  {
    path: "checkpoints/64-item-request-reconcile-8e1f6dc39d35a577f7620c9b-page-0001-failed.json",
    byte_length: 273,
    sha256: "edec40ff96882f659d18b4d3b1e1a4d8407f78f22f6ac126fd8f97f214afb3fc"
  },
  {
    path: "checkpoints/65-item-request-reconcile-8e1f6dc39d35a577f7620c9b-page-0001-complete.json",
    byte_length: 694,
    sha256: "5f84cc242d13d906595d4ae44594834ab9cd628c919bb8ea7192af90008ee011"
  },
  {
    path: "checkpoints/69-item-request-reconcile-8e1f6dc39d35a577f7620c9b-complete.json",
    byte_length: 388,
    sha256: "d2b1aef9e5d0fc6be9b6e5d5ef3b73a43a5ab27e14589fedeec34b2773a063a4"
  },
  {
    path: "trusted/00-session-authority.json",
    byte_length: 1019,
    sha256: "ec2072fce757fabb0c7cb4ef8e995c9df7be46c127a9c618334aded0a9dcd86e"
  },
  {
    path: "trusted/64-item-request-reconcile-8e1f6dc39d35a577f7620c9b-page-0001-seal.json",
    byte_length: 621,
    sha256: "6ac19bcba7cc4314a14f12044c42da491fd2b96d9c785ce56e5f280173214db4"
  },
  {
    path: "trusted/68-item-request-reconcile-8e1f6dc39d35a577f7620c9b-result.json",
    byte_length: 2417,
    sha256: "d0a18766a6509d83467d9b8bac4def2e9c7551c9019c782fc46bd23f65950d1a"
  }
]);
var ORIGINAL_ABSENT_PATHS = Object.freeze([
  "capture/11-create-response.bin",
  "capture/12-create-response-http.json",
  "trusted/13-create-exchange-seal.json",
  "checkpoints/19-request-complete.json"
]);
var WalmartItemReportReissueSourceEvidenceV2Error = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WalmartItemReportReissueSourceEvidenceV2Error";
    this.code = code;
  }
};
function fail3(code, message) {
  throw new WalmartItemReportReissueSourceEvidenceV2Error(code, message);
}
function isRecord6(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record2(value, label) {
  if (!isRecord6(value)) fail3("INVALID_EVIDENCE", `${label} must be an object`);
  return value;
}
function exactKeys2(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail3("INVALID_EVIDENCE", `${label} has missing or extra fields`);
  }
}
function releaseExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail3("INVALID_RELEASE", `${label} has missing or extra fields`);
  }
}
function releaseRecord(value, label) {
  if (!isRecord6(value)) fail3("INVALID_RELEASE", `${label} must be an object`);
  return value;
}
function exactString3(value, label, maximum = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail3("INVALID_EVIDENCE", `${label} is invalid`);
  }
  return value;
}
function strictInstant3(value, label) {
  const instant = exactString3(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(instant) || !Number.isFinite(Date.parse(instant)) || new Date(Date.parse(instant)).toISOString() !== instant) {
    fail3("INVALID_EVIDENCE", `${label} must be canonical UTC milliseconds`);
  }
  return instant;
}
function strictSecondInstant(value, label) {
  const instant = exactString3(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(instant) || !Number.isFinite(Date.parse(instant))) {
    fail3("INVALID_EVIDENCE", `${label} must be canonical UTC seconds`);
  }
  return instant;
}
function safeIdentifier3(value, label) {
  const parsed = exactString3(value, label, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(parsed) || parsed.includes("//") || parsed.endsWith("/")) {
    fail3("INVALID_EVIDENCE", `${label} is not a safe identifier`);
  }
  return parsed;
}
function sha256Bytes3(value) {
  return createHash6("sha256").update(value).digest("hex");
}
function normalizeMacAlias(absolutePath) {
  if (process.platform !== "darwin") return absolutePath;
  for (const [alias, canonical] of [["/var", "/private/var"], ["/tmp", "/private/tmp"]]) {
    if (absolutePath === alias || absolutePath.startsWith(`${alias}/`)) {
      return `${canonical}${absolutePath.slice(alias.length)}`;
    }
  }
  return absolutePath;
}
function exactAbsolutePath(value, label) {
  const raw = exactString3(value, label);
  if (!path2.isAbsolute(raw) || path2.normalize(raw) !== raw) {
    fail3("UNSAFE_PATH", `${label} must be an exact normalized absolute path`);
  }
  return normalizeMacAlias(raw);
}
function sameOpenFile(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.nlink === after.nlink && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
async function assertPrivateRealDirectory(directory, label) {
  const info = await lstat2(directory).catch(() => fail3("MISSING_EVIDENCE", `${label} is missing`));
  const permissions = info.mode & 511;
  if (!info.isDirectory() || info.isSymbolicLink() || (permissions & 63) !== 0 || (permissions & 320) !== 320 || await realpath2(directory) !== directory) {
    fail3(
      "UNSAFE_EVIDENCE_DIRECTORY",
      `${label} must be a private owner-readable/searchable real directory`
    );
  }
}
async function secureRead(root, expected) {
  if (!/^(?:broad-48h|exact-v6|capture|checkpoints|trusted)\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(expected.path)) {
    fail3("UNSAFE_PATH", "evidence relative path is unsafe");
  }
  const absolute = path2.join(root, expected.path);
  const parent = path2.dirname(absolute);
  await assertPrivateRealDirectory(parent, `${expected.path} parent`);
  const pathBefore = await lstat2(absolute).catch(() => fail3(
    "MISSING_EVIDENCE",
    `${expected.path} is missing`
  ));
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink !== 1 || (pathBefore.mode & 511) !== 256 || pathBefore.size !== expected.byte_length) {
    fail3("UNSAFE_EVIDENCE_FILE", `${expected.path} mode, link count, type, or size is unsafe`);
  }
  const flags = fsConstants2.O_RDONLY | (fsConstants2.O_NOFOLLOW ?? 0);
  const handle = await open2(absolute, flags).catch(() => fail3(
    "UNSAFE_EVIDENCE_FILE",
    `${expected.path} could not be opened without following links`
  ));
  let bytes;
  let before;
  let after;
  try {
    before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 511) !== 256 || before.size !== expected.byte_length) {
      fail3("UNSAFE_EVIDENCE_FILE", `${expected.path} opened identity is unsafe`);
    }
    bytes = await handle.readFile();
    after = await handle.stat();
  } finally {
    await handle.close();
  }
  const pathAfter = await lstat2(absolute).catch(() => fail3(
    "EVIDENCE_READ_RACE",
    `${expected.path} disappeared during review`
  ));
  if (bytes.byteLength !== expected.byte_length || !sameOpenFile(before, after) || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || !sameOpenFile(before, pathAfter)) {
    fail3("EVIDENCE_READ_RACE", `${expected.path} changed while it was reviewed`);
  }
  const sha2567 = sha256Bytes3(bytes);
  if (sha2567 !== expected.sha256) {
    fail3("EVIDENCE_HASH_MISMATCH", `${expected.path} differs from the audited bytes`);
  }
  return { bytes: Uint8Array.from(bytes), byte_length: bytes.byteLength, sha256: sha2567 };
}
async function inventory(root, directories) {
  const output = [];
  for (const directory of directories) {
    const absolute = path2.join(root, directory);
    await assertPrivateRealDirectory(absolute, `${directory} directory`);
    const entries = await readdir2(absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        fail3("UNEXPECTED_EVIDENCE_ENTRY", `${directory}/${entry.name} is not an allowed file`);
      }
      output.push(`${directory}/${entry.name}`);
    }
  }
  return output.sort();
}
function assertExactInventory(actual, expected) {
  const wanted = expected.map((entry) => entry.path).sort();
  if (canonicalWalmartItemReportJson(actual) !== canonicalWalmartItemReportJson(wanted)) {
    fail3("UNEXPECTED_EVIDENCE_INVENTORY", "evidence root has a missing or extra artifact");
  }
}
function parseJson(bytes, label) {
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail3("INVALID_EVIDENCE", `${label} is not UTF-8`);
  }
  let value;
  try {
    value = JSON.parse(decoded);
  } catch {
    fail3("INVALID_EVIDENCE", `${label} is not JSON`);
  }
  return record2(value, label);
}
function exactQueryArray(value, label) {
  if (!Array.isArray(value) || value.length !== 5) {
    fail3("INVALID_EXACT_PROBE", `${label} must contain five ordered query fields`);
  }
  const expected = Object.entries(EXACT_QUERY).map(([key, queryValue]) => ({ [key]: queryValue }));
  if (canonicalWalmartItemReportJson(value) !== canonicalWalmartItemReportJson(expected)) {
    fail3("INVALID_EXACT_PROBE", `${label} differs from the incident-bound ITEM v6 query`);
  }
}
function expectedFullUrl() {
  const query = new URLSearchParams(Object.entries(EXACT_QUERY));
  return `https://marketplace.walmartapis.com/v3/reports/reportRequests?${query.toString()}`;
}
function parseExactProbe(input) {
  const request = parseJson(input.request.bytes, "exact request manifest");
  exactKeys2(request, [
    "artifact",
    "created_at_utc",
    "external_effects_pledge",
    "network_budget",
    "operator",
    "planned_request",
    "purpose",
    "schema",
    "store_account"
  ], "exact request manifest");
  if (request.schema !== "walmart-source-intake-request-manifest/v1" || request.artifact !== "exact-v6") {
    fail3("INVALID_EXACT_PROBE", "exact request manifest schema/artifact is invalid");
  }
  const createdAt = strictInstant3(request.created_at_utc, "exact request created_at_utc");
  const store = record2(request.store_account, "exact request store_account");
  if (store.store_index !== EXPECTED_ACCOUNT.store_index || store.seller_id !== EXPECTED_ACCOUNT.seller_id || store.marketplace !== EXPECTED_ACCOUNT.channel) {
    fail3("ACCOUNT_SCOPE_MISMATCH", "exact probe store assertion differs from the incident account");
  }
  const planned = record2(request.planned_request, "exact request planned_request");
  exactQueryArray(planned.query_ordered, "exact request planned query");
  if (planned.method !== "GET" || planned.endpoint !== "/v3/reports/reportRequests" || planned.base_url !== "https://marketplace.walmartapis.com" || planned.full_url !== expectedFullUrl()) {
    fail3("INVALID_EXACT_PROBE", "exact planned request is not the fixed read-only endpoint");
  }
  const correlation = exactString3(
    planned.wm_qos_correlation_id,
    "exact request correlation ID",
    128
  );
  const budget = record2(request.network_budget, "exact request network_budget");
  if (budget.oauth_token_post_max !== 1 || budget.report_requests_get !== 1 || budget.report_create_post !== 0 || budget.retries !== 0 || budget.cursor_calls !== 0) {
    fail3("INVALID_EXACT_PROBE", "exact request budget is not one GET with zero create/retry");
  }
  const effects = record2(request.external_effects_pledge, "exact request external effects");
  if (effects.model_calls !== 0 || effects.db_writes !== 0 || effects.walmart_content_writes !== 0 || effects.quarantined_session_touched !== false) {
    fail3("INVALID_EXACT_PROBE", "exact request declared a forbidden external effect");
  }
  const responseText = new TextDecoder("utf-8", { fatal: true }).decode(input.response.bytes);
  if (responseText !== EXPECTED_EMPTY_RESPONSE) {
    fail3("NOT_EXACT_ABSENCE_OBSERVATION", "exact raw response is not the literal empty sentinel");
  }
  const summary = parseJson(input.summary.bytes, "exact parsed summary");
  exactKeys2(summary, [
    "http_status",
    "limit",
    "nextCursor_present",
    "page",
    "request_count",
    "schema",
    "source_raw_file",
    "totalCount"
  ], "exact parsed summary");
  if (summary.schema !== "walmart-source-intake-parsed-summary/v1" || summary.source_raw_file !== "response-raw.bytes" || summary.http_status !== 200 || summary.page !== 1 || summary.limit !== 0 || summary.totalCount !== 0 || summary.request_count !== 0 || summary.nextCursor_present !== false) {
    fail3("NOT_EXACT_ABSENCE_OBSERVATION", "parsed summary differs from exact raw response");
  }
  const http = parseJson(input.http.bytes, "exact sanitized HTTP metadata");
  exactKeys2(
    http,
    ["budget_actual", "get", "oauth", "schema", "stopped_without_retry"],
    "exact sanitized HTTP metadata"
  );
  if (http.schema !== "walmart-source-intake-sanitized-http-metadata/v1" || http.stopped_without_retry !== false) {
    fail3("INVALID_EXACT_PROBE", "exact HTTP metadata schema/terminal state is invalid");
  }
  const oauth = record2(http.oauth, "exact HTTP OAuth metadata");
  const oauthAt = strictInstant3(oauth.observed_at_utc, "OAuth observed_at_utc");
  if (oauth.method !== "POST" || oauth.endpoint !== "/v3/token" || oauth.http_status !== 200 || oauth.token_value_retained !== false) {
    fail3("INVALID_EXACT_PROBE", "OAuth metadata is invalid");
  }
  const get = record2(http.get, "exact HTTP GET metadata");
  exactQueryArray(get.query_ordered, "exact HTTP query");
  if (get.method !== "GET" || get.endpoint !== "/v3/reports/reportRequests" || get.full_url !== expectedFullUrl() || get.wm_qos_correlation_id !== correlation || get.http_status !== 200 || get.raw_body_file !== "response-raw.bytes" || get.raw_body_bytes !== input.response.byte_length) {
    fail3("INVALID_EXACT_PROBE", "exact HTTP GET does not bind the manifest/raw response");
  }
  const observedAt = strictInstant3(get.observed_at_utc, "GET observed_at_utc");
  if (!(Date.parse(createdAt) <= Date.parse(oauthAt) && Date.parse(oauthAt) <= Date.parse(observedAt))) {
    fail3("INVALID_EXACT_PROBE", "manifest/OAuth/GET chronology is invalid");
  }
  const headers = record2(get.safe_response_headers, "safe response headers");
  if (headers["content-length"] !== String(input.response.byte_length) || typeof headers["content-type"] !== "string" || !/^application\/json(?:\s*;|$)/iu.test(headers["content-type"])) {
    fail3("INVALID_EXACT_PROBE", "safe response headers do not bind the raw body");
  }
  const xRequestId = exactString3(headers["x-request-id"], "x-request-id", 256);
  const actual = record2(http.budget_actual, "exact HTTP actual budget");
  if (actual.oauth_token_posts !== 1 || actual.report_requests_gets !== 1 || actual.retries !== 0 || actual.cursor_calls !== 0 || actual.report_create_posts !== 0) {
    fail3("INVALID_EXACT_PROBE", "actual network budget differs from the one-shot read-only plan");
  }
  return {
    observed_at: observedAt,
    fresh_until: new Date(
      Date.parse(observedAt) + WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_MAX_AGE_MS
    ).toISOString(),
    request_correlation_id: correlation,
    x_request_id: xRequestId,
    created_at: createdAt
  };
}
function parseBroadProbe(reportBytes, metadataBytes) {
  const report = parseJson(reportBytes, "broad report envelope");
  exactKeys2(report, ["pages", "window"], "broad report envelope");
  if (!Array.isArray(report.pages) || report.pages.length !== 1) {
    fail3("INVALID_BROAD_PROBE", "broad report must retain exactly its one captured page");
  }
  const page = record2(report.pages[0], "broad page 1");
  if (page.page !== 1 || page.totalCount !== 18 || page.limit !== 10 || !Array.isArray(page.requests) || page.requests.length !== 10 || typeof page.nextCursor !== "string") {
    fail3("INVALID_BROAD_PROBE", "broad page inventory is invalid");
  }
  const submissionDates = [];
  for (const [index, raw] of page.requests.entries()) {
    const row = record2(raw, `broad request ${index}`);
    if (row.reportType !== "ITEM" || row.reportVersion !== "v2" || row.src !== "API" || !(/* @__PURE__ */ new Set(["READY", "RECEIVED"])).has(String(row.requestStatus))) {
      fail3("INVALID_BROAD_PROBE", "broad page contains a non-legacy or unexpected row");
    }
    submissionDates.push(Date.parse(strictSecondInstant(
      row.requestSubmissionDate,
      `broad request ${index} submission date`
    )));
  }
  if (submissionDates.some((value, index) => index > 0 && value >= submissionDates[index - 1]) || new Date(submissionDates[0]).toISOString() !== "2026-07-19T17:02:02.000Z" || new Date(submissionDates.at(-1)).toISOString() !== "2026-07-18T15:01:50.000Z") {
    fail3("INVALID_BROAD_PROBE", "broad rows are not the audited newest-first page");
  }
  const metadata = parseJson(metadataBytes, "broad sanitized request metadata");
  if (metadata.schema !== "walmart-source-intake-sanitized-request-metadata/v1" || metadata.artifact !== "broad-48h") {
    fail3("INVALID_BROAD_PROBE", "broad metadata schema/artifact is invalid");
  }
  const facts = record2(metadata.envelope_facts, "broad envelope facts");
  if (facts.sha256 !== PROBE_FILES[0].sha256 || facts.bytes !== PROBE_FILES[0].byte_length || facts.pages_captured !== 1 || facts.walmart_totalCount !== 18 || facts.unique_requests_captured !== 10 || typeof facts.not_raw_bytes_disclosure !== "string") {
    fail3("INVALID_BROAD_PROBE", "broad metadata does not bind its serialized envelope/caveat");
  }
  const transport = record2(metadata.transport, "broad transport metadata");
  if (!Array.isArray(transport.calls) || transport.calls.length !== 2 || record2(transport.calls[0], "broad call 1").http_status !== 200 || record2(transport.calls[1], "broad call 2").http_status !== 429 || record2(transport.calls[1], "broad call 2").attempts !== 5) {
    fail3("INVALID_BROAD_PROBE", "broad transport retry/pagination disclosure is missing");
  }
  return {
    role: "CORROBORATING_ONLY",
    raw_http_bytes_retained: false,
    page_2_retained: false,
    reported_total_count: 18,
    retained_row_count: 10,
    retained_v6_row_count: 0,
    newest_submission_at: "2026-07-19T17:02:02.000Z",
    oldest_retained_submission_at: "2026-07-18T15:01:50.000Z",
    pagination_attempt_2_http_status: 429,
    pagination_attempt_2_transport_attempts: 5
  };
}
async function assertAbsent(root, relativePaths) {
  for (const relativePath of relativePaths) {
    const absolute = path2.join(root, relativePath);
    const found = await lstat2(absolute).then(() => true).catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (found) fail3("ORIGINAL_STATE_MUTATED", `${relativePath} must remain absent`);
  }
}
function parseOriginalSession(artifacts) {
  const authorityArtifact = artifacts.get("trusted/00-session-authority.json");
  const authority = parseWalmartItemReportReissueSessionAuthority(
    parseJson(authorityArtifact.bytes, "original SessionAuthority")
  );
  if (authority.account_scope.channel !== EXPECTED_ACCOUNT.channel || authority.account_scope.store_index !== EXPECTED_ACCOUNT.store_index || authority.account_scope.seller_account_fingerprint_sha256 !== EXPECTED_ACCOUNT.seller_account_fingerprint_sha256) {
    fail3("ACCOUNT_SCOPE_MISMATCH", "original SessionAuthority account scope is unexpected");
  }
  const createArtifact = artifacts.get("capture/10-create-request-manifest.json");
  const create = parseJson(createArtifact.bytes, "original create manifest");
  const expectedCreate = buildWalmartItemReportV6CreateRequestManifest({
    account_scope: authority.account_scope,
    request_correlation_id_sha256: authority.primary_correlations.create.sha256
  });
  if (canonicalWalmartItemReportJson(create) !== canonicalWalmartItemReportJson(expectedCreate)) {
    fail3("INVALID_ORIGINAL_SESSION", "original create manifest differs from SessionAuthority");
  }
  const reservedArtifact = artifacts.get("checkpoints/10-request-reserved.json");
  const reserved = parseJson(reservedArtifact.bytes, "original request reservation");
  const reservedAt = strictInstant3(reserved.observed_at, "original reservation observed_at");
  if (reserved.state !== "RESERVED" || reserved.phase !== "request" || reserved.attempt !== 1 || reserved.post_attempt_limit !== 1 || reserved.request_manifest_sha256 !== createArtifact.sha256 || reserved.request_correlation_id_sha256 !== authority.primary_correlations.create.sha256) {
    fail3("INVALID_ORIGINAL_SESSION", "original reservation does not bind the one POST attempt");
  }
  const manualArtifact = artifacts.get("checkpoints/19-request-manual-review.json");
  const manual = parseJson(manualArtifact.bytes, "original manual-review checkpoint");
  const manualAt = strictInstant3(manual.observed_at, "original manual-review observed_at");
  if (manual.state !== "MANUAL_REVIEW" || manual.phase !== "request" || manual.reason_code !== "AMBIGUOUS_POST_NETWORK_OUTCOME" || manual.retry_forbidden !== true || Date.parse(manualAt) < Date.parse(reservedAt)) {
    fail3("INVALID_ORIGINAL_SESSION", "original create attempt is not retry-forbidden ambiguous");
  }
  if (Date.parse(EXACT_QUERY.requestSubmissionStartDate) > Date.parse(reservedAt) || Date.parse(EXACT_QUERY.requestSubmissionEndDate) < Date.parse(manualAt)) {
    fail3("EXACT_QUERY_WINDOW_MISMATCH", "independent exact query does not contain the ambiguous attempt");
  }
  return {
    session_name: EXPECTED_PRIOR_SESSION_NAME,
    session_id: authority.session_id,
    session_authority_sha256: authorityArtifact.sha256,
    create_manifest_sha256: createArtifact.sha256,
    request_reserved_sha256: reservedArtifact.sha256,
    manual_review_sha256: manualArtifact.sha256,
    reserved_at: reservedAt,
    manual_review_at: manualAt,
    create_request_correlation_id_sha256: authority.primary_correlations.create.sha256,
    terminal_page_failure_sha256: "edec40ff96882f659d18b4d3b1e1a4d8407f78f22f6ac126fd8f97f214afb3fc",
    prohibited_conflicting_page_complete_sha256: "5f84cc242d13d906595d4ae44594834ab9cd628c919bb8ea7192af90008ee011",
    prohibited_conflicting_result_sha256: "d0a18766a6509d83467d9b8bac4def2e9c7551c9019c782fc46bd23f65950d1a",
    prohibited_conflicting_complete_sha256: "d2b1aef9e5d0fc6be9b6e5d5ef3b73a43a5ab27e14589fedeec34b2773a063a4",
    original_request_complete_written: false,
    original_create_response_retained: false,
    request_id_adopted: false,
    retry_allowed: false,
    terminal_failure_supersedable: false,
    consume_conflicting_final: false
  };
}
function expectedFile(files, expectedPath) {
  const found = files.find((entry) => entry.path === expectedPath);
  if (!found) {
    throw new Error(`internal expected artifact is missing: ${expectedPath}`);
  }
  return found;
}
function expectedInventory(files, prefix) {
  return files.filter((entry) => prefix === void 0 || entry.path.startsWith(prefix)).map((entry) => ({ ...entry }));
}
function assertReleaseInventory(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length) {
    fail3("INVALID_RELEASE", `${label} does not contain the exact artifact inventory`);
  }
  for (const [index, expectedEntry] of expected.entries()) {
    const entry = releaseRecord(value[index], `${label}[${index}]`);
    releaseExactKeys(entry, ["byte_length", "path", "sha256"], `${label}[${index}]`);
    if (entry.path !== expectedEntry.path || entry.byte_length !== expectedEntry.byte_length || entry.sha256 !== expectedEntry.sha256) {
      fail3("INVALID_RELEASE", `${label}[${index}] differs from the audited artifact`);
    }
  }
}
function assertReleaseConstantRecord(value, expected, label) {
  const parsed = releaseRecord(value, label);
  releaseExactKeys(parsed, Object.keys(expected), label);
  if (canonicalWalmartItemReportJson(parsed) !== canonicalWalmartItemReportJson(expected)) {
    fail3("INVALID_RELEASE", `${label} differs from the incident-bound contract`);
  }
  return parsed;
}
function parseWalmartItemReportReissueSourceEvidenceV2Body(value) {
  const body = releaseRecord(value, "source evidence release body");
  releaseExactKeys(body, [
    "account_scope",
    "broad_probe",
    "disposition_basis",
    "exact_probe",
    "original_ambiguous_post",
    "policy",
    "quarantined_session_inventory",
    "release_id",
    "reviewed_at"
  ], "source evidence release body");
  if (body.release_id !== EXPECTED_RELEASE_ID) {
    fail3("INVALID_RELEASE", "source evidence release_id is not the incident-bound release");
  }
  const reviewedAt = strictInstant3(body.reviewed_at, "source evidence reviewed_at");
  assertReleaseConstantRecord(body.policy, {
    policy_id: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_POLICY,
    maximum_exact_probe_age_ms: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_MAX_AGE_MS,
    exact_raw_response_required: true,
    exact_zero_result_required: true,
    broad_probe_role: "CORROBORATING_ONLY",
    terminal_failure_supersedable: false,
    quarantined_session_mutation_allowed: false,
    authorizes_replacement_post: false
  }, "source evidence policy");
  assertReleaseConstantRecord(body.account_scope, {
    ...EXPECTED_ACCOUNT,
    exact_probe_account_match_basis: "OPERATOR_ASSERTION_NOT_MACHINE_VERIFIED",
    active_replacement_credentials_must_match_original_fingerprint: true
  }, "source evidence account_scope");
  const sessionAuthority = expectedFile(
    QUARANTINE_FILES,
    "trusted/00-session-authority.json"
  );
  const createManifest = expectedFile(
    QUARANTINE_FILES,
    "capture/10-create-request-manifest.json"
  );
  const requestReserved = expectedFile(
    QUARANTINE_FILES,
    "checkpoints/10-request-reserved.json"
  );
  const manualReview = expectedFile(
    QUARANTINE_FILES,
    "checkpoints/19-request-manual-review.json"
  );
  const terminalPageFailure = expectedFile(
    QUARANTINE_FILES,
    "checkpoints/64-item-request-reconcile-8e1f6dc39d35a577f7620c9b-page-0001-failed.json"
  );
  const prohibitedPageComplete = expectedFile(
    QUARANTINE_FILES,
    "checkpoints/65-item-request-reconcile-8e1f6dc39d35a577f7620c9b-page-0001-complete.json"
  );
  const prohibitedResult = expectedFile(
    QUARANTINE_FILES,
    "trusted/68-item-request-reconcile-8e1f6dc39d35a577f7620c9b-result.json"
  );
  const prohibitedComplete = expectedFile(
    QUARANTINE_FILES,
    "checkpoints/69-item-request-reconcile-8e1f6dc39d35a577f7620c9b-complete.json"
  );
  const original = assertReleaseConstantRecord(body.original_ambiguous_post, {
    session_name: EXPECTED_PRIOR_SESSION_NAME,
    session_id: "688864bd-e1f4-44fb-b97e-167060754931",
    session_authority_sha256: sessionAuthority.sha256,
    create_manifest_sha256: createManifest.sha256,
    request_reserved_sha256: requestReserved.sha256,
    manual_review_sha256: manualReview.sha256,
    reserved_at: "2026-07-19T03:57:17.129Z",
    manual_review_at: "2026-07-19T03:57:17.185Z",
    create_request_correlation_id_sha256: "14c61dfa0325d994fa1643369b63436bedb59c2d024ec6ccffceb22d2f7cc53b",
    terminal_page_failure_sha256: terminalPageFailure.sha256,
    prohibited_conflicting_page_complete_sha256: prohibitedPageComplete.sha256,
    prohibited_conflicting_result_sha256: prohibitedResult.sha256,
    prohibited_conflicting_complete_sha256: prohibitedComplete.sha256,
    original_request_complete_written: false,
    original_create_response_retained: false,
    request_id_adopted: false,
    retry_allowed: false,
    terminal_failure_supersedable: false,
    consume_conflicting_final: false
  }, "source evidence original_ambiguous_post");
  strictInstant3(original.reserved_at, "source evidence original reserved_at");
  strictInstant3(original.manual_review_at, "source evidence original manual_review_at");
  assertReleaseInventory(
    body.quarantined_session_inventory,
    QUARANTINE_FILES,
    "source evidence quarantined_session_inventory"
  );
  const exactFiles = PROBE_FILES.filter((entry) => entry.path.startsWith("exact-v6/"));
  const rawResponse = expectedFile(PROBE_FILES, "exact-v6/response-raw.bytes");
  const exactProbe = releaseRecord(body.exact_probe, "source evidence exact_probe");
  releaseExactKeys(exactProbe, [
    "artifact_inventory",
    "created_at",
    "cursor_calls",
    "endpoint",
    "evidence_root_name",
    "fresh_until",
    "http_status",
    "limit",
    "method",
    "next_cursor_present",
    "oauth_token_posts",
    "observed_at",
    "page",
    "query",
    "raw_response_byte_length",
    "raw_response_sha256",
    "report_create_posts",
    "report_requests_gets",
    "request_correlation_id",
    "request_count",
    "retries",
    "total_count",
    "transport_authentication_limit",
    "walmart_x_request_id"
  ], "source evidence exact_probe");
  assertReleaseConstantRecord(exactProbe.query, { ...EXACT_QUERY }, "source evidence exact query");
  assertReleaseInventory(
    exactProbe.artifact_inventory,
    exactFiles,
    "source evidence exact_probe artifact_inventory"
  );
  const expectedExactProbe = {
    evidence_root_name: EXPECTED_EVIDENCE_ROOT_NAME,
    created_at: "2026-07-19T23:13:20.842Z",
    observed_at: "2026-07-19T23:13:21.286Z",
    fresh_until: "2026-07-20T23:13:21.286Z",
    method: "GET",
    endpoint: "/v3/reports/reportRequests",
    query: { ...EXACT_QUERY },
    request_correlation_id: "e79ba0dc-bd37-4323-9448-1e9a4b2a3df3",
    walmart_x_request_id: "33b6090e-79ec-435b-b435-a10a079a88a5",
    http_status: 200,
    raw_response_sha256: rawResponse.sha256,
    raw_response_byte_length: rawResponse.byte_length,
    page: 1,
    limit: 0,
    total_count: 0,
    request_count: 0,
    next_cursor_present: false,
    oauth_token_posts: 1,
    report_requests_gets: 1,
    report_create_posts: 0,
    retries: 0,
    cursor_calls: 0,
    artifact_inventory: expectedInventory(exactFiles),
    transport_authentication_limit: "OPERATOR_CUSTODY_METADATA_NO_WALMART_SIGNATURE_OR_TLS_TRANSCRIPT"
  };
  if (canonicalWalmartItemReportJson(exactProbe) !== canonicalWalmartItemReportJson(expectedExactProbe)) {
    fail3("INVALID_RELEASE", "source evidence exact_probe differs from the audited probe");
  }
  const observedAt = strictInstant3(exactProbe.observed_at, "source evidence exact observed_at");
  const freshUntil = strictInstant3(exactProbe.fresh_until, "source evidence exact fresh_until");
  strictInstant3(exactProbe.created_at, "source evidence exact created_at");
  if (Date.parse(freshUntil) - Date.parse(observedAt) !== WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_MAX_AGE_MS || Date.parse(reviewedAt) < Date.parse(observedAt) || Date.parse(reviewedAt) >= Date.parse(freshUntil)) {
    fail3("INVALID_RELEASE", "source evidence review is outside the exact probe freshness window");
  }
  const broadFiles = PROBE_FILES.filter((entry) => entry.path.startsWith("broad-48h/"));
  const broadProbe = releaseRecord(body.broad_probe, "source evidence broad_probe");
  releaseExactKeys(broadProbe, [
    "artifact_inventory",
    "newest_submission_at",
    "oldest_retained_submission_at",
    "page_2_retained",
    "pagination_attempt_2_http_status",
    "pagination_attempt_2_transport_attempts",
    "raw_http_bytes_retained",
    "reported_total_count",
    "retained_row_count",
    "retained_v6_row_count",
    "role"
  ], "source evidence broad_probe");
  assertReleaseInventory(
    broadProbe.artifact_inventory,
    broadFiles,
    "source evidence broad_probe artifact_inventory"
  );
  const expectedBroadProbe = {
    role: "CORROBORATING_ONLY",
    raw_http_bytes_retained: false,
    page_2_retained: false,
    reported_total_count: 18,
    retained_row_count: 10,
    retained_v6_row_count: 0,
    newest_submission_at: "2026-07-19T17:02:02.000Z",
    oldest_retained_submission_at: "2026-07-18T15:01:50.000Z",
    pagination_attempt_2_http_status: 429,
    pagination_attempt_2_transport_attempts: 5,
    artifact_inventory: expectedInventory(broadFiles)
  };
  if (canonicalWalmartItemReportJson(broadProbe) !== canonicalWalmartItemReportJson(expectedBroadProbe)) {
    fail3("INVALID_RELEASE", "source evidence broad_probe differs from the audited probe");
  }
  strictInstant3(broadProbe.newest_submission_at, "source evidence broad newest_submission_at");
  strictInstant3(
    broadProbe.oldest_retained_submission_at,
    "source evidence broad oldest_retained_submission_at"
  );
  assertReleaseConstantRecord(body.disposition_basis, {
    verdict: "NO_API_VISIBLE_V6_REQUEST_IN_EXACT_QUERY_WINDOW",
    original_create_success_proven: false,
    original_create_failure_proven: false,
    independent_exact_absence_observed: true,
    exact_query_contains_original_ambiguous_attempt: true,
    original_request_id_adoption_allowed: false,
    original_session_reinterpretation_allowed: false,
    prohibited_conflicting_final_consumable: false,
    duplicate_replacement_request_risk: "NON_ZERO",
    owner_must_accept_account_binding_limit: true,
    owner_must_accept_transport_authentication_limit: true,
    owner_ed25519_disposition_required: true,
    separate_one_shot_execution_permit_required: true
  }, "source evidence disposition_basis");
  return body;
}
function releasePreimage(body, bodySha256) {
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_SCHEMA,
    body,
    body_sha256: bodySha256
  };
}
function serializeWalmartItemReportReissueSourceEvidenceV2(release) {
  verifyWalmartItemReportReissueSourceEvidenceV2(release);
  return Buffer.from(canonicalWalmartItemReportJson(release), "utf8");
}
function verifyWalmartItemReportReissueSourceEvidenceV2(value) {
  const raw = record2(value, "source evidence release");
  exactKeys2(
    raw,
    ["body", "body_sha256", "release_sha256", "schema_version"],
    "source evidence release"
  );
  if (raw.schema_version !== WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_SCHEMA) {
    fail3("INVALID_RELEASE", "source evidence release schema is invalid");
  }
  const body = record2(raw.body, "source evidence release body");
  const bodySha256 = exactString3(raw.body_sha256, "body_sha256", 64);
  const releaseSha256 = exactString3(raw.release_sha256, "release_sha256", 64);
  if (!/^[a-f0-9]{64}$/u.test(bodySha256) || !/^[a-f0-9]{64}$/u.test(releaseSha256) || bodySha256 !== walmartItemReportSha256(body) || releaseSha256 !== walmartItemReportSha256(releasePreimage(body, bodySha256))) {
    fail3("RELEASE_HASH_MISMATCH", "source evidence release hash binding is invalid");
  }
  const parsedBody = parseWalmartItemReportReissueSourceEvidenceV2Body(body);
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_SCHEMA,
    body: parsedBody,
    body_sha256: bodySha256,
    release_sha256: releaseSha256
  };
}
function parseWalmartItemReportReissueSourceEvidenceV2Bytes(bytes) {
  const value = parseJson(bytes, "source evidence release bytes");
  const release = verifyWalmartItemReportReissueSourceEvidenceV2(value);
  if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== canonicalWalmartItemReportJson(release)) {
    fail3("NON_CANONICAL_RELEASE_BYTES", "source evidence release bytes are not canonical JSON");
  }
  return release;
}
async function buildWalmartItemReportReissueSourceEvidenceV2(input) {
  const evidenceRoot = exactAbsolutePath(input.evidence_root, "evidence_root");
  const captureRoot = exactAbsolutePath(input.capture_root, "capture_root");
  if (path2.basename(evidenceRoot) !== EXPECTED_EVIDENCE_ROOT_NAME || input.prior_session_name !== EXPECTED_PRIOR_SESSION_NAME) {
    fail3("WRONG_INCIDENT_SCOPE", "input roots do not identify the exact reviewed incident");
  }
  await assertPrivateRealDirectory(evidenceRoot, "evidence_root");
  await assertPrivateRealDirectory(captureRoot, "capture_root");
  const priorSession = path2.join(captureRoot, input.prior_session_name);
  await assertPrivateRealDirectory(priorSession, "prior quarantined session");
  assertExactInventory(await inventory(evidenceRoot, ["broad-48h", "exact-v6"]), PROBE_FILES);
  assertExactInventory(
    await inventory(priorSession, ["capture", "checkpoints", "trusted"]),
    QUARANTINE_FILES
  );
  const probeArtifacts = /* @__PURE__ */ new Map();
  for (const expected of PROBE_FILES) {
    probeArtifacts.set(expected.path, await secureRead(evidenceRoot, expected));
  }
  const quarantineArtifacts = /* @__PURE__ */ new Map();
  for (const expected of QUARANTINE_FILES) {
    quarantineArtifacts.set(expected.path, await secureRead(priorSession, expected));
  }
  await assertAbsent(priorSession, ORIGINAL_ABSENT_PATHS);
  const exact = parseExactProbe({
    request: probeArtifacts.get("exact-v6/request-manifest.json"),
    response: probeArtifacts.get("exact-v6/response-raw.bytes"),
    summary: probeArtifacts.get("exact-v6/parsed-summary.json"),
    http: probeArtifacts.get("exact-v6/sanitized-http-metadata.json")
  });
  const broad = parseBroadProbe(
    probeArtifacts.get("broad-48h/report-requests-48h.json").bytes,
    probeArtifacts.get("broad-48h/sanitized-request-metadata.json").bytes
  );
  const original = parseOriginalSession(quarantineArtifacts);
  const reviewedAt = strictInstant3(input.reviewed_at, "reviewed_at");
  if (Date.parse(reviewedAt) < Date.parse(exact.observed_at) || Date.parse(reviewedAt) >= Date.parse(exact.fresh_until)) {
    fail3("STALE_EVIDENCE", "reviewed_at must fall inside the exact probe freshness window");
  }
  const body = {
    release_id: safeIdentifier3(input.release_id, "release_id"),
    reviewed_at: reviewedAt,
    policy: {
      policy_id: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_POLICY,
      maximum_exact_probe_age_ms: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_MAX_AGE_MS,
      exact_raw_response_required: true,
      exact_zero_result_required: true,
      broad_probe_role: "CORROBORATING_ONLY",
      terminal_failure_supersedable: false,
      quarantined_session_mutation_allowed: false,
      authorizes_replacement_post: false
    },
    account_scope: {
      ...EXPECTED_ACCOUNT,
      exact_probe_account_match_basis: "OPERATOR_ASSERTION_NOT_MACHINE_VERIFIED",
      active_replacement_credentials_must_match_original_fingerprint: true
    },
    original_ambiguous_post: original,
    quarantined_session_inventory: QUARANTINE_FILES.map((entry) => ({ ...entry })),
    exact_probe: {
      evidence_root_name: EXPECTED_EVIDENCE_ROOT_NAME,
      created_at: exact.created_at,
      observed_at: exact.observed_at,
      fresh_until: exact.fresh_until,
      method: "GET",
      endpoint: "/v3/reports/reportRequests",
      query: { ...EXACT_QUERY },
      request_correlation_id: exact.request_correlation_id,
      walmart_x_request_id: exact.x_request_id,
      http_status: 200,
      raw_response_sha256: PROBE_FILES[3].sha256,
      raw_response_byte_length: PROBE_FILES[3].byte_length,
      page: 1,
      limit: 0,
      total_count: 0,
      request_count: 0,
      next_cursor_present: false,
      oauth_token_posts: 1,
      report_requests_gets: 1,
      report_create_posts: 0,
      retries: 0,
      cursor_calls: 0,
      artifact_inventory: PROBE_FILES.filter((entry) => entry.path.startsWith("exact-v6/")).map((entry) => ({ ...entry })),
      transport_authentication_limit: "OPERATOR_CUSTODY_METADATA_NO_WALMART_SIGNATURE_OR_TLS_TRANSCRIPT"
    },
    broad_probe: {
      ...broad,
      artifact_inventory: PROBE_FILES.filter((entry) => entry.path.startsWith("broad-48h/")).map((entry) => ({ ...entry }))
    },
    disposition_basis: {
      verdict: "NO_API_VISIBLE_V6_REQUEST_IN_EXACT_QUERY_WINDOW",
      original_create_success_proven: false,
      original_create_failure_proven: false,
      independent_exact_absence_observed: true,
      exact_query_contains_original_ambiguous_attempt: true,
      original_request_id_adoption_allowed: false,
      original_session_reinterpretation_allowed: false,
      prohibited_conflicting_final_consumable: false,
      duplicate_replacement_request_risk: "NON_ZERO",
      owner_must_accept_account_binding_limit: true,
      owner_must_accept_transport_authentication_limit: true,
      owner_ed25519_disposition_required: true,
      separate_one_shot_execution_permit_required: true
    }
  };
  const bodySha256 = walmartItemReportSha256(body);
  const releaseSha256 = walmartItemReportSha256(releasePreimage(body, bodySha256));
  return verifyWalmartItemReportReissueSourceEvidenceV2({
    schema_version: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_SCHEMA,
    body,
    body_sha256: bodySha256,
    release_sha256: releaseSha256
  });
}
var WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_EXPECTED_PROBE_FILES = PROBE_FILES;
var WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_EXPECTED_QUARANTINE_FILES = QUARANTINE_FILES;

// src/lib/walmart/item-report-reissue-absence-probe-evidence.ts
import { createHash as createHash7 } from "node:crypto";
var WALMART_ITEM_V6_ABSENCE_PROBE_EVIDENCE_SCHEMA = "walmart-item-v6-absence-probe/1.0.0";
var WALMART_ITEM_V6_ABSENCE_PROBE_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_STORE_INDEX = 1;
var WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_SELLER_ID = "10001624309";
var WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_ACCOUNT_FINGERPRINT = "a135315771d89961b51864ae27a80fc5e1f72c27ce9cbe1a4bf4ba7f93505127";
var WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_QUERY = Object.freeze({
  reportType: "ITEM",
  reportVersion: "v6",
  src: "API",
  requestSubmissionStartDate: "2026-07-19T03:55:00Z",
  requestSubmissionEndDate: "2026-07-19T04:00:00Z"
});
var WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES = Object.freeze([
  "00-probe-authority.json",
  "10-get-reserved.json",
  "20-response-raw.bytes",
  "21-response-http.json",
  "22-exchange-seal.json",
  "30-result.json"
]);
var API_ENDPOINT = "/v3/reports/reportRequests";
var DEFAULT_REQUEST_TIMEOUT_MS = 6e4;
var MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
var MAX_REDIRECT_BYTES = 64 * 1024;
var WalmartItemV6AbsenceProbeEvidenceError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WalmartItemV6AbsenceProbeEvidenceError";
    this.code = code;
  }
};
function fail4(code, message) {
  throw new WalmartItemV6AbsenceProbeEvidenceError(code, message);
}
function isRecord7(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record3(value, label) {
  if (!isRecord7(value)) fail4("INVALID_PROBE_EVIDENCE", `${label} must be an object`);
  return value;
}
function exactString4(value, label, maximum = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail4("INVALID_PROBE_EVIDENCE", `${label} is invalid`);
  }
  return value;
}
function strictInstant4(value, label) {
  const parsed = exactString4(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed) || !Number.isFinite(Date.parse(parsed)) || new Date(Date.parse(parsed)).toISOString() !== parsed) {
    fail4("INVALID_PROBE_EVIDENCE", `${label} must be canonical UTC milliseconds`);
  }
  return parsed;
}
function sha2562(bytes) {
  return createHash7("sha256").update(bytes).digest("hex");
}
function canonicalBytes(value) {
  return Buffer.from(canonicalWalmartItemReportJson(value), "utf8");
}
function sameCanonical2(left, right) {
  return canonicalWalmartItemReportJson(left) === canonicalWalmartItemReportJson(right);
}
function assertCanonicalEqual(actual, expected, label) {
  if (!sameCanonical2(actual, expected)) {
    fail4("PROBE_EVIDENCE_BINDING_MISMATCH", `${label} differs from the sealed family`);
  }
}
function parseCanonicalJson(bytes, label) {
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail4("INVALID_PROBE_EVIDENCE", `${label} is not UTF-8 JSON`);
  }
  if (!isRecord7(value) || text !== canonicalWalmartItemReportJson(value)) {
    fail4("NON_CANONICAL_PROBE_EVIDENCE", `${label} is not canonical JSON`);
  }
  return value;
}
function fixedRequest(correlationId) {
  return {
    kind: "walmart-api",
    method: "GET",
    endpoint: API_ENDPOINT,
    query: { ...WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_QUERY },
    url: null,
    headers: { accept: "application/json", "accept-encoding": "identity" },
    body: null,
    correlation_id: correlationId,
    redirect: "manual",
    max_response_bytes: MAX_RESPONSE_BYTES,
    max_redirect_response_bytes: MAX_REDIRECT_BYTES,
    timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS
  };
}
function validateSafeHeaders(value) {
  const headers = record3(value, "safe_response_headers");
  const allowed = /* @__PURE__ */ new Set([
    "content-length",
    "content-type",
    "x-request-id",
    "wm_qos.correlation_id",
    "wm-qos-correlation-id"
  ]);
  for (const [name, raw] of Object.entries(headers)) {
    if (!allowed.has(name) || typeof raw !== "string" || raw.length === 0 || raw.length > 512 || /[\u0000-\u001f\u007f]/u.test(raw)) {
      fail4("INVALID_PROBE_EVIDENCE", "safe response headers are invalid");
    }
  }
  const contentType = headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    fail4("INVALID_PROBE_EVIDENCE", "safe response content-type is invalid");
  }
  return headers;
}
function parseExactZeroResponse(bytes) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail4("INVALID_PROBE_EVIDENCE", "raw response is not UTF-8 JSON");
  }
  const raw = record3(value, "raw response");
  const keys = Object.keys(raw).sort();
  const allowed = ["limit", "nextCursor", "page", "requests", "totalCount"];
  if (keys.some((key) => !allowed.includes(key)) || raw.page !== 1 || raw.totalCount !== 0 || !Number.isSafeInteger(raw.limit) || Number(raw.limit) < 0 || !Array.isArray(raw.requests) || raw.requests.length !== 0 || raw.nextCursor !== void 0 && raw.nextCursor !== null && raw.nextCursor !== "") {
    fail4("ABSENCE_NOT_PROVEN", "raw response is not the exact zero-result page");
  }
  return {
    page: 1,
    totalCount: 0,
    limit: Number(raw.limit),
    requests: []
  };
}
function artifact(bytes, path7) {
  return { path: path7, byte_length: bytes.byteLength, sha256: sha2562(bytes) };
}
function verifyWalmartItemV6AbsenceProbeEvidenceFamily(input) {
  const actualNames = Object.keys(input.artifacts).sort();
  assertCanonicalEqual(
    actualNames,
    [...WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES],
    "probe artifact inventory"
  );
  const bytes = /* @__PURE__ */ new Map();
  for (const name of WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES) {
    const value = input.artifacts[name];
    if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > MAX_RESPONSE_BYTES) {
      fail4("INVALID_PROBE_EVIDENCE", `${name} bytes are invalid`);
    }
    bytes.set(name, value);
  }
  const authorityBytes = bytes.get("00-probe-authority.json");
  const reservationBytes = bytes.get("10-get-reserved.json");
  const responseBytes = bytes.get("20-response-raw.bytes");
  const httpBytes = bytes.get("21-response-http.json");
  const sealBytes = bytes.get("22-exchange-seal.json");
  const resultBytes = bytes.get("30-result.json");
  const authority = parseCanonicalJson(authorityBytes, "probe authority");
  const reservation = parseCanonicalJson(reservationBytes, "GET reservation");
  const http = parseCanonicalJson(httpBytes, "HTTP metadata");
  const seal = parseCanonicalJson(sealBytes, "exchange seal");
  const result = parseCanonicalJson(resultBytes, "probe result");
  const probeId = exactString4(authority.probe_id, "probe_id", 180);
  if (input.expected_probe_id !== void 0 && probeId !== input.expected_probe_id) {
    fail4("PROBE_EVIDENCE_BINDING_MISMATCH", "probe_id differs from the expected custody root");
  }
  const correlationId = exactString4(
    record3(authority.request, "authority request").request_correlation_id,
    "request correlation ID",
    128
  );
  const correlationSha = sha2562(Buffer.from(correlationId, "utf8"));
  const createdAt = strictInstant4(authority.created_at, "authority created_at");
  const expectedFingerprint = input.expected_account_fingerprint_for_test ?? WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_ACCOUNT_FINGERPRINT;
  const accountScope = {
    channel: "WALMART_US",
    store_index: 1,
    seller_id: WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_SELLER_ID,
    seller_account_fingerprint_sha256: expectedFingerprint
  };
  assertCanonicalEqual(authority, {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_EVIDENCE_SCHEMA,
    artifact: "probe-authority",
    probe_id: probeId,
    created_at: createdAt,
    account_scope: accountScope,
    request: {
      method: "GET",
      endpoint: API_ENDPOINT,
      query: { ...WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_QUERY },
      request_correlation_id: correlationId,
      request_correlation_id_sha256: correlationSha
    },
    budget: {
      oauth_token_posts_maximum: 1,
      report_requests_gets_maximum: 1,
      report_create_posts_maximum: 0,
      retries_allowed: 0,
      redirects_allowed: 0,
      cursor_calls_allowed: 0,
      listing_content_writes_allowed: 0,
      model_calls_allowed: 0,
      database_calls_allowed: 0
    }
  }, "probe authority");
  const reservedAt = strictInstant4(reservation.reserved_at, "reservation reserved_at");
  assertCanonicalEqual(reservation, {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_EVIDENCE_SCHEMA,
    artifact: "get-reservation",
    probe_id: probeId,
    reserved_at: reservedAt,
    authority_sha256: sha2562(authorityBytes),
    request_sha256: sha2562(canonicalBytes(fixedRequest(correlationId))),
    state: "GET_RESERVED",
    retry_allowed: false
  }, "GET reservation");
  const observedAt = strictInstant4(http.observed_at, "HTTP observed_at");
  const headers = validateSafeHeaders(http.safe_response_headers);
  assertCanonicalEqual(http, {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_EVIDENCE_SCHEMA,
    artifact: "response-http",
    probe_id: probeId,
    observed_at: observedAt,
    status: 200,
    safe_response_headers: headers,
    raw_response_byte_length: responseBytes.byteLength,
    raw_response_sha256: sha2562(responseBytes),
    request_correlation_id_sha256: correlationSha,
    validation_error_code: null
  }, "HTTP metadata");
  const parsedResponse = parseExactZeroResponse(responseBytes);
  const inventory2 = [
    artifact(authorityBytes, "00-probe-authority.json"),
    artifact(reservationBytes, "10-get-reserved.json"),
    artifact(responseBytes, "20-response-raw.bytes"),
    artifact(httpBytes, "21-response-http.json")
  ];
  const sealPreimage = {
    authority_sha256: inventory2[0].sha256,
    reservation_sha256: inventory2[1].sha256,
    raw_response_sha256: inventory2[2].sha256,
    http_metadata_sha256: inventory2[3].sha256
  };
  assertCanonicalEqual(seal, {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_EVIDENCE_SCHEMA,
    artifact: "exchange-seal",
    probe_id: probeId,
    ...sealPreimage,
    exchange_sha256: sha2562(canonicalBytes(sealPreimage))
  }, "exchange seal");
  inventory2.push(artifact(sealBytes, "22-exchange-seal.json"));
  const completedAt = strictInstant4(result.completed_at, "result completed_at");
  const evidenceFamilySha = sha2562(canonicalBytes(inventory2));
  assertCanonicalEqual(result, {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_EVIDENCE_SCHEMA,
    artifact: "result",
    probe_id: probeId,
    completed_at: completedAt,
    outcome: "ABSENCE_ONLY",
    absence_proven_for_exact_query: true,
    stop_required: false,
    response: {
      page: parsedResponse.page,
      total_count: parsedResponse.totalCount,
      limit: parsedResponse.limit,
      request_count: 0,
      next_cursor_present: false
    },
    http_calls: {
      oauth_token_posts: 1,
      report_requests_gets: 1,
      presigned_file_calls: 0
    },
    report_create_posts: 0,
    retries: 0,
    cursor_calls: 0,
    listing_content_writes: 0,
    model_calls: 0,
    database_calls: 0,
    evidence_inventory: inventory2,
    evidence_family_sha256: evidenceFamilySha
  }, "probe result");
  if (!(Date.parse(createdAt) <= Date.parse(reservedAt) && Date.parse(reservedAt) <= Date.parse(observedAt) && Date.parse(observedAt) <= Date.parse(completedAt))) {
    fail4("INVALID_PROBE_EVIDENCE", "probe chronology is invalid");
  }
  const xRequestId = typeof headers["x-request-id"] === "string" ? headers["x-request-id"] : null;
  return {
    schema_version: WALMART_ITEM_V6_ABSENCE_PROBE_EVIDENCE_SCHEMA,
    probe_id: probeId,
    account_scope: accountScope,
    query: WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_QUERY,
    created_at: createdAt,
    reserved_at: reservedAt,
    observed_at: observedAt,
    completed_at: completedAt,
    fresh_until: new Date(
      Date.parse(observedAt) + WALMART_ITEM_V6_ABSENCE_PROBE_EVIDENCE_MAX_AGE_MS
    ).toISOString(),
    request_correlation_id: correlationId,
    request_correlation_id_sha256: correlationSha,
    walmart_x_request_id: xRequestId,
    raw_response_sha256: sha2562(responseBytes),
    raw_response_byte_length: responseBytes.byteLength,
    artifact_inventory: [...inventory2, artifact(resultBytes, "30-result.json")],
    evidence_family_sha256: evidenceFamilySha,
    result_artifact_sha256: sha2562(resultBytes),
    outcome: "ABSENCE_ONLY",
    exact_query_absence_verified: true,
    http_calls: {
      oauth_token_posts: 1,
      report_requests_gets: 1,
      presigned_file_calls: 0
    }
  };
}

// src/lib/walmart/item-report-reissue-source-evidence-renewal-v1.ts
import { createHash as createHash8 } from "node:crypto";
var WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_SCHEMA = "walmart-item-report-reissue-source-evidence-renewal/v1";
var WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_POLICY = "walmart-item-v6-incident-evidence-renewal/1.0.0";
var WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_BASELINE_SHA256 = "3efd693468f9c0761d6091d379c06e2daddb7d8dadc908228eb282ddeab4fa31";
var WalmartItemReportReissueSourceEvidenceRenewalV1Error = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WalmartItemReportReissueSourceEvidenceRenewalV1Error";
    this.code = code;
  }
};
function fail5(code, message) {
  throw new WalmartItemReportReissueSourceEvidenceRenewalV1Error(code, message);
}
function isRecord8(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record4(value, label) {
  if (!isRecord8(value)) fail5("INVALID_RENEWAL", `${label} must be an object`);
  return value;
}
function exactKeys3(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail5("INVALID_RENEWAL", `${label} has missing or extra fields`);
  }
}
function exactString5(value, label, maximum = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail5("INVALID_RENEWAL", `${label} is invalid`);
  }
  return value;
}
function identifier(value, label) {
  const parsed = exactString5(value, label, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(parsed) || parsed.includes("//") || parsed.endsWith("/")) {
    fail5("INVALID_RENEWAL", `${label} is not a safe identifier`);
  }
  return parsed;
}
function digest2(value, label) {
  const parsed = exactString5(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) {
    fail5("INVALID_RENEWAL", `${label} is not a lowercase SHA-256`);
  }
  return parsed;
}
function strictInstant5(value, label) {
  const parsed = exactString5(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed) || !Number.isFinite(Date.parse(parsed)) || new Date(Date.parse(parsed)).toISOString() !== parsed) {
    fail5("INVALID_RENEWAL", `${label} must be canonical UTC milliseconds`);
  }
  return parsed;
}
function sha2563(bytes) {
  return createHash8("sha256").update(bytes).digest("hex");
}
function sameCanonical3(left, right) {
  return canonicalWalmartItemReportJson(left) === canonicalWalmartItemReportJson(right);
}
function exactBase64(value, label, maximum = 8 * 1024 * 1024) {
  const parsed = exactString5(value, label, maximum);
  if (/\s/u.test(parsed)) fail5("INVALID_RENEWAL", `${label} contains whitespace`);
  const bytes = Buffer.from(parsed, "base64");
  if (bytes.byteLength < 1 || bytes.toString("base64") !== parsed) {
    fail5("INVALID_RENEWAL", `${label} is not canonical base64`);
  }
  return bytes;
}
function releasePreimage2(body, bodySha256) {
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_SCHEMA,
    body,
    body_sha256: bodySha256
  };
}
function fixedPolicy() {
  return {
    policy_id: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_POLICY,
    baseline_r4_exact_bytes_required: true,
    fresh_probe_exact_bytes_embedded: true,
    fresh_probe_maximum_age_ms: 24 * 60 * 60 * 1e3,
    exact_zero_result_required: true,
    quarantined_session_mutation_allowed: false,
    authorizes_replacement_post: false
  };
}
function fixedDispositionBasis() {
  return {
    verdict: "NO_API_VISIBLE_V6_REQUEST_IN_EXACT_QUERY_WINDOW",
    baseline_incident_evidence_retained: true,
    baseline_terminal_failure_supersedable: false,
    fresh_independent_exact_absence_observed: true,
    fresh_probe_account_machine_bound_to_active_credentials: true,
    original_create_success_proven: false,
    original_create_failure_proven: false,
    original_request_id_adoption_allowed: false,
    original_session_reinterpretation_allowed: false,
    duplicate_replacement_request_risk: "NON_ZERO",
    external_owner_ed25519_disposition_required: true,
    separate_one_shot_execution_ledger_required: true
  };
}
function baselineFromBytes(bytes) {
  const artifactSha = sha2563(bytes);
  if (artifactSha !== WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_BASELINE_SHA256) {
    fail5("BASELINE_HASH_MISMATCH", "baseline source evidence is not the frozen R4 artifact");
  }
  const release = parseWalmartItemReportReissueSourceEvidenceV2Bytes(bytes);
  const canonical = Buffer.from(canonicalWalmartItemReportJson(release), "utf8");
  if (!Buffer.from(bytes).equals(canonical)) {
    fail5("BASELINE_HASH_MISMATCH", "baseline source evidence bytes are not canonical R4");
  }
  return {
    binding: {
      schema_version: "walmart-item-report-reissue-source-evidence/v2",
      artifact_sha256: artifactSha,
      release_id: String(release.body.release_id),
      release_sha256: release.release_sha256,
      body_sha256: release.body_sha256,
      canonical_bytes_base64: canonical.toString("base64")
    },
    release
  };
}
function embeddedProbeArtifacts(raw) {
  return WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES.map((name) => {
    const bytes = raw[name];
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) {
      fail5("INVALID_RENEWAL", `fresh probe artifact is missing: ${name}`);
    }
    return {
      path: name,
      byte_length: bytes.byteLength,
      sha256: sha2563(bytes),
      bytes_base64: Buffer.from(bytes).toString("base64")
    };
  });
}
function freshProbeBinding(verified, raw) {
  return {
    probe_id: verified.probe_id,
    account_scope: verified.account_scope,
    query: verified.query,
    created_at: verified.created_at,
    reserved_at: verified.reserved_at,
    observed_at: verified.observed_at,
    completed_at: verified.completed_at,
    fresh_until: verified.fresh_until,
    request_correlation_id_sha256: verified.request_correlation_id_sha256,
    walmart_x_request_id: verified.walmart_x_request_id,
    raw_response_sha256: verified.raw_response_sha256,
    raw_response_byte_length: verified.raw_response_byte_length,
    artifact_inventory: embeddedProbeArtifacts(raw),
    evidence_family_sha256: verified.evidence_family_sha256,
    result_artifact_sha256: verified.result_artifact_sha256,
    outcome: "ABSENCE_ONLY",
    exact_query_absence_verified: true,
    http_calls: verified.http_calls
  };
}
function buildWalmartItemReportReissueSourceEvidenceRenewalV1(input) {
  const baseline = baselineFromBytes(input.baseline_source_evidence_bytes);
  const fresh = verifyWalmartItemV6AbsenceProbeEvidenceFamily({
    artifacts: input.fresh_probe_artifacts,
    expected_probe_id: input.expected_probe_id,
    expected_account_fingerprint_for_test: input.expected_account_fingerprint_for_test
  });
  const reviewedAt = strictInstant5(input.reviewed_at, "reviewed_at");
  if (Date.parse(reviewedAt) < Date.parse(fresh.observed_at) || Date.parse(reviewedAt) >= Date.parse(fresh.fresh_until)) {
    fail5("STALE_RENEWAL", "reviewed_at is outside the fresh probe window");
  }
  const body = {
    release_id: identifier(input.release_id, "release_id"),
    reviewed_at: reviewedAt,
    policy: fixedPolicy(),
    baseline: baseline.binding,
    fresh_probe: freshProbeBinding(fresh, input.fresh_probe_artifacts),
    disposition_basis: fixedDispositionBasis()
  };
  const bodySha256 = walmartItemReportSha256(body);
  const releaseSha256 = walmartItemReportSha256(releasePreimage2(body, bodySha256));
  return verifyWalmartItemReportReissueSourceEvidenceRenewalV1({
    schema_version: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_SCHEMA,
    body,
    body_sha256: bodySha256,
    release_sha256: releaseSha256
  });
}
function parseBaseline(value) {
  const raw = record4(value, "renewal baseline");
  exactKeys3(raw, [
    "artifact_sha256",
    "body_sha256",
    "canonical_bytes_base64",
    "release_id",
    "release_sha256",
    "schema_version"
  ], "renewal baseline");
  if (raw.schema_version !== "walmart-item-report-reissue-source-evidence/v2") {
    fail5("INVALID_RENEWAL", "renewal baseline schema is invalid");
  }
  const bytes = exactBase64(raw.canonical_bytes_base64, "baseline canonical bytes");
  const parsed = baselineFromBytes(bytes);
  if (!sameCanonical3(raw, parsed.binding)) {
    fail5("BASELINE_HASH_MISMATCH", "renewal baseline binding differs from exact R4 bytes");
  }
  return parsed;
}
function decodeProbeArtifacts(value) {
  if (!Array.isArray(value) || value.length !== WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES.length) {
    fail5("INVALID_RENEWAL", "renewal fresh probe inventory is incomplete");
  }
  const output = {};
  for (const [index, item] of value.entries()) {
    const raw = record4(item, `fresh probe artifact ${index}`);
    exactKeys3(raw, ["byte_length", "bytes_base64", "path", "sha256"], `fresh probe artifact ${index}`);
    const expectedPath = WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES[index];
    if (raw.path !== expectedPath || !Number.isSafeInteger(raw.byte_length) || Number(raw.byte_length) < 1) {
      fail5("INVALID_RENEWAL", "fresh probe artifact order/path/length is invalid");
    }
    const bytes = exactBase64(raw.bytes_base64, `fresh probe artifact ${index} bytes`);
    const artifactSha = digest2(raw.sha256, `fresh probe artifact ${index} SHA-256`);
    if (bytes.byteLength !== raw.byte_length || sha2563(bytes) !== artifactSha) {
      fail5("PROBE_HASH_MISMATCH", "fresh probe embedded artifact bytes differ");
    }
    output[expectedPath] = Uint8Array.from(bytes);
  }
  return output;
}
function parseFreshProbe(value) {
  const raw = record4(value, "renewal fresh_probe");
  exactKeys3(raw, [
    "account_scope",
    "artifact_inventory",
    "completed_at",
    "created_at",
    "evidence_family_sha256",
    "exact_query_absence_verified",
    "fresh_until",
    "http_calls",
    "observed_at",
    "outcome",
    "probe_id",
    "query",
    "raw_response_byte_length",
    "raw_response_sha256",
    "request_correlation_id_sha256",
    "reserved_at",
    "result_artifact_sha256",
    "walmart_x_request_id"
  ], "renewal fresh_probe");
  const artifacts = decodeProbeArtifacts(raw.artifact_inventory);
  const verified = verifyWalmartItemV6AbsenceProbeEvidenceFamily({
    artifacts,
    expected_probe_id: identifier(raw.probe_id, "fresh_probe.probe_id")
  });
  const expected = freshProbeBinding(verified, artifacts);
  if (!sameCanonical3(raw, expected)) {
    fail5("PROBE_HASH_MISMATCH", "renewal fresh_probe differs from embedded exact bytes");
  }
  return expected;
}
function parseBody(value) {
  const raw = record4(value, "renewal body");
  exactKeys3(raw, [
    "baseline",
    "disposition_basis",
    "fresh_probe",
    "policy",
    "release_id",
    "reviewed_at"
  ], "renewal body");
  const releaseId = identifier(raw.release_id, "release_id");
  const reviewedAt = strictInstant5(raw.reviewed_at, "reviewed_at");
  const baseline = parseBaseline(raw.baseline);
  const fresh = parseFreshProbe(raw.fresh_probe);
  if (!sameCanonical3(raw.policy, fixedPolicy())) {
    fail5("INVALID_RENEWAL", "renewal policy differs from the fixed contract");
  }
  if (!sameCanonical3(raw.disposition_basis, fixedDispositionBasis())) {
    fail5("INVALID_RENEWAL", "renewal disposition basis differs from the fixed contract");
  }
  if (fresh.account_scope.seller_account_fingerprint_sha256 !== WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_ACCOUNT_FINGERPRINT || !sameCanonical3(fresh.query, WALMART_ITEM_V6_ABSENCE_PROBE_EXPECTED_QUERY)) {
    fail5("ACCOUNT_SCOPE_MISMATCH", "renewal fresh probe account/query is invalid");
  }
  if (Date.parse(reviewedAt) < Date.parse(fresh.observed_at) || Date.parse(reviewedAt) >= Date.parse(fresh.fresh_until)) {
    fail5("STALE_RENEWAL", "renewal reviewed_at is outside the fresh probe window");
  }
  return {
    release_id: releaseId,
    reviewed_at: reviewedAt,
    policy: fixedPolicy(),
    baseline: baseline.binding,
    fresh_probe: fresh,
    disposition_basis: fixedDispositionBasis()
  };
}
function verifyWalmartItemReportReissueSourceEvidenceRenewalV1(value) {
  const raw = record4(value, "renewal release");
  exactKeys3(raw, ["body", "body_sha256", "release_sha256", "schema_version"], "renewal release");
  if (raw.schema_version !== WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_SCHEMA) {
    fail5("INVALID_RENEWAL", "renewal release schema is invalid");
  }
  const body = parseBody(raw.body);
  const bodySha256 = digest2(raw.body_sha256, "body_sha256");
  const releaseSha256 = digest2(raw.release_sha256, "release_sha256");
  if (bodySha256 !== walmartItemReportSha256(body) || releaseSha256 !== walmartItemReportSha256(releasePreimage2(body, bodySha256))) {
    fail5("RENEWAL_HASH_MISMATCH", "renewal release hash binding is invalid");
  }
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_SCHEMA,
    body,
    body_sha256: bodySha256,
    release_sha256: releaseSha256
  };
}
function parseWalmartItemReportReissueSourceEvidenceRenewalV1Bytes(bytes) {
  let value;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail5("INVALID_RENEWAL", "renewal release bytes are not UTF-8 JSON");
  }
  const parsed = verifyWalmartItemReportReissueSourceEvidenceRenewalV1(value);
  if (text !== canonicalWalmartItemReportJson(parsed)) {
    fail5("NON_CANONICAL_RENEWAL", "renewal release bytes are not canonical JSON");
  }
  return parsed;
}
function serializeWalmartItemReportReissueSourceEvidenceRenewalV1(release) {
  return Buffer.from(
    canonicalWalmartItemReportJson(
      verifyWalmartItemReportReissueSourceEvidenceRenewalV1(release)
    ),
    "utf8"
  );
}
function walmartItemReportReissueSourceEvidenceRenewalV1BaselineRelease(release) {
  const verified = verifyWalmartItemReportReissueSourceEvidenceRenewalV1(release);
  return parseWalmartItemReportReissueSourceEvidenceV2Bytes(
    Buffer.from(verified.body.baseline.canonical_bytes_base64, "base64")
  );
}
function walmartItemReportReissueSourceEvidenceRenewalV1FreshProbeArtifacts(release) {
  const verified = verifyWalmartItemReportReissueSourceEvidenceRenewalV1(release);
  return decodeProbeArtifacts(verified.body.fresh_probe.artifact_inventory);
}
function walmartItemReportReissueSourceEvidenceRenewalV1ProbeInventory(release) {
  const verified = verifyWalmartItemReportReissueSourceEvidenceRenewalV1(release);
  return verified.body.fresh_probe.artifact_inventory.map((entry) => ({
    path: entry.path,
    byte_length: entry.byte_length,
    sha256: entry.sha256
  }));
}

// src/lib/walmart/owner-control-trust-root.ts
import { createHash as createHash9, createPublicKey } from "node:crypto";
var PINNED_OWNER_CONTROL_KEYS = Object.freeze([
  {
    key_id: "walmart-owner-control-2026-01",
    public_key_spki_der_base64: "MCowBQYDK2VwAyEAIT9cBEcfy0WfQAe5qb6z/R1E357FnZAce12X6XmBjTw=",
    public_key_spki_sha256: "ca74a2134808ab46eb162b14dfe481730fc69df00b57283cffd7a7bb1d37883a",
    status: "ACTIVE",
    environment: "PRODUCTION"
  }
]);
function canonicalBase64(value) {
  if (typeof value !== "string" || value.length < 40 || /\s/u.test(value)) {
    return false;
  }
  try {
    const bytes = Buffer.from(value, "base64");
    return bytes.length > 0 && bytes.toString("base64") === value;
  } catch {
    return false;
  }
}
function sha2564(bytes) {
  return createHash9("sha256").update(bytes).digest("hex");
}
function validateWalmartOwnerControlTrustedKey(key) {
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/iu.test(key.key_id) || !canonicalBase64(key.public_key_spki_der_base64) || !/^[a-f0-9]{64}$/u.test(key.public_key_spki_sha256) || !["ACTIVE", "REVOKED"].includes(key.status) || !["PRODUCTION", "TEST_FIXTURE_ONLY"].includes(key.environment)) {
    throw new Error("Walmart owner-control trust root is malformed");
  }
  const der = Buffer.from(key.public_key_spki_der_base64, "base64");
  if (sha2564(der) !== key.public_key_spki_sha256) {
    throw new Error("Walmart owner-control public-key fingerprint mismatch");
  }
  const publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Walmart owner-control trust root must be Ed25519");
  }
}
function walmartOwnerControlProductionTrustedKeys() {
  const keys = [...PINNED_OWNER_CONTROL_KEYS];
  const ids = /* @__PURE__ */ new Set();
  for (const key of keys) {
    validateWalmartOwnerControlTrustedKey(key);
    if (key.environment !== "PRODUCTION") {
      throw new Error("Pinned Walmart owner-control key must be PRODUCTION");
    }
    if (ids.has(key.key_id)) {
      throw new Error("Duplicate Walmart owner-control key_id");
    }
    ids.add(key.key_id);
  }
  return Object.freeze(keys);
}

// src/lib/walmart/item-report-reissue-owner-disposition-v2.ts
import {
  createHash as createHash10,
  createPublicKey as createPublicKey2,
  verify as verifySignature
} from "node:crypto";
var WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_SCHEMA = "walmart-item-report-reissue-owner-disposition/v3";
var WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_ALGORITHM = "Ed25519";
var WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_ACTION = "WALMART_ITEM_V6_REPORT_CREATE_REISSUE";
var WALMART_ITEM_REPORT_REISSUE_DELEGATED_AUTHORIZATION_V1_SCHEMA = "walmart-item-report-reissue-delegated-authorization/v1";
var WALMART_ITEM_REPORT_REISSUE_DELEGATED_AUTHORIZATION_V1_MODE = "OWNER_DELEGATED_AUTOMATION";
var WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_MAX_TTL_MS = 30 * 60 * 1e3;
var WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_CLOCK_SKEW_MS = 5 * 60 * 1e3;
var SIGNING_DOMAIN = Buffer.from(
  "SS_COMMAND_CENTER\0WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION\0v3\0",
  "utf8"
);
var EMPTY_BODY_SHA256 = createHash10("sha256").update("{}", "utf8").digest("hex");
var WalmartItemReportReissueOwnerDispositionV2Error = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WalmartItemReportReissueOwnerDispositionV2Error";
    this.code = code;
  }
};
function fail6(code, message) {
  throw new WalmartItemReportReissueOwnerDispositionV2Error(code, message);
}
function isRecord9(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record5(value, label) {
  if (!isRecord9(value)) fail6("INVALID_DISPOSITION", `${label} must be an object`);
  return value;
}
function exactKeys4(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail6("INVALID_DISPOSITION", `${label} has missing or extra fields`);
  }
}
function exactString6(value, label, maximum = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail6("INVALID_DISPOSITION", `${label} is invalid`);
  }
  return value;
}
function safeIdentifier4(value, label) {
  const parsed = exactString6(value, label, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(parsed) || parsed.includes("//") || parsed.endsWith("/")) {
    fail6("INVALID_DISPOSITION", `${label} is not a safe identifier`);
  }
  return parsed;
}
function digest3(value, label) {
  const parsed = exactString6(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) {
    fail6("INVALID_DISPOSITION", `${label} must be a lowercase SHA-256 digest`);
  }
  return parsed;
}
function strictInstant6(value, label) {
  const instant = exactString6(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(instant) || !Number.isFinite(Date.parse(instant)) || new Date(Date.parse(instant)).toISOString() !== instant) {
    fail6("INVALID_DISPOSITION", `${label} must be canonical UTC milliseconds`);
  }
  return instant;
}
function decisionReference2(value) {
  const reference = exactString6(value, "decision_ref", 2048);
  let parsed;
  try {
    parsed = new URL(reference);
  } catch {
    fail6("INVALID_DISPOSITION", "decision_ref must be an absolute external reference");
  }
  if (!(/* @__PURE__ */ new Set(["https:", "urn:"])).has(parsed.protocol)) {
    fail6("INVALID_DISPOSITION", "decision_ref protocol is not approved");
  }
  return reference;
}
function sha256Bytes4(value) {
  return createHash10("sha256").update(value).digest("hex");
}
function canonicalBase642(value, label, maximum = 16384) {
  const parsed = exactString6(value, label, maximum);
  if (/\s/u.test(parsed)) fail6("INVALID_DISPOSITION", `${label} contains whitespace`);
  const bytes = Buffer.from(parsed, "base64");
  if (bytes.byteLength < 1 || bytes.toString("base64") !== parsed) {
    fail6("INVALID_DISPOSITION", `${label} must be canonical base64`);
  }
  return { value: parsed, bytes };
}
function exactJsonEqual2(left, right) {
  return canonicalWalmartItemReportJson(left) === canonicalWalmartItemReportJson(right);
}
function validateTrustedKey(key) {
  try {
    validateWalmartOwnerControlTrustedKey(key);
  } catch {
    fail6("INVALID_TRUST_ROOT", "Walmart owner-control public key is invalid");
  }
}
function testFixtureKey(env) {
  if (env.NODE_ENV !== "test" || env.WALMART_ITEM_REPORT_REISSUE_V2_TEST_MODE !== "1") {
    return null;
  }
  const keyId = env.WALMART_ITEM_REPORT_REISSUE_V2_TEST_OWNER_KEY_ID;
  const publicKey = env.WALMART_ITEM_REPORT_REISSUE_V2_TEST_OWNER_PUBLIC_KEY_SPKI_DER_BASE64;
  if (!keyId || !publicKey) return null;
  const bytes = Buffer.from(publicKey, "base64");
  return {
    key_id: keyId,
    public_key_spki_der_base64: publicKey,
    public_key_spki_sha256: sha256Bytes4(bytes),
    status: "ACTIVE",
    environment: "TEST_FIXTURE_ONLY"
  };
}
function walmartItemReportReissueOwnerDispositionV2TrustedKeys(env = process.env) {
  const fixture = testFixtureKey(env);
  const productionKeys = walmartOwnerControlProductionTrustedKeys();
  const keys = fixture ? [...productionKeys, fixture] : [...productionKeys];
  const ids = /* @__PURE__ */ new Set();
  for (const key of keys) {
    validateTrustedKey(key);
    if (ids.has(key.key_id)) fail6("INVALID_TRUST_ROOT", "duplicate owner key_id");
    ids.add(key.key_id);
  }
  return Object.freeze(keys);
}
function inspectWalmartItemReportReissueOwnerDispositionV2TrustRoot(env = process.env, environment = "PRODUCTION") {
  const active = walmartItemReportReissueOwnerDispositionV2TrustedKeys(env).filter((key) => key.status === "ACTIVE" && key.environment === environment);
  return {
    ready: active.length > 0,
    active_key_ids: active.map((key) => key.key_id).sort(),
    active_key_fingerprints: active.map((key) => key.public_key_spki_sha256).sort()
  };
}
function resolveTrustedKey(keyId, environment, env) {
  const key = walmartItemReportReissueOwnerDispositionV2TrustedKeys(env).find((candidate) => candidate.key_id === keyId);
  if (!key || key.status !== "ACTIVE" || key.environment !== environment) {
    fail6("OWNER_KEY_UNTRUSTED_OR_REVOKED", "owner disposition key is not active in this domain");
  }
  return key;
}
function parseLedgerBinding(value) {
  const raw = record5(value, "consumption_ledger");
  exactKeys4(raw, [
    "directory_identity_sha256",
    "distributed_at_most_once_claimed",
    "identity_artifact_sha256",
    "ledger_epoch",
    "ledger_id",
    "policy_id",
    "reservation_filename_policy",
    "state_directory_path_sha256",
    "trusted_single_custody_host_only"
  ], "consumption_ledger");
  if (raw.policy_id !== "walmart-item-report-reissue-consumption-ledger/1.0.0" || raw.reservation_filename_policy !== "authorization-sha256.json/exclusive-create/v1" || raw.trusted_single_custody_host_only !== true || raw.distributed_at_most_once_claimed !== false) {
    fail6("INVALID_DISPOSITION", "consumption ledger safety policy is invalid");
  }
  return {
    policy_id: "walmart-item-report-reissue-consumption-ledger/1.0.0",
    ledger_id: safeIdentifier4(raw.ledger_id, "consumption_ledger.ledger_id"),
    ledger_epoch: safeIdentifier4(raw.ledger_epoch, "consumption_ledger.ledger_epoch"),
    state_directory_path_sha256: digest3(
      raw.state_directory_path_sha256,
      "consumption_ledger.state_directory_path_sha256"
    ),
    directory_identity_sha256: digest3(
      raw.directory_identity_sha256,
      "consumption_ledger.directory_identity_sha256"
    ),
    identity_artifact_sha256: digest3(
      raw.identity_artifact_sha256,
      "consumption_ledger.identity_artifact_sha256"
    ),
    reservation_filename_policy: "authorization-sha256.json/exclusive-create/v1",
    trusted_single_custody_host_only: true,
    distributed_at_most_once_claimed: false
  };
}
function fixedAuthorization2() {
  return {
    report_create_post_authorized: true,
    pre_create_absence_guard_required: true,
    same_oauth_transport_required: true,
    maximum_create_post_calls: 1,
    maximum_oauth_token_calls: 1,
    maximum_walmart_report_api_calls_before_create: 2,
    maximum_total_http_calls_before_create: 3,
    maximum_total_http_calls: 22,
    maximum_request_timeout_ms: 6e4,
    retry_attempts_allowed: 0,
    fallbacks_allowed: 0,
    redirects_followed_allowed: 0,
    automatic_replay_allowed: false,
    absence_guard: {
      method: "GET",
      endpoint: "/v3/reports/reportRequests",
      query: {
        reportType: "ITEM",
        reportVersion: "v6",
        requestSubmissionStartDate: "2026-07-19T03:55:00Z",
        requestSubmissionEndDate: "2026-07-19T04:00:00Z",
        src: "API"
      },
      exact_zero_results_required: true,
      next_cursor_forbidden: true
    },
    create_request: {
      method: "POST",
      endpoint: "/v3/reports/reportRequests",
      report_type: "ITEM",
      report_version: "v6",
      request_body_sha256: EMPTY_BODY_SHA256
    },
    continuation: {
      same_oauth_transport_required: true,
      polling_authorized: true,
      maximum_poll_observations: 9,
      poll_interval_ms: 18e4,
      download_locator_calls_maximum: 1,
      presigned_download_calls_maximum: 9,
      compile_network_calls_maximum: 0
    },
    request_id_adoption_from_prior: false,
    original_session_writes_allowed: 0,
    database_calls_allowed: 0,
    model_calls_allowed: 0,
    paid_provider_calls_allowed: 0,
    listing_content_writes_allowed: 0,
    scheduled_execution_allowed: false
  };
}
function fixedRiskAcknowledgement2() {
  return {
    historical_exact_probe_observed_no_api_visible_v6_request: true,
    historical_exact_probe_does_not_prove_original_post_failed: true,
    live_pre_create_guard_must_observe_exact_absence: true,
    live_guard_and_create_must_share_one_oauth_transport: true,
    non_absent_or_ambiguous_guard_forbids_create: true,
    original_post_may_have_reached_walmart: true,
    duplicate_report_request_risk_is_non_zero: true,
    duplicate_report_request_risk_accepted: true,
    exact_probe_account_match_is_operator_asserted_not_machine_verified: true,
    operator_custody_metadata_is_not_walmart_signature_or_tls_transcript: true,
    broad_probe_is_corroborating_only: true,
    quarantined_terminal_failure_remains_authoritative: true,
    prohibited_conflicting_final_must_not_be_consumed: true,
    original_request_id_must_not_be_adopted: true,
    crash_or_ambiguous_replacement_outcome_burns_authorization: true,
    single_custody_ledger_is_not_distributed_at_most_once: true
  };
}
function buildWalmartItemReportReissueReplacementPlanV2(input) {
  const authority = parseWalmartItemReportReissueSessionAuthority(input.session_authority);
  const sessionName = safeIdentifier4(input.session_name, "replacement session_name");
  if (sessionName.includes("/") || sessionName.includes("\\") || sessionName === "." || sessionName === "..") {
    fail6("INVALID_REPLACEMENT", "replacement session_name must be one direct-child name");
  }
  const createManifest = buildWalmartItemReportV6CreateRequestManifest({
    account_scope: authority.account_scope,
    request_correlation_id_sha256: authority.primary_correlations.create.sha256
  });
  return {
    session_name: sessionName,
    session_authority: authority,
    session_authority_sha256: walmartItemReportSha256(authority),
    create_request_manifest: createManifest,
    create_request_manifest_sha256: walmartItemReportSha256(createManifest),
    create_request_correlation_id_sha256: authority.primary_correlations.create.sha256
  };
}
function parseSourceArtifactInventory(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length) {
    fail6("INVALID_DISPOSITION", `${label} has the wrong artifact count`);
  }
  const parsed = value.map((entry, index) => {
    const raw = record5(entry, `${label}[${index}]`);
    exactKeys4(raw, ["byte_length", "path", "sha256"], `${label}[${index}]`);
    if (!Number.isSafeInteger(raw.byte_length) || Number(raw.byte_length) < 0) {
      fail6("INVALID_DISPOSITION", `${label}[${index}].byte_length is invalid`);
    }
    return {
      path: exactString6(raw.path, `${label}[${index}].path`, 512),
      byte_length: Number(raw.byte_length),
      sha256: digest3(raw.sha256, `${label}[${index}].sha256`)
    };
  });
  if (!exactJsonEqual2(parsed, expected)) {
    fail6("INVALID_DISPOSITION", `${label} differs from the incident-bound inventory`);
  }
  return parsed;
}
function parseCurrentExactProbeInventory(value) {
  const legacy = WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_EXPECTED_PROBE_FILES.filter((entry) => entry.path.startsWith("exact-v6/"));
  if (Array.isArray(value) && exactJsonEqual2(value, legacy)) {
    return parseSourceArtifactInventory(value, legacy, "source_evidence.exact_probe_artifacts");
  }
  if (!Array.isArray(value) || value.length !== WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES.length) {
    fail6("INVALID_DISPOSITION", "source_evidence exact probe artifact count is invalid");
  }
  return value.map((entry, index) => {
    const raw = record5(entry, `source_evidence.exact_probe_artifacts[${index}]`);
    exactKeys4(
      raw,
      ["byte_length", "path", "sha256"],
      `source_evidence.exact_probe_artifacts[${index}]`
    );
    if (raw.path !== WALMART_ITEM_V6_ABSENCE_PROBE_ARTIFACT_NAMES[index] || !Number.isSafeInteger(raw.byte_length) || Number(raw.byte_length) < 1) {
      fail6("INVALID_DISPOSITION", "source_evidence renewal probe inventory is invalid");
    }
    return {
      path: String(raw.path),
      byte_length: Number(raw.byte_length),
      sha256: digest3(raw.sha256, `source_evidence exact artifact ${index} SHA-256`)
    };
  });
}
function parseSourceEvidenceBinding(value) {
  const raw = record5(value, "source_evidence");
  exactKeys4(raw, [
    "artifact_sha256",
    "body_sha256",
    "broad_probe_artifacts",
    "exact_probe_artifacts",
    "exact_probe_fresh_until",
    "exact_probe_observed_at",
    "original_four",
    "prohibited_conflicting_complete_sha256",
    "prohibited_conflicting_page_complete_sha256",
    "prohibited_conflicting_result_sha256",
    "quarantined_inventory_sha256",
    "release_id",
    "release_sha256",
    "terminal_failure_sha256",
    "verdict"
  ], "source_evidence");
  if (raw.verdict !== "NO_API_VISIBLE_V6_REQUEST_IN_EXACT_QUERY_WINDOW") {
    fail6("INVALID_DISPOSITION", "source_evidence verdict is invalid");
  }
  const originalFour = record5(raw.original_four, "source_evidence.original_four");
  exactKeys4(originalFour, [
    "create_manifest_sha256",
    "manual_review_sha256",
    "request_reserved_sha256",
    "session_authority_sha256"
  ], "source_evidence.original_four");
  const expectedBroad = WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_EXPECTED_PROBE_FILES.filter((entry) => entry.path.startsWith("broad-48h/"));
  const expectedInventorySha = walmartItemReportSha256(
    WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_EXPECTED_QUARANTINE_FILES
  );
  const inventorySha = digest3(
    raw.quarantined_inventory_sha256,
    "source_evidence.quarantined_inventory_sha256"
  );
  if (inventorySha !== expectedInventorySha) {
    fail6("INVALID_DISPOSITION", "source_evidence quarantine inventory binding is invalid");
  }
  return {
    artifact_sha256: digest3(raw.artifact_sha256, "source_evidence.artifact_sha256"),
    release_sha256: digest3(raw.release_sha256, "source_evidence.release_sha256"),
    body_sha256: digest3(raw.body_sha256, "source_evidence.body_sha256"),
    release_id: safeIdentifier4(raw.release_id, "source_evidence.release_id"),
    verdict: "NO_API_VISIBLE_V6_REQUEST_IN_EXACT_QUERY_WINDOW",
    exact_probe_observed_at: strictInstant6(
      raw.exact_probe_observed_at,
      "source_evidence.exact_probe_observed_at"
    ),
    exact_probe_fresh_until: strictInstant6(
      raw.exact_probe_fresh_until,
      "source_evidence.exact_probe_fresh_until"
    ),
    exact_probe_artifacts: parseCurrentExactProbeInventory(
      raw.exact_probe_artifacts
    ),
    broad_probe_artifacts: parseSourceArtifactInventory(
      raw.broad_probe_artifacts,
      expectedBroad,
      "source_evidence.broad_probe_artifacts"
    ),
    original_four: {
      session_authority_sha256: digest3(
        originalFour.session_authority_sha256,
        "source_evidence.original_four.session_authority_sha256"
      ),
      create_manifest_sha256: digest3(
        originalFour.create_manifest_sha256,
        "source_evidence.original_four.create_manifest_sha256"
      ),
      request_reserved_sha256: digest3(
        originalFour.request_reserved_sha256,
        "source_evidence.original_four.request_reserved_sha256"
      ),
      manual_review_sha256: digest3(
        originalFour.manual_review_sha256,
        "source_evidence.original_four.manual_review_sha256"
      )
    },
    terminal_failure_sha256: digest3(
      raw.terminal_failure_sha256,
      "source_evidence.terminal_failure_sha256"
    ),
    prohibited_conflicting_page_complete_sha256: digest3(
      raw.prohibited_conflicting_page_complete_sha256,
      "source_evidence.prohibited_conflicting_page_complete_sha256"
    ),
    prohibited_conflicting_result_sha256: digest3(
      raw.prohibited_conflicting_result_sha256,
      "source_evidence.prohibited_conflicting_result_sha256"
    ),
    prohibited_conflicting_complete_sha256: digest3(
      raw.prohibited_conflicting_complete_sha256,
      "source_evidence.prohibited_conflicting_complete_sha256"
    ),
    quarantined_inventory_sha256: inventorySha
  };
}
function parsePriorIncidentBinding(value) {
  const raw = record5(value, "prior_incident");
  exactKeys4(raw, [
    "consume_conflicting_final",
    "original_create_response_retained",
    "original_request_complete_written",
    "request_id_adopted",
    "retry_allowed",
    "session_id",
    "session_name",
    "terminal_failure_retained",
    "terminal_failure_supersedable"
  ], "prior_incident");
  if (raw.terminal_failure_retained !== true || raw.terminal_failure_supersedable !== false || raw.original_request_complete_written !== false || raw.original_create_response_retained !== false || raw.request_id_adopted !== false || raw.retry_allowed !== false || raw.consume_conflicting_final !== false) {
    fail6("INVALID_DISPOSITION", "prior_incident relaxes the retained terminal failure");
  }
  const sessionName = safeIdentifier4(raw.session_name, "prior_incident.session_name");
  if (sessionName.includes("/") || sessionName.includes("\\") || sessionName === "." || sessionName === "..") {
    fail6("INVALID_DISPOSITION", "prior_incident.session_name must be one direct-child name");
  }
  return {
    session_name: sessionName,
    session_id: safeIdentifier4(raw.session_id, "prior_incident.session_id"),
    terminal_failure_retained: true,
    terminal_failure_supersedable: false,
    original_request_complete_written: false,
    original_create_response_retained: false,
    request_id_adopted: false,
    retry_allowed: false,
    consume_conflicting_final: false
  };
}
function parseWalmartItemReportReissueCurrentSourceEvidenceBytes(bytes) {
  let schemaVersion;
  try {
    schemaVersion = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))?.schema_version;
  } catch {
    fail6("INVALID_DISPOSITION", "source evidence bytes are not UTF-8 JSON");
  }
  if (schemaVersion === WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_RENEWAL_V1_SCHEMA) {
    const renewal = parseWalmartItemReportReissueSourceEvidenceRenewalV1Bytes(bytes);
    const baseline = walmartItemReportReissueSourceEvidenceRenewalV1BaselineRelease(renewal);
    const fresh = renewal.body.fresh_probe;
    return {
      release_sha256: renewal.release_sha256,
      body_sha256: renewal.body_sha256,
      release_id: safeIdentifier4(renewal.body.release_id, "renewal source release_id"),
      account_scope: record5(fresh.account_scope, "renewal fresh account_scope"),
      original_incident: record5(
        baseline.body.original_ambiguous_post,
        "renewal baseline original incident"
      ),
      exact_probe_observed_at: strictInstant6(
        fresh.observed_at,
        "renewal exact probe observed_at"
      ),
      exact_probe_fresh_until: strictInstant6(
        fresh.fresh_until,
        "renewal exact probe fresh_until"
      ),
      exact_probe_artifacts: walmartItemReportReissueSourceEvidenceRenewalV1ProbeInventory(renewal).map((entry) => ({ ...entry })),
      baseline
    };
  }
  const release = parseWalmartItemReportReissueSourceEvidenceV2Bytes(bytes);
  const exact = record5(release.body.exact_probe, "source release exact_probe");
  return {
    release_sha256: release.release_sha256,
    body_sha256: release.body_sha256,
    release_id: safeIdentifier4(release.body.release_id, "source release release_id"),
    account_scope: record5(release.body.account_scope, "source release account_scope"),
    original_incident: record5(
      release.body.original_ambiguous_post,
      "source release original incident"
    ),
    exact_probe_observed_at: strictInstant6(exact.observed_at, "exact probe observed_at"),
    exact_probe_fresh_until: strictInstant6(exact.fresh_until, "exact probe fresh_until"),
    exact_probe_artifacts: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_EXPECTED_PROBE_FILES.filter((entry) => entry.path.startsWith("exact-v6/")).map((entry) => ({ ...entry })),
    baseline: release
  };
}
function sourceEvidenceBinding(evidence, artifactSha256) {
  const original = evidence.original_incident;
  return parseSourceEvidenceBinding({
    artifact_sha256: artifactSha256,
    release_sha256: evidence.release_sha256,
    body_sha256: evidence.body_sha256,
    release_id: evidence.release_id,
    verdict: "NO_API_VISIBLE_V6_REQUEST_IN_EXACT_QUERY_WINDOW",
    exact_probe_observed_at: evidence.exact_probe_observed_at,
    exact_probe_fresh_until: evidence.exact_probe_fresh_until,
    exact_probe_artifacts: evidence.exact_probe_artifacts,
    broad_probe_artifacts: WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_EXPECTED_PROBE_FILES.filter((entry) => entry.path.startsWith("broad-48h/")).map((entry) => ({ ...entry })),
    original_four: {
      session_authority_sha256: digest3(
        original.session_authority_sha256,
        "original session authority digest"
      ),
      create_manifest_sha256: digest3(
        original.create_manifest_sha256,
        "original create manifest digest"
      ),
      request_reserved_sha256: digest3(
        original.request_reserved_sha256,
        "original reservation digest"
      ),
      manual_review_sha256: digest3(
        original.manual_review_sha256,
        "original manual-review digest"
      )
    },
    terminal_failure_sha256: digest3(
      original.terminal_page_failure_sha256,
      "terminal page failure digest"
    ),
    prohibited_conflicting_page_complete_sha256: digest3(
      original.prohibited_conflicting_page_complete_sha256,
      "prohibited page complete digest"
    ),
    prohibited_conflicting_result_sha256: digest3(
      original.prohibited_conflicting_result_sha256,
      "prohibited result digest"
    ),
    prohibited_conflicting_complete_sha256: digest3(
      original.prohibited_conflicting_complete_sha256,
      "prohibited final checkpoint digest"
    ),
    quarantined_inventory_sha256: walmartItemReportSha256(
      WALMART_ITEM_REPORT_REISSUE_SOURCE_EVIDENCE_V2_EXPECTED_QUARANTINE_FILES
    )
  });
}
function priorIncidentBinding(release) {
  const original = record5(
    release.body.original_ambiguous_post,
    "source release original_ambiguous_post"
  );
  if (original.terminal_failure_supersedable !== false || original.original_request_complete_written !== false || original.original_create_response_retained !== false || original.request_id_adopted !== false || original.retry_allowed !== false || original.consume_conflicting_final !== false) {
    fail6("INVALID_DISPOSITION", "source evidence does not retain the terminal incident state");
  }
  return parsePriorIncidentBinding({
    session_name: original.session_name,
    session_id: original.session_id,
    terminal_failure_retained: true,
    terminal_failure_supersedable: false,
    original_request_complete_written: false,
    original_create_response_retained: false,
    request_id_adopted: false,
    retry_allowed: false,
    consume_conflicting_final: false
  });
}
function parseAccountScope3(value) {
  const raw = record5(value, "account_scope");
  exactKeys4(raw, [
    "channel",
    "seller_account_fingerprint_sha256",
    "seller_id",
    "store_index"
  ], "account_scope");
  if (raw.channel !== "WALMART_US" || raw.store_index !== 1 || raw.seller_id !== "10001624309") {
    fail6("ACCOUNT_SCOPE_MISMATCH", "owner disposition account scope is invalid");
  }
  return {
    channel: "WALMART_US",
    store_index: 1,
    seller_id: "10001624309",
    seller_account_fingerprint_sha256: digest3(
      raw.seller_account_fingerprint_sha256,
      "account seller fingerprint"
    )
  };
}
function parseReplacement2(value) {
  const raw = record5(value, "replacement");
  exactKeys4(raw, [
    "create_request_correlation_id_sha256",
    "create_request_manifest",
    "create_request_manifest_sha256",
    "session_authority",
    "session_authority_sha256",
    "session_name"
  ], "replacement");
  const expected = buildWalmartItemReportReissueReplacementPlanV2({
    session_name: raw.session_name,
    session_authority: raw.session_authority
  });
  if (!exactJsonEqual2(raw, expected)) {
    fail6("INVALID_REPLACEMENT", "replacement preimages/hashes are inconsistent");
  }
  return expected;
}
function parseFixed(value, expected, label) {
  const raw = record5(value, label);
  exactKeys4(raw, Object.keys(expected), label);
  if (!exactJsonEqual2(raw, expected)) {
    fail6("INVALID_DISPOSITION", `${label} relaxes the fixed safety contract`);
  }
  return expected;
}
function parseSignedBody(value) {
  const raw = record5(value, "signed_body");
  exactKeys4(raw, [
    "account_scope",
    "action",
    "approved_by",
    "authorization",
    "consumption_ledger",
    "decision_ref",
    "disposition_id",
    "engine_release_sha256",
    "environment",
    "evidence_fresh_until",
    "expires_at",
    "issued_at",
    "owner_risk_acknowledgement",
    "prior_incident",
    "replacement",
    "source_evidence"
  ], "signed_body");
  if (raw.action !== WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_ACTION || !(/* @__PURE__ */ new Set(["PRODUCTION", "TEST_FIXTURE_ONLY"])).has(String(raw.environment))) {
    fail6("INVALID_DISPOSITION", "signed body action/environment is invalid");
  }
  const issuedAt = strictInstant6(raw.issued_at, "signed_body.issued_at");
  const expiresAt = strictInstant6(raw.expires_at, "signed_body.expires_at");
  const evidenceFreshUntil = strictInstant6(
    raw.evidence_fresh_until,
    "signed_body.evidence_fresh_until"
  );
  const sourceEvidence = parseSourceEvidenceBinding(raw.source_evidence);
  const priorIncident = parsePriorIncidentBinding(raw.prior_incident);
  if (Date.parse(expiresAt) <= Date.parse(issuedAt) || Date.parse(expiresAt) - Date.parse(issuedAt) > WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_MAX_TTL_MS || sourceEvidence.exact_probe_fresh_until !== evidenceFreshUntil || Date.parse(sourceEvidence.exact_probe_observed_at) > Date.parse(issuedAt)) {
    fail6("INVALID_FRESHNESS", "owner disposition TTL or historical evidence binding is invalid");
  }
  const replacement = parseReplacement2(raw.replacement);
  const accountScope = parseAccountScope3(raw.account_scope);
  if (!exactJsonEqual2(accountScope, {
    ...replacement.session_authority.account_scope,
    seller_id: "10001624309"
  })) {
    fail6("ACCOUNT_SCOPE_MISMATCH", "replacement SessionAuthority differs from signed account");
  }
  if (Date.parse(replacement.session_authority.created_at) > Date.parse(issuedAt)) {
    fail6("INVALID_FRESHNESS", "replacement SessionAuthority was created after owner issuance");
  }
  return {
    disposition_id: safeIdentifier4(raw.disposition_id, "disposition_id"),
    action: WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_ACTION,
    environment: raw.environment,
    approved_by: exactString6(raw.approved_by, "approved_by", 256),
    decision_ref: decisionReference2(raw.decision_ref),
    engine_release_sha256: digest3(raw.engine_release_sha256, "engine_release_sha256"),
    source_evidence: sourceEvidence,
    account_scope: accountScope,
    prior_incident: priorIncident,
    replacement,
    consumption_ledger: parseLedgerBinding(raw.consumption_ledger),
    issued_at: issuedAt,
    expires_at: expiresAt,
    evidence_fresh_until: evidenceFreshUntil,
    authorization: parseFixed(raw.authorization, fixedAuthorization2(), "authorization"),
    owner_risk_acknowledgement: parseFixed(
      raw.owner_risk_acknowledgement,
      fixedRiskAcknowledgement2(),
      "owner_risk_acknowledgement"
    )
  };
}
function buildWalmartItemReportReissueOwnerDispositionV2Body(input) {
  const artifactSha = digest3(
    input.expected_source_evidence_artifact_sha256,
    "expected source-evidence artifact SHA-256"
  );
  if (sha256Bytes4(input.source_evidence_bytes) !== artifactSha) {
    fail6("SOURCE_EVIDENCE_ARTIFACT_HASH_MISMATCH", "source-evidence exact bytes differ");
  }
  const evidence = parseWalmartItemReportReissueCurrentSourceEvidenceBytes(
    input.source_evidence_bytes
  );
  const sourceBinding = sourceEvidenceBinding(evidence, artifactSha);
  const sourceAccount = evidence.account_scope;
  const original = evidence.original_incident;
  const replacement = parseReplacement2(input.replacement);
  const accountScope = parseAccountScope3({
    channel: sourceAccount.channel,
    store_index: sourceAccount.store_index,
    seller_id: sourceAccount.seller_id,
    seller_account_fingerprint_sha256: sourceAccount.seller_account_fingerprint_sha256
  });
  if (!exactJsonEqual2(replacement.session_authority.account_scope, {
    channel: accountScope.channel,
    store_index: accountScope.store_index,
    seller_account_fingerprint_sha256: accountScope.seller_account_fingerprint_sha256
  }) || replacement.session_name === original.session_name || replacement.session_authority.session_id === original.session_id || replacement.session_authority_sha256 === original.session_authority_sha256 || replacement.create_request_manifest_sha256 === original.create_manifest_sha256) {
    fail6("INVALID_REPLACEMENT", "replacement is not distinct or account-bound");
  }
  const evidenceFreshUntil = evidence.exact_probe_fresh_until;
  const signedBody = {
    disposition_id: input.disposition_id,
    action: WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_ACTION,
    environment: input.environment,
    approved_by: input.approved_by,
    decision_ref: input.decision_ref,
    engine_release_sha256: input.engine_release_sha256,
    source_evidence: sourceBinding,
    account_scope: accountScope,
    prior_incident: priorIncidentBinding(evidence.baseline),
    replacement,
    consumption_ledger: input.consumption_ledger,
    issued_at: input.issued_at,
    expires_at: input.expires_at,
    evidence_fresh_until: evidenceFreshUntil,
    authorization: fixedAuthorization2(),
    owner_risk_acknowledgement: fixedRiskAcknowledgement2()
  };
  return parseSignedBody(signedBody);
}
function walmartItemReportReissueOwnerDispositionV2SigningMessage(envelope) {
  return Buffer.concat([
    SIGNING_DOMAIN,
    Buffer.from(canonicalWalmartItemReportJson(envelope), "utf8")
  ]);
}
function buildWalmartItemReportReissueOwnerDispositionV2SigningRequest(input) {
  const body = parseSignedBody(input.signed_body);
  const key = resolveTrustedKey(input.key_id, body.environment, input.env ?? process.env);
  const envelope = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_SCHEMA,
    algorithm: WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_ALGORITHM,
    key_id: key.key_id,
    owner_public_key_spki_sha256: key.public_key_spki_sha256,
    signed_body: body
  };
  return {
    ...envelope,
    signing_message_base64: walmartItemReportReissueOwnerDispositionV2SigningMessage(envelope).toString("base64"),
    signature_base64: "TODO_EXTERNAL_OWNER_ED25519_SIGNATURE_BASE64",
    signature_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE",
    authorization_sha256: "TODO_AFTER_EXTERNAL_SIGNATURE"
  };
}
function parseVerificationBindings(options) {
  if (!isRecord9(options)) {
    fail6("BINDING_REQUIRED", "production verification bindings are required");
  }
  const missing = [
    "expected_engine_release_sha256",
    "expected_source_evidence_bytes",
    "expected_source_evidence_artifact_sha256",
    "expected_replacement",
    "expected_consumption_ledger"
  ].filter((key) => options[key] === void 0);
  if (missing.length > 0) {
    fail6(
      "BINDING_REQUIRED",
      `production verification binding is missing: ${missing.join(", ")}`
    );
  }
  if (!(options.expected_source_evidence_bytes instanceof Uint8Array) || options.expected_source_evidence_bytes.byteLength === 0) {
    fail6("BINDING_REQUIRED", "expected source-evidence exact bytes are required");
  }
  const artifactSha = digest3(
    options.expected_source_evidence_artifact_sha256,
    "expected_source_evidence_artifact_sha256"
  );
  if (sha256Bytes4(options.expected_source_evidence_bytes) !== artifactSha) {
    fail6("SOURCE_EVIDENCE_ARTIFACT_HASH_MISMATCH", "expected source-evidence bytes differ");
  }
  const evidence = parseWalmartItemReportReissueCurrentSourceEvidenceBytes(
    options.expected_source_evidence_bytes
  );
  const sourceAccount = evidence.account_scope;
  const accountScope = parseAccountScope3({
    channel: sourceAccount.channel,
    store_index: sourceAccount.store_index,
    seller_id: sourceAccount.seller_id,
    seller_account_fingerprint_sha256: sourceAccount.seller_account_fingerprint_sha256
  });
  const environment = options.expected_environment ?? "PRODUCTION";
  if (!(/* @__PURE__ */ new Set(["PRODUCTION", "TEST_FIXTURE_ONLY"])).has(environment)) {
    fail6("INVALID_DISPOSITION", "expected environment is invalid");
  }
  return {
    env: options.env ?? process.env,
    environment,
    engine_release_sha256: digest3(
      options.expected_engine_release_sha256,
      "expected_engine_release_sha256"
    ),
    source_evidence: sourceEvidenceBinding(evidence, artifactSha),
    source_account_scope: accountScope,
    prior_incident: priorIncidentBinding(evidence.baseline),
    original_incident: evidence.original_incident,
    replacement: parseReplacement2(options.expected_replacement),
    consumption_ledger: parseLedgerBinding(options.expected_consumption_ledger),
    now: options.now
  };
}
function assertReplacementBoundToSourceEvidence(replacement, accountScope, original) {
  if (!exactJsonEqual2(replacement.session_authority.account_scope, {
    channel: accountScope.channel,
    store_index: accountScope.store_index,
    seller_account_fingerprint_sha256: accountScope.seller_account_fingerprint_sha256
  }) || replacement.session_name === original.session_name || replacement.session_authority.session_id === original.session_id || replacement.session_authority_sha256 === original.session_authority_sha256 || replacement.create_request_manifest_sha256 === original.create_manifest_sha256) {
    fail6("BINDING_MISMATCH", "replacement is not distinct from and bound to source evidence");
  }
}
function delegatedAuthorizationPreimage(body, bodySha256) {
  return {
    schema_version: WALMART_ITEM_REPORT_REISSUE_DELEGATED_AUTHORIZATION_V1_SCHEMA,
    authorization_mode: WALMART_ITEM_REPORT_REISSUE_DELEGATED_AUTHORIZATION_V1_MODE,
    signed_body: body,
    body_sha256: bodySha256
  };
}
function buildWalmartItemReportReissueDelegatedAuthorizationV1(input) {
  const body = buildWalmartItemReportReissueOwnerDispositionV2Body({
    ...input,
    environment: input.environment ?? "PRODUCTION"
  });
  const bodySha256 = sha256Bytes4(canonicalWalmartItemReportJson(body));
  const preimage = delegatedAuthorizationPreimage(body, bodySha256);
  return {
    ...preimage,
    authorization_sha256: sha256Bytes4(canonicalWalmartItemReportJson(preimage))
  };
}
function verifyWalmartItemReportReissueDelegatedAuthorizationV1(value, options) {
  const expected = parseVerificationBindings({
    ...options,
    expected_environment: options.expected_environment ?? "PRODUCTION"
  });
  const raw = record5(value, "delegated authorization");
  exactKeys4(raw, [
    "authorization_mode",
    "authorization_sha256",
    "body_sha256",
    "schema_version",
    "signed_body"
  ], "delegated authorization");
  if (raw.schema_version !== WALMART_ITEM_REPORT_REISSUE_DELEGATED_AUTHORIZATION_V1_SCHEMA || raw.authorization_mode !== WALMART_ITEM_REPORT_REISSUE_DELEGATED_AUTHORIZATION_V1_MODE) {
    fail6("INVALID_DELEGATED_AUTHORIZATION", "delegated authorization schema/mode is invalid");
  }
  const suppliedBody = record5(raw.signed_body, "delegated authorization signed_body");
  const expectedBody = buildWalmartItemReportReissueOwnerDispositionV2Body({
    disposition_id: exactString6(
      suppliedBody.disposition_id,
      "delegated authorization disposition_id",
      200
    ),
    environment: expected.environment,
    approved_by: exactString6(
      suppliedBody.approved_by,
      "delegated authorization approved_by",
      256
    ),
    decision_ref: decisionReference2(suppliedBody.decision_ref),
    engine_release_sha256: expected.engine_release_sha256,
    source_evidence_bytes: options.expected_source_evidence_bytes,
    expected_source_evidence_artifact_sha256: options.expected_source_evidence_artifact_sha256,
    replacement: expected.replacement,
    consumption_ledger: expected.consumption_ledger,
    issued_at: strictInstant6(
      suppliedBody.issued_at,
      "delegated authorization issued_at"
    ),
    expires_at: strictInstant6(
      suppliedBody.expires_at,
      "delegated authorization expires_at"
    )
  });
  if (!exactJsonEqual2(suppliedBody, expectedBody)) {
    fail6(
      "BINDING_MISMATCH",
      "delegated authorization body differs from exact source/execution bindings"
    );
  }
  const bodySha256 = digest3(raw.body_sha256, "delegated authorization body_sha256");
  if (bodySha256 !== sha256Bytes4(canonicalWalmartItemReportJson(expectedBody))) {
    fail6("AUTHORIZATION_HASH_MISMATCH", "delegated authorization body hash is invalid");
  }
  const preimage = delegatedAuthorizationPreimage(expectedBody, bodySha256);
  const authorizationSha256 = digest3(
    raw.authorization_sha256,
    "delegated authorization authorization_sha256"
  );
  if (authorizationSha256 !== sha256Bytes4(canonicalWalmartItemReportJson(preimage))) {
    fail6("AUTHORIZATION_HASH_MISMATCH", "delegated authorization envelope hash is invalid");
  }
  assertReplacementBoundToSourceEvidence(
    expectedBody.replacement,
    expected.source_account_scope,
    expected.original_incident
  );
  const parsed = {
    ...preimage,
    authorization_sha256: authorizationSha256
  };
  if (expected.now !== void 0) {
    assertWalmartItemReportReissueAuthorizationCurrent(parsed, expected.now);
  }
  return parsed;
}
function verifyWalmartItemReportReissueOwnerDispositionV2(value, options) {
  const expected = parseVerificationBindings(options);
  const raw = record5(value, "owner disposition");
  exactKeys4(raw, [
    "algorithm",
    "authorization_sha256",
    "key_id",
    "owner_public_key_spki_sha256",
    "schema_version",
    "signature_base64",
    "signature_sha256",
    "signed_body"
  ], "owner disposition");
  const body = parseSignedBody(raw.signed_body);
  const environment = expected.environment;
  if (body.environment !== environment || raw.schema_version !== WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_SCHEMA || raw.algorithm !== WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_ALGORITHM) {
    fail6("INVALID_DISPOSITION", "owner disposition schema/action domain is invalid");
  }
  const keyId = safeIdentifier4(raw.key_id, "owner disposition key_id");
  const key = resolveTrustedKey(keyId, environment, expected.env);
  const ownerFingerprint = digest3(
    raw.owner_public_key_spki_sha256,
    "owner_public_key_spki_sha256"
  );
  if (ownerFingerprint !== key.public_key_spki_sha256) {
    fail6("OWNER_KEY_UNTRUSTED_OR_REVOKED", "owner disposition fingerprint is not pinned");
  }
  const signature = canonicalBase642(raw.signature_base64, "signature_base64", 256);
  const signatureSha = digest3(raw.signature_sha256, "signature_sha256");
  if (signature.bytes.byteLength !== 64 || signatureSha !== sha256Bytes4(signature.bytes)) {
    fail6("INVALID_SIGNATURE", "owner signature bytes/hash are invalid");
  }
  const envelope = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_SCHEMA,
    algorithm: WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_ALGORITHM,
    key_id: key.key_id,
    owner_public_key_spki_sha256: key.public_key_spki_sha256,
    signed_body: body
  };
  const publicKey = createPublicKey2({
    key: Buffer.from(key.public_key_spki_der_base64, "base64"),
    format: "der",
    type: "spki"
  });
  if (!verifySignature(
    null,
    walmartItemReportReissueOwnerDispositionV2SigningMessage(envelope),
    publicKey,
    signature.bytes
  )) {
    fail6("INVALID_SIGNATURE", "owner Ed25519 signature is invalid");
  }
  const unsigned = {
    ...envelope,
    signature_base64: signature.value,
    signature_sha256: signatureSha
  };
  const authorizationSha = digest3(raw.authorization_sha256, "authorization_sha256");
  if (authorizationSha !== sha256Bytes4(canonicalWalmartItemReportJson(unsigned))) {
    fail6("AUTHORIZATION_HASH_MISMATCH", "owner authorization hash is invalid");
  }
  if (body.engine_release_sha256 !== expected.engine_release_sha256) {
    fail6("BINDING_MISMATCH", "owner disposition is bound to a different engine release");
  }
  if (!exactJsonEqual2(body.source_evidence, expected.source_evidence) || !exactJsonEqual2(body.prior_incident, expected.prior_incident) || !exactJsonEqual2(body.account_scope, expected.source_account_scope) || body.evidence_fresh_until !== expected.source_evidence.exact_probe_fresh_until) {
    fail6(
      "BINDING_MISMATCH",
      "owner disposition source/prior/account binding differs from exact evidence bytes"
    );
  }
  if (!exactJsonEqual2(body.replacement, expected.replacement)) {
    fail6("BINDING_MISMATCH", "owner disposition is bound to a different replacement");
  }
  if (!exactJsonEqual2(body.consumption_ledger, expected.consumption_ledger)) {
    fail6("BINDING_MISMATCH", "owner disposition is bound to a different ledger");
  }
  assertReplacementBoundToSourceEvidence(
    body.replacement,
    expected.source_account_scope,
    expected.original_incident
  );
  const parsed = {
    ...unsigned,
    authorization_sha256: authorizationSha
  };
  if (expected.now !== void 0) {
    assertWalmartItemReportReissueOwnerDispositionV2Current(parsed, expected.now);
  }
  return parsed;
}
function assembleWalmartItemReportReissueOwnerDispositionV2(input) {
  if (!(input.detached_signature instanceof Uint8Array) || input.detached_signature.byteLength !== 64) {
    fail6("INVALID_SIGNATURE", "detached Ed25519 signature must contain exactly 64 raw bytes");
  }
  const request = input.signing_request;
  const envelope = {
    schema_version: request.schema_version,
    algorithm: request.algorithm,
    key_id: request.key_id,
    owner_public_key_spki_sha256: request.owner_public_key_spki_sha256,
    signed_body: request.signed_body
  };
  if (request.signing_message_base64 !== walmartItemReportReissueOwnerDispositionV2SigningMessage(envelope).toString("base64")) {
    fail6("INVALID_SIGNING_REQUEST", "signing request message does not bind its envelope");
  }
  const signatureBase64 = Buffer.from(input.detached_signature).toString("base64");
  const signatureSha256 = sha256Bytes4(input.detached_signature);
  const unsigned = { ...envelope, signature_base64: signatureBase64, signature_sha256: signatureSha256 };
  return verifyWalmartItemReportReissueOwnerDispositionV2({
    ...unsigned,
    authorization_sha256: sha256Bytes4(canonicalWalmartItemReportJson(unsigned))
  }, {
    env: input.env,
    expected_environment: request.signed_body.environment,
    expected_engine_release_sha256: input.expected_engine_release_sha256,
    expected_source_evidence_bytes: input.expected_source_evidence_bytes,
    expected_source_evidence_artifact_sha256: input.expected_source_evidence_artifact_sha256,
    expected_replacement: input.expected_replacement,
    expected_consumption_ledger: input.expected_consumption_ledger,
    now: input.now
  });
}
function assertWalmartItemReportReissueOwnerDispositionV2Current(disposition, now = /* @__PURE__ */ new Date()) {
  return assertWalmartItemReportReissueAuthorizationCurrent(disposition, now);
}
function assertWalmartItemReportReissueAuthorizationCurrent(authorization, now = /* @__PURE__ */ new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail6("INVALID_CLOCK", "authorization clock is invalid");
  }
  const issuedAt = Date.parse(authorization.signed_body.issued_at);
  const effectiveDeadline = Math.min(
    Date.parse(authorization.signed_body.expires_at)
  );
  if (issuedAt > now.getTime() + WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_CLOCK_SKEW_MS || now.getTime() < issuedAt - WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_CLOCK_SKEW_MS) {
    fail6("AUTHORIZATION_NOT_CURRENT", "authorization issuance window has not opened");
  }
  if (now.getTime() >= effectiveDeadline) {
    fail6("AUTHORIZATION_EXPIRED", "authorization has expired");
  }
  return new Date(effectiveDeadline).toISOString();
}
var WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_EMPTY_BODY_SHA256 = EMPTY_BODY_SHA256;

// src/lib/walmart/item-report-capture-session.ts
import { createHash as createHash11, randomUUID as randomUUID2 } from "node:crypto";
import { constants as fsConstants3 } from "node:fs";
import {
  lstat as lstat3,
  mkdir as mkdir2,
  open as open3,
  readdir as readdir3,
  readFile,
  realpath as realpath3
} from "node:fs/promises";
import path3 from "node:path";
var WALMART_ITEM_REPORT_CAPTURE_SESSION_SCHEMA = "walmart-item-report-capture-session/v1";
var WALMART_ITEM_REPORT_CAPTURE_CHECKPOINT_SCHEMA = "walmart-item-report-capture-checkpoint/v1";
var WALMART_ITEM_REPORT_CAPTURE_PHASES = [
  "request",
  "poll",
  "download",
  "compile"
];
var DIRECTORY_MODE = 448;
var FILE_MODE = 384;
var CHANNEL2 = "WALMART_US";
var CREATE_BODY = new TextEncoder().encode("{}");
var REDIRECT_STATUSES = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
var WALMART_ITEM_REPORT_CAPTURE_MAX_REQUEST_TIMEOUT_MS = 6e4;
var WALMART_ITEM_REPORT_CAPTURE_DEFAULT_REQUEST_TIMEOUT_MS = 6e4;
var WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES = 64 * 1024;
var WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_CHAIN_BYTES = 256 * 1024;
var SESSION_FILE = "trusted/00-session-authority.json";
var OWNER_REISSUE_PERMIT_FILE = "trusted/01-owner-reissue-permit.json";
var REQUEST_RESERVED = "checkpoints/10-request-reserved.json";
var REQUEST_COMPLETE = "checkpoints/19-request-complete.json";
var REQUEST_MANUAL_REVIEW = "checkpoints/19-request-manual-review.json";
var CREATE_MANIFEST = "capture/10-create-request-manifest.json";
var CREATE_RESPONSE = "capture/11-create-response.bin";
var CREATE_HTTP = "capture/12-create-response-http.json";
var CREATE_SEAL = "trusted/13-create-exchange-seal.json";
var READY_SELECTION = "trusted/29-ready-selection.json";
var FILE_SELECTION = "trusted/49-file-selection.json";
var COMPILE_CONTEXT = "trusted/90-compile-context.json";
var SANITIZED_SOURCE = "sanitized/90-item-report-published-source.json";
var SANITIZED_CATALOG_SOURCE = "sanitized/item-report-catalog-source.json";
var COMPILE_COMPLETE = "checkpoints/99-compile-complete.json";
var WalmartItemReportCaptureError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WalmartItemReportCaptureError";
    this.code = code;
  }
};
var WalmartItemReportManualReviewRequiredError = class extends WalmartItemReportCaptureError {
  constructor(message = "request outcome is ambiguous; manual review is required and POST retry is forbidden") {
    super("MANUAL_REVIEW_REQUIRED", message);
    this.name = "WalmartItemReportManualReviewRequiredError";
  }
};
function exactString7(value, label) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new WalmartItemReportCaptureError("INVALID_INPUT", `${label} must be a non-empty trimmed string`);
  }
  if (/[\x00-\x1f\x7f]/u.test(value)) {
    throw new WalmartItemReportCaptureError("INVALID_INPUT", `${label} contains control characters`);
  }
  return value;
}
function positiveInteger5(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new WalmartItemReportCaptureError("INVALID_INPUT", `${label} must be a positive safe integer`);
  }
  return Number(value);
}
function requestTimeoutMs(dependencies) {
  const value = dependencies.request_timeout_ms ?? WALMART_ITEM_REPORT_CAPTURE_DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > WALMART_ITEM_REPORT_CAPTURE_MAX_REQUEST_TIMEOUT_MS) {
    throw new WalmartItemReportCaptureError(
      "INVALID_REQUEST_TIMEOUT",
      `request timeout must be an integer from 1 to ${WALMART_ITEM_REPORT_CAPTURE_MAX_REQUEST_TIMEOUT_MS} ms`
    );
  }
  return value;
}
function httpCallCounts(walmartApiCalls, presignedFileCalls, oauthTokenCalls = 0) {
  for (const [label, value] of Object.entries({ walmartApiCalls, presignedFileCalls, oauthTokenCalls })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WalmartItemReportCaptureError("INVALID_HTTP_ACCOUNTING", `${label} is invalid`);
    }
  }
  return {
    oauth_token_calls: oauthTokenCalls,
    walmart_api_calls: walmartApiCalls,
    presigned_file_calls: presignedFileCalls,
    total_http_calls: oauthTokenCalls + walmartApiCalls + presignedFileCalls
  };
}
async function sendWithDeadline(dependencies, request) {
  const timeoutMs = requestTimeoutMs(dependencies);
  const controller = new AbortController();
  let timeoutHandle;
  const timeout = new Promise((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new WalmartItemReportCaptureError("REQUEST_TIMEOUT", "capture HTTP attempt exceeded its deadline"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      dependencies.transport.send({
        ...request,
        signal: controller.signal,
        timeout_ms: timeoutMs
      }),
      timeout
    ]);
  } finally {
    if (timeoutHandle !== void 0) clearTimeout(timeoutHandle);
  }
}
function isoNow(dependencies) {
  return captureNow(dependencies).toISOString();
}
function jsonBytes(value) {
  return new TextEncoder().encode(canonicalWalmartItemReportJson(value));
}
function exactBytesSha256(bytes) {
  return createHash11("sha256").update(bytes).digest("hex");
}
function parseJsonBytes2(bytes, label) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new WalmartItemReportCaptureError("INVALID_CAPTURE_JSON", `${label} is not valid UTF-8 JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WalmartItemReportCaptureError("INVALID_CAPTURE_JSON", `${label} must contain a JSON object`);
  }
  return value;
}
function safeRelativePath(relativePath) {
  const parts = relativePath.split("/");
  if (path3.isAbsolute(relativePath) || relativePath.includes("\\") || parts.length !== 2 || !["capture", "trusted", "checkpoints", "sanitized"].includes(parts[0]) || parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new WalmartItemReportCaptureError("UNSAFE_PATH", "capture artifact path is unsafe");
  }
  return relativePath;
}
async function assertPrivateRealDirectory2(directory, code = "UNSAFE_SESSION_DIRECTORY") {
  const stat = await lstat3(directory).catch((error) => {
    if (error.code === "ENOENT") {
      throw new WalmartItemReportCaptureError(code, "required private directory is missing");
    }
    throw error;
  });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 63) !== 0) {
    throw new WalmartItemReportCaptureError(code, "capture directories must be private real directories");
  }
  const canonical = await realpath3(directory);
  if (canonical !== directory) {
    throw new WalmartItemReportCaptureError(code, "capture directory canonical path is inconsistent");
  }
}
async function artifactAbsolutePath(sessionDir, relativePathInput) {
  const relativePath = safeRelativePath(relativePathInput);
  const parent = path3.join(sessionDir, path3.dirname(relativePath));
  await assertPrivateRealDirectory2(parent, "UNSAFE_ARTIFACT_PARENT");
  const absolute = path3.join(sessionDir, relativePath);
  if (path3.dirname(absolute) !== parent) {
    throw new WalmartItemReportCaptureError("UNSAFE_PATH", "capture artifact escaped its private parent");
  }
  return absolute;
}
async function fsyncDirectory2(directory) {
  const handle = await open3(directory, fsConstants3.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function writeImmutable(sessionDir, relativePathInput, bytes, dependencies) {
  const relativePath = safeRelativePath(relativePathInput);
  if (!(bytes instanceof Uint8Array)) {
    throw new WalmartItemReportCaptureError("INVALID_ARTIFACT", `${relativePath} must be bytes`);
  }
  const absolute = await artifactAbsolutePath(sessionDir, relativePath);
  const handle = await open3(absolute, "wx", FILE_MODE).catch(async (error) => {
    if (error.code === "EEXIST") {
      const stat = await lstat3(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 63) !== 0 || stat.size !== bytes.byteLength) {
        throw new WalmartItemReportCaptureError(
          "IMMUTABLE_ARTIFACT_CONFLICT",
          `${relativePath} exists but is not the exact retained artifact`
        );
      }
      const existing = new Uint8Array(await readFile(absolute));
      if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
        throw new WalmartItemReportCaptureError(
          "IMMUTABLE_ARTIFACT_CONFLICT",
          `${relativePath} exists with different bytes`
        );
      }
      return null;
    }
    throw error;
  });
  if (handle === null) return;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory2(path3.dirname(absolute));
  await dependencies.after_immutable_write?.(relativePath);
}
async function writeImmutableJson(sessionDir, relativePath, value, dependencies) {
  await writeImmutable(sessionDir, relativePath, jsonBytes(value), dependencies);
}
async function writeExclusiveReservationJson(sessionDir, relativePathInput, value, dependencies) {
  const relativePath = safeRelativePath(relativePathInput);
  const bytes = jsonBytes(value);
  const absolute = await artifactAbsolutePath(sessionDir, relativePath);
  const handle = await open3(absolute, "wx", FILE_MODE).catch((error) => {
    if (error.code === "EEXIST") {
      throw new WalmartItemReportCaptureError(
        "REQUEST_ATTEMPT_ALREADY_RESERVED",
        "the one-shot report-create attempt was already reserved"
      );
    }
    throw error;
  });
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory2(path3.dirname(absolute));
  await dependencies.after_immutable_write?.(relativePath);
}
async function fileExists(sessionDir, relativePath) {
  try {
    const stat = await lstat3(await artifactAbsolutePath(sessionDir, relativePath));
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function readImmutable(sessionDir, relativePath, maximumBytes) {
  const absolute = await artifactAbsolutePath(sessionDir, relativePath);
  const stat = await lstat3(absolute).catch((error) => {
    if (error.code === "ENOENT") {
      throw new WalmartItemReportCaptureError("MISSING_ARTIFACT", `${relativePath} is missing`);
    }
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new WalmartItemReportCaptureError("UNSAFE_ARTIFACT", `${relativePath} must be a regular non-symlink file`);
  }
  if ((stat.mode & 63) !== 0) {
    throw new WalmartItemReportCaptureError("UNSAFE_ARTIFACT_MODE", `${relativePath} must not be group/world accessible`);
  }
  if (stat.size < 1 || stat.size > maximumBytes) {
    throw new WalmartItemReportCaptureError("ARTIFACT_SIZE_CAP", `${relativePath} exceeds its safety cap`);
  }
  return new Uint8Array(await readFile(absolute));
}
async function readImmutableJson(sessionDir, relativePath, maximumBytes = 1024 * 1024) {
  return parseJsonBytes2(await readImmutable(sessionDir, relativePath, maximumBytes), relativePath);
}
function normalizeDocumentedMacSystemAlias(absolutePath) {
  if (process.platform !== "darwin") return absolutePath;
  for (const [alias, canonical] of [["/var", "/private/var"], ["/tmp", "/private/tmp"]]) {
    if (absolutePath === alias || absolutePath.startsWith(`${alias}/`)) {
      return `${canonical}${absolutePath.slice(alias.length)}`;
    }
  }
  return absolutePath;
}
async function assertNoSymlinkDirectoryComponents(absolutePath, allowMissing) {
  const parsed = path3.parse(absolutePath);
  let current = parsed.root;
  for (const component of absolutePath.slice(parsed.root.length).split(path3.sep).filter(Boolean)) {
    current = path3.join(current, component);
    const stat = await lstat3(current).catch((error) => {
      if (error.code === "ENOENT" && allowMissing) return null;
      throw error;
    });
    if (stat === null) return false;
    if (stat.isSymbolicLink()) {
      throw new WalmartItemReportCaptureError(
        "UNSAFE_CAPTURE_ROOT",
        "configured capture root contains a symlink component"
      );
    }
    if (!stat.isDirectory()) {
      throw new WalmartItemReportCaptureError(
        "UNSAFE_CAPTURE_ROOT",
        "configured capture root components must be directories"
      );
    }
  }
  return true;
}
async function assertWalmartItemReportCaptureSessionDir(allowedRootInput, sessionDirInput, create) {
  const allowedRoot = normalizeDocumentedMacSystemAlias(
    path3.resolve(exactString7(allowedRootInput, "allowed_capture_root"))
  );
  const rootExists = await assertNoSymlinkDirectoryComponents(allowedRoot, true);
  if (!rootExists) {
    if (!create) {
      throw new WalmartItemReportCaptureError("MISSING_SESSION", "configured capture root does not exist");
    }
    await mkdir2(allowedRoot, { recursive: true, mode: DIRECTORY_MODE });
  }
  await assertNoSymlinkDirectoryComponents(allowedRoot, false);
  const allowedRootReal = await realpath3(allowedRoot);
  if (allowedRootReal !== allowedRoot) {
    throw new WalmartItemReportCaptureError(
      "UNSAFE_CAPTURE_ROOT",
      "configured capture root canonical path differs from its approved lexical path"
    );
  }
  await assertPrivateRealDirectory2(allowedRootReal, "UNSAFE_CAPTURE_ROOT");
  const requestedSessionDir = normalizeDocumentedMacSystemAlias(
    path3.resolve(exactString7(sessionDirInput, "session_dir"))
  );
  const sessionName = path3.basename(requestedSessionDir);
  if (path3.dirname(requestedSessionDir) !== allowedRootReal || sessionName.length === 0 || sessionName === ".") {
    throw new WalmartItemReportCaptureError(
      "SESSION_DIR_OUTSIDE_GITIGNORED_ROOT",
      "session_dir must be a direct child of the configured gitignored capture root"
    );
  }
  const sessionDir = path3.join(allowedRootReal, sessionName);
  let sessionCreated = false;
  let sessionStat = await lstat3(sessionDir).catch((error) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (sessionStat?.isSymbolicLink()) {
    throw new WalmartItemReportCaptureError("UNSAFE_SESSION_DIRECTORY", "session_dir must not be a symlink");
  }
  if (sessionStat === null) {
    if (!create) {
      throw new WalmartItemReportCaptureError("MISSING_SESSION", "capture session does not exist");
    }
    await mkdir2(sessionDir, { mode: DIRECTORY_MODE });
    sessionCreated = true;
    sessionStat = await lstat3(sessionDir);
  }
  if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink() || (sessionStat.mode & 63) !== 0) {
    throw new WalmartItemReportCaptureError(
      "UNSAFE_SESSION_DIRECTORY",
      "session_dir must be a private real directory"
    );
  }
  if (await realpath3(sessionDir) !== sessionDir) {
    throw new WalmartItemReportCaptureError(
      "UNSAFE_SESSION_DIRECTORY",
      "session_dir canonical path escaped its configured capture root"
    );
  }
  for (const child of ["capture", "trusted", "checkpoints", "sanitized"]) {
    const childPath = path3.join(sessionDir, child);
    if (sessionCreated) {
      await mkdir2(childPath, { mode: DIRECTORY_MODE });
    }
    await assertPrivateRealDirectory2(childPath);
  }
  return { allowedRoot: allowedRootReal, sessionDir, created: sessionCreated };
}
function computeWalmartSellerAccountFingerprint(input) {
  return walmartItemReportUtf8Sha256(canonicalWalmartItemReportJson({
    channel: CHANNEL2,
    store_index: positiveInteger5(input.store_index, "store_index"),
    client_id: exactString7(input.client_id, "client_id"),
    seller_id: exactString7(input.seller_id, "seller_id")
  }));
}
function planWalmartItemReportCapturePhase(input) {
  if (!WALMART_ITEM_REPORT_CAPTURE_PHASES.includes(input.phase)) {
    throw new WalmartItemReportCaptureError("INVALID_PHASE", "phase is invalid");
  }
  return {
    mode: "PLAN",
    network_calls: 0,
    filesystem_writes: 0,
    phase: input.phase,
    store_index: positiveInteger5(input.store_index, "store_index"),
    session_dir: path3.resolve(exactString7(input.session_dir, "session_dir")),
    live_requires: "--execute",
    http_calls: httpCallCounts(0, 0)
  };
}
function binding(authority, correlation) {
  return {
    account_scope: { ...authority.account_scope },
    request_correlation_id_sha256: correlation.sha256
  };
}
function assertRequestPermitHasPostWindow(verifiedPermit, dependencies) {
  const now = captureNow(dependencies).getTime();
  const freshness = verifiedPermit.permit.body.freshness;
  const issuedAt = Date.parse(freshness.issued_at);
  const freshnessEnd = Math.min(
    Date.parse(freshness.expires_at),
    Date.parse(freshness.prior_evidence_fresh_until)
  );
  const requiredHeadroomMs = requestTimeoutMs(dependencies) + 5e3;
  if (issuedAt > now + WALMART_ITEM_REPORT_REISSUE_CLOCK_SKEW_MS || freshnessEnd - now < requiredHeadroomMs || requiredHeadroomMs > WALMART_ITEM_REPORT_REISSUE_MAX_PERMIT_TTL_MS) {
    throw new WalmartItemReportCaptureError(
      "OWNER_REISSUE_PERMIT_INSUFFICIENT_HEADROOM",
      "owner reissue permit is not current or lacks POST timeout headroom"
    );
  }
}
function captureNow(dependencies) {
  const date = (dependencies.now ?? (() => /* @__PURE__ */ new Date()))();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new WalmartItemReportCaptureError("INVALID_CLOCK", "capture clock returned an invalid Date");
  }
  return date;
}
function verifyRequestPermitBeforeWrite(input, activeScope, dependencies) {
  const supplied = input.owner_reissue_permit;
  if (!supplied) {
    throw new WalmartItemReportCaptureError(
      "MISSING_OWNER_REISSUE_PERMIT",
      "live request phase requires one exact externally owner-custodied reissue permit"
    );
  }
  if (!(supplied.artifact_bytes instanceof Uint8Array)) {
    throw new WalmartItemReportCaptureError(
      "INVALID_OWNER_REISSUE_PERMIT",
      "owner reissue permit artifact must be exact bytes"
    );
  }
  const now = captureNow(dependencies);
  let parsed;
  try {
    const embedded = parseWalmartItemReportReissuePermitBytes(supplied.artifact_bytes);
    const preliminary = verifyWalmartItemReportReissuePermitBytes(
      supplied.artifact_bytes,
      {
        expected_artifact_sha256: supplied.expected_artifact_sha256,
        expected_permit_sha256: supplied.expected_permit_sha256,
        expected_source_evidence_release_sha256: supplied.expected_source_evidence_release_sha256,
        now,
        account_scope: activeScope,
        prior_absence_only: supplied.prior_absence_only,
        replacement_session_name: path3.basename(path3.resolve(input.session_dir)),
        replacement_session_authority: embedded.body.replacement.session_authority,
        replacement_create_request_manifest: embedded.body.replacement.create_request_manifest
      }
    );
    assertWalmartItemReportReissueOwnerConfirmation(
      preliminary,
      supplied.owner_confirmation
    );
    parsed = preliminary;
  } catch (error) {
    const code = error instanceof WalmartItemReportReissuePermitError ? error.code : "INVALID_OWNER_REISSUE_PERMIT";
    throw new WalmartItemReportCaptureError(
      code,
      error instanceof Error ? error.message : "owner reissue permit is invalid"
    );
  }
  const replacement = parsed.body.replacement;
  const verified = {
    permit: parsed,
    artifact_bytes: Uint8Array.from(supplied.artifact_bytes),
    authority: replacement.session_authority,
    create_manifest_bytes: jsonBytes(replacement.create_request_manifest)
  };
  assertRequestPermitHasPostWindow(verified, dependencies);
  return verified;
}
function newCorrelation(randomUuid) {
  const id = exactString7(randomUuid(), "request correlation ID");
  return { id, sha256: walmartItemReportUtf8Sha256(id) };
}
function activeAccountScope(storeIndex, dependencies) {
  if (!dependencies.account_scope || typeof dependencies.account_scope !== "object") {
    throw new WalmartItemReportCaptureError(
      "MISSING_CREDENTIAL_SCOPE",
      "network-capable capture phases require account_scope derived from active credentials"
    );
  }
  const raw = dependencies.account_scope;
  const expectedKeys = ["channel", "seller_account_fingerprint_sha256", "store_index"];
  if (Object.keys(raw).sort().join("\0") !== expectedKeys.join("\0") || raw.channel !== CHANNEL2 || raw.store_index !== storeIndex || typeof raw.seller_account_fingerprint_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.seller_account_fingerprint_sha256)) {
    throw new WalmartItemReportCaptureError("INVALID_CREDENTIAL_SCOPE", "active account_scope is invalid");
  }
  return {
    channel: CHANNEL2,
    store_index: storeIndex,
    seller_account_fingerprint_sha256: raw.seller_account_fingerprint_sha256
  };
}
function assertActiveAuthorityMatch(authority, active) {
  if (canonicalWalmartItemReportJson(authority.account_scope) !== canonicalWalmartItemReportJson(active)) {
    throw new WalmartItemReportCaptureError(
      "ACTIVE_ACCOUNT_SCOPE_MISMATCH",
      "active credential scope does not match the retained SessionAuthority"
    );
  }
}
async function initializeSessionFromPermit(sessionDir, verifiedPermit, dependencies) {
  const authority = verifiedPermit.authority;
  await writeImmutableJson(sessionDir, SESSION_FILE, authority, dependencies);
  return authority;
}
function parseStoredCorrelation(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WalmartItemReportCaptureError("INVALID_SESSION", `${label} is invalid`);
  }
  const raw = value;
  const id = exactString7(raw.id, `${label}.id`);
  const sha2567 = exactString7(raw.sha256, `${label}.sha256`);
  if (!/^[a-f0-9]{64}$/u.test(sha2567) || sha2567 !== walmartItemReportUtf8Sha256(id)) {
    throw new WalmartItemReportCaptureError("INVALID_SESSION", `${label} digest is invalid`);
  }
  return { id, sha256: sha2567 };
}
async function loadSession(sessionDir, storeIndex) {
  const raw = await readImmutableJson(sessionDir, SESSION_FILE);
  if (raw.schema_version !== WALMART_ITEM_REPORT_CAPTURE_SESSION_SCHEMA) {
    throw new WalmartItemReportCaptureError("INVALID_SESSION", "session schema is invalid");
  }
  const account = raw.account_scope;
  if (!account || account.channel !== CHANNEL2 || account.store_index !== storeIndex || typeof account.seller_account_fingerprint_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(account.seller_account_fingerprint_sha256)) {
    throw new WalmartItemReportCaptureError("INVALID_SESSION", "session account scope is invalid or mismatched");
  }
  const correlations = raw.primary_correlations;
  if (!correlations) throw new WalmartItemReportCaptureError("INVALID_SESSION", "session correlations are missing");
  const authority = {
    schema_version: WALMART_ITEM_REPORT_CAPTURE_SESSION_SCHEMA,
    session_id: exactString7(raw.session_id, "session_id"),
    created_at: exactString7(raw.created_at, "created_at"),
    account_scope: {
      channel: CHANNEL2,
      store_index: storeIndex,
      seller_account_fingerprint_sha256: account.seller_account_fingerprint_sha256
    },
    primary_correlations: {
      create: parseStoredCorrelation(correlations.create, "create correlation"),
      ready_status: parseStoredCorrelation(correlations.ready_status, "ready correlation"),
      download_locator: parseStoredCorrelation(correlations.download_locator, "locator correlation"),
      report_file: parseStoredCorrelation(correlations.report_file, "file correlation")
    },
    trust_statement: {
      adapter_atomic_integrity: true,
      walmart_signature_claimed: false,
      tls_server_authenticity_claimed_by_artifact: false
    }
  };
  if (new Set(Object.values(authority.primary_correlations).map((item) => item.sha256)).size !== 4) {
    throw new WalmartItemReportCaptureError("INVALID_SESSION", "session correlations are not distinct");
  }
  return authority;
}
function headerValues(headers, names) {
  const accepted = new Set(names.map((name) => name.toLowerCase()));
  return Object.entries(headers).filter(([name]) => accepted.has(name.toLowerCase())).map(([, value]) => exactString7(value, "HTTP response header"));
}
function optionalUnambiguousHeader(headers, names, label) {
  const values = headerValues(headers, names);
  if (new Set(values).size > 1) {
    throw new WalmartItemReportCaptureError("CONFLICTING_HTTP_HEADER", `${label} response headers conflict`);
  }
  return values[0] ?? null;
}
function validateAtomicResponse(response, maximumBytes, expectedCorrelation) {
  if (!response || !Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new WalmartItemReportCaptureError("INVALID_HTTP_RESPONSE", "transport returned an invalid HTTP status");
  }
  if (!(response.body instanceof Uint8Array) || response.body.byteLength > maximumBytes) {
    throw new WalmartItemReportCaptureError("RESPONSE_SIZE_CAP", "HTTP response body exceeds its phase safety cap");
  }
  if (!response.headers || typeof response.headers !== "object" || Array.isArray(response.headers)) {
    throw new WalmartItemReportCaptureError("INVALID_HTTP_RESPONSE", "transport returned invalid HTTP headers");
  }
  const contentEncoding = optionalUnambiguousHeader(
    response.headers,
    ["content-encoding"],
    "Content-Encoding"
  );
  if (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity") {
    throw new WalmartItemReportCaptureError(
      "UNSUPPORTED_CONTENT_ENCODING",
      "non-identity HTTP Content-Encoding is forbidden because exact wire bytes cannot be proven"
    );
  }
  const rawLength = optionalUnambiguousHeader(response.headers, ["content-length"], "Content-Length");
  let contentLength = null;
  if (rawLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(rawLength)) {
      throw new WalmartItemReportCaptureError("INVALID_CONTENT_LENGTH", "HTTP Content-Length is invalid");
    }
    contentLength = Number(rawLength);
    if (!Number.isSafeInteger(contentLength) || contentLength !== response.body.byteLength) {
      throw new WalmartItemReportCaptureError(
        "CONTENT_LENGTH_MISMATCH",
        "HTTP Content-Length does not match exact captured response bytes"
      );
    }
  }
  const contentType = optionalUnambiguousHeader(response.headers, ["content-type"], "Content-Type");
  const echoedCorrelation = optionalUnambiguousHeader(
    response.headers,
    ["wm_qos.correlation_id", "wm-qos-correlation-id"],
    "correlation ID"
  );
  if (expectedCorrelation !== null && echoedCorrelation !== null && walmartItemReportUtf8Sha256(echoedCorrelation) !== expectedCorrelation.sha256) {
    throw new WalmartItemReportCaptureError(
      "ECHOED_CORRELATION_MISMATCH",
      "echoed correlation ID conflicts with the exact request correlation"
    );
  }
  const echoedReportRequest = optionalUnambiguousHeader(
    response.headers,
    ["wm_qos.report_request_id", "wm-report-request-id"],
    "report request ID"
  );
  const location = optionalUnambiguousHeader(response.headers, ["location"], "Location");
  return {
    body: new Uint8Array(response.body),
    http: {
      status: response.status,
      content_type: contentType,
      content_length: contentLength,
      echoed_correlation_id_sha256: echoedCorrelation === null ? null : walmartItemReportUtf8Sha256(echoedCorrelation),
      echoed_report_request_id_sha256: echoedReportRequest === null ? null : walmartItemReportUtf8Sha256(echoedReportRequest)
    },
    location
  };
}
function exchangeSeal(requestManifestBytes, correlation, responseBody, http) {
  return {
    policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
    sha256: walmartItemReportTrustedExchangeSha256({
      request_manifest_bytes: requestManifestBytes,
      request_correlation_id_sha256: correlation.sha256,
      response_payload_bytes: responseBody,
      http
    })
  };
}
function checkpoint(phase, state, observedAt, extra = {}) {
  return {
    schema_version: WALMART_ITEM_REPORT_CAPTURE_CHECKPOINT_SCHEMA,
    phase,
    state,
    observed_at: observedAt,
    ...extra
  };
}
async function listAttemptNumbers(sessionDir, prefix) {
  const names = await readdir3(path3.join(sessionDir, "checkpoints"));
  const expression = new RegExp(`^${prefix}-(\\d{4})-reserved\\.json$`, "u");
  return names.map((name) => expression.exec(name)?.[1] ?? null).filter((value) => value !== null).map(Number).sort((left, right) => left - right);
}
function padAttempt(attempt) {
  return String(attempt).padStart(4, "0");
}
function requestIdFromPayload(bytes, label) {
  const payload = parseJsonBytes2(bytes, label);
  const nested = payload.reportRequest && typeof payload.reportRequest === "object" && !Array.isArray(payload.reportRequest) ? payload.reportRequest : null;
  const values = [payload.requestId, payload.requestID, nested?.requestId, nested?.requestID].filter((value) => value !== void 0 && value !== null).map((value) => exactString7(value, `${label} requestId`));
  if (values.length === 0 || new Set(values).size !== 1) {
    throw new WalmartItemReportCaptureError("AMBIGUOUS_REQUEST_ID", `${label} has no single requestId`);
  }
  return values[0];
}
function statusFromPayload(bytes) {
  const payload = parseJsonBytes2(bytes, "READY status response");
  const nested = payload.reportRequest && typeof payload.reportRequest === "object" && !Array.isArray(payload.reportRequest) ? payload.reportRequest : null;
  const values = [payload.requestStatus, payload.status, nested?.requestStatus, nested?.status].filter((value) => value !== void 0 && value !== null).map((value) => exactString7(value, "request status").toUpperCase());
  if (values.length === 0 || new Set(values).size !== 1) {
    throw new WalmartItemReportCaptureError("AMBIGUOUS_REQUEST_STATUS", "status response has no single status");
  }
  return values[0];
}
function locatorFromPayload(bytes) {
  const payload = parseJsonBytes2(bytes, "download locator response");
  const nested = payload.reportRequest && typeof payload.reportRequest === "object" && !Array.isArray(payload.reportRequest) ? payload.reportRequest : null;
  const urls = [payload.downloadURL, payload.downloadUrl, nested?.downloadURL, nested?.downloadUrl].filter((value) => value !== void 0 && value !== null).map((value) => exactString7(value, "downloadURL"));
  if (urls.length === 0 || new Set(urls).size !== 1) {
    throw new WalmartItemReportCaptureError("AMBIGUOUS_DOWNLOAD_URL", "locator has no single downloadURL");
  }
  const expirations = [
    payload.downloadURLExpirationTime,
    payload.downloadUrlExpirationTime,
    nested?.downloadURLExpirationTime,
    nested?.downloadUrlExpirationTime
  ].filter((value) => value !== void 0 && value !== null).map((value) => exactString7(value, "downloadURLExpirationTime"));
  const instants = expirations.map((value) => Date.parse(value));
  if (expirations.length === 0 || instants.some((value) => !Number.isFinite(value)) || new Set(instants).size !== 1) {
    throw new WalmartItemReportCaptureError(
      "AMBIGUOUS_DOWNLOAD_EXPIRATION",
      "locator has no single valid downloadURLExpirationTime"
    );
  }
  return { url: urls[0], expirationAt: new Date(instants[0]).toISOString() };
}
function parseStoredSelection(raw, relativePath) {
  const selection = {
    attempt: positiveInteger5(raw.attempt, `${relativePath}.attempt`),
    request_manifest_path: exactString7(raw.request_manifest_path, `${relativePath}.request_manifest_path`),
    response_body_path: exactString7(raw.response_body_path, `${relativePath}.response_body_path`),
    response_http_path: exactString7(raw.response_http_path, `${relativePath}.response_http_path`),
    exchange_seal_path: exactString7(raw.exchange_seal_path, `${relativePath}.exchange_seal_path`),
    observed_at: exactString7(raw.observed_at, `${relativePath}.observed_at`),
    request_correlation_id: exactString7(raw.request_correlation_id, `${relativePath}.request_correlation_id`),
    request_correlation_id_sha256: exactString7(
      raw.request_correlation_id_sha256,
      `${relativePath}.request_correlation_id_sha256`
    ),
    response_body_sha256: exactString7(raw.response_body_sha256, `${relativePath}.response_body_sha256`),
    exchange_seal_sha256: exactString7(raw.exchange_seal_sha256, `${relativePath}.exchange_seal_sha256`)
  };
  if (selection.request_correlation_id_sha256 !== walmartItemReportUtf8Sha256(selection.request_correlation_id) || !/^[a-f0-9]{64}$/u.test(selection.response_body_sha256) || !/^[a-f0-9]{64}$/u.test(selection.exchange_seal_sha256)) {
    throw new WalmartItemReportCaptureError("INVALID_SELECTION", `${relativePath} correlation digest is invalid`);
  }
  return selection;
}
async function storedSelection(sessionDir, relativePath) {
  return parseStoredSelection(await readImmutableJson(sessionDir, relativePath), relativePath);
}
function locatorSelectionPath(attempt) {
  return `trusted/39-locator-selection-${padAttempt(attempt)}.json`;
}
async function storedLocatorSelection(sessionDir, relativePath) {
  const bytes = await readImmutable(sessionDir, relativePath, 1024 * 1024);
  const raw = parseJsonBytes2(bytes, relativePath);
  const base = parseStoredSelection(raw, relativePath);
  const requestIdSha256 = exactString7(raw.request_id_sha256, `${relativePath}.request_id_sha256`);
  const downloadUrlSha256 = exactString7(raw.download_url_sha256, `${relativePath}.download_url_sha256`);
  const expirationAt = exactString7(
    raw.download_url_expiration_at,
    `${relativePath}.download_url_expiration_at`
  );
  if (![requestIdSha256, downloadUrlSha256].every((value) => /^[a-f0-9]{64}$/u.test(value)) || !Number.isFinite(Date.parse(expirationAt))) {
    throw new WalmartItemReportCaptureError("INVALID_LOCATOR_SELECTION", "locator selection binding is invalid");
  }
  return {
    ...base,
    selection_path: relativePath,
    selection_sha256: exactBytesSha256(bytes),
    request_id_sha256: requestIdSha256,
    download_url_sha256: downloadUrlSha256,
    download_url_expiration_at: new Date(Date.parse(expirationAt)).toISOString()
  };
}
async function latestLocatorSelection(sessionDir) {
  const names = await readdir3(path3.join(sessionDir, "trusted"));
  const attempts = names.map((name) => /^39-locator-selection-(\d{4})\.json$/u.exec(name)?.[1] ?? null).filter((value) => value !== null).map(Number).sort((left, right) => left - right);
  const attempt = attempts.at(-1);
  return attempt === void 0 ? null : storedLocatorSelection(sessionDir, locatorSelectionPath(attempt));
}
async function storedFileSelection(sessionDir) {
  const raw = await readImmutableJson(sessionDir, FILE_SELECTION);
  const base = parseStoredSelection(raw, FILE_SELECTION);
  if (!raw.locator_binding || typeof raw.locator_binding !== "object" || Array.isArray(raw.locator_binding)) {
    throw new WalmartItemReportCaptureError("INVALID_FILE_SELECTION", "file locator binding is missing");
  }
  const bindingRaw = raw.locator_binding;
  const attempt = positiveInteger5(bindingRaw.attempt, "file locator binding.attempt");
  const digest5 = (field) => {
    const value = exactString7(bindingRaw[field], `file locator binding.${field}`);
    if (!/^[a-f0-9]{64}$/u.test(value)) {
      throw new WalmartItemReportCaptureError("INVALID_FILE_SELECTION", `file locator ${field} is invalid`);
    }
    return value;
  };
  const artifactPath = (field) => safeRelativePath(
    exactString7(bindingRaw[field], `file locator binding.${field}`)
  );
  const selectionPath = artifactPath("selection_path");
  if (selectionPath !== locatorSelectionPath(attempt)) {
    throw new WalmartItemReportCaptureError(
      "INVALID_FILE_SELECTION",
      "file locator selection path does not match its exact attempt"
    );
  }
  const expiration = exactString7(
    bindingRaw.download_url_expiration_at,
    "file locator binding.download_url_expiration_at"
  );
  if (!Number.isFinite(Date.parse(expiration))) {
    throw new WalmartItemReportCaptureError("INVALID_FILE_SELECTION", "file locator expiration is invalid");
  }
  return {
    ...base,
    locator_binding: {
      attempt,
      selection_path: selectionPath,
      selection_sha256: digest5("selection_sha256"),
      request_manifest_path: artifactPath("request_manifest_path"),
      response_body_path: artifactPath("response_body_path"),
      response_http_path: artifactPath("response_http_path"),
      exchange_seal_path: artifactPath("exchange_seal_path"),
      request_correlation_id: exactString7(
        bindingRaw.request_correlation_id,
        "file locator binding.request_correlation_id"
      ),
      request_correlation_id_sha256: digest5("request_correlation_id_sha256"),
      response_body_sha256: digest5("response_body_sha256"),
      exchange_seal_sha256: digest5("exchange_seal_sha256"),
      request_id_sha256: digest5("request_id_sha256"),
      download_url_sha256: digest5("download_url_sha256"),
      download_url_expiration_at: new Date(Date.parse(expiration)).toISOString()
    }
  };
}
function fileLocatorBinding(locator) {
  return {
    attempt: locator.attempt,
    selection_path: locator.selection_path,
    selection_sha256: locator.selection_sha256,
    request_manifest_path: locator.request_manifest_path,
    response_body_path: locator.response_body_path,
    response_http_path: locator.response_http_path,
    exchange_seal_path: locator.exchange_seal_path,
    request_correlation_id: locator.request_correlation_id,
    request_correlation_id_sha256: locator.request_correlation_id_sha256,
    response_body_sha256: locator.response_body_sha256,
    exchange_seal_sha256: locator.exchange_seal_sha256,
    request_id_sha256: locator.request_id_sha256,
    download_url_sha256: locator.download_url_sha256,
    download_url_expiration_at: locator.download_url_expiration_at
  };
}
async function storedSeal(sessionDir, relativePath) {
  const raw = await readImmutableJson(sessionDir, relativePath);
  if (raw.policy_id !== WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.sha256)) {
    throw new WalmartItemReportCaptureError("INVALID_TRUSTED_SEAL", `${relativePath} is invalid`);
  }
  return { policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID, sha256: raw.sha256 };
}
async function persistResponseAndSeal(input) {
  const seal = exchangeSeal(
    input.requestManifestBytes,
    input.correlation,
    input.response.body,
    input.response.http
  );
  await writeImmutable(input.sessionDir, input.responsePath, input.response.body, input.dependencies);
  await writeImmutableJson(input.sessionDir, input.httpPath, input.response.http, input.dependencies);
  await writeImmutableJson(input.sessionDir, input.sealPath, seal, input.dependencies);
  return seal;
}
async function assertRequestPreparationInventory(sessionDir) {
  const allowed = /* @__PURE__ */ new Map([
    ["capture", /* @__PURE__ */ new Set([path3.basename(CREATE_MANIFEST)])],
    ["trusted", /* @__PURE__ */ new Set([path3.basename(SESSION_FILE), path3.basename(OWNER_REISSUE_PERMIT_FILE)])],
    ["checkpoints", /* @__PURE__ */ new Set()],
    ["sanitized", /* @__PURE__ */ new Set()]
  ]);
  for (const [directory, allowedNames] of allowed) {
    const names = await readdir3(path3.join(sessionDir, directory));
    if (names.some((name) => !allowedNames.has(name))) {
      throw new WalmartItemReportCaptureError(
        "TARGET_SESSION_NOT_PRISTINE",
        "replacement request session contains an unexpected pre-reservation artifact"
      );
    }
  }
}
async function executeRequestPhase(sessionDir, dependencies, retainedAuthority, verifiedPermit) {
  if (await fileExists(sessionDir, REQUEST_MANUAL_REVIEW)) {
    throw new WalmartItemReportManualReviewRequiredError();
  }
  if (await fileExists(sessionDir, REQUEST_COMPLETE)) {
    throw new WalmartItemReportCaptureError("ILLEGAL_TRANSITION", "request phase is already complete");
  }
  if (await fileExists(sessionDir, REQUEST_RESERVED)) {
    await writeImmutableJson(
      sessionDir,
      REQUEST_MANUAL_REVIEW,
      checkpoint("request", "MANUAL_REVIEW", isoNow(dependencies), {
        reason_code: "PREVIOUS_POST_RESERVED_WITHOUT_COMPLETION",
        retry_forbidden: true
      }),
      dependencies
    );
    throw new WalmartItemReportManualReviewRequiredError();
  }
  await assertRequestPreparationInventory(sessionDir);
  const authority = retainedAuthority ?? await initializeSessionFromPermit(sessionDir, verifiedPermit, dependencies);
  if (canonicalWalmartItemReportJson(authority) !== canonicalWalmartItemReportJson(verifiedPermit.authority)) {
    throw new WalmartItemReportCaptureError(
      "OWNER_REISSUE_SESSION_AUTHORITY_MISMATCH",
      "retained SessionAuthority differs from the exact owner-permitted authority"
    );
  }
  await writeImmutable(
    sessionDir,
    OWNER_REISSUE_PERMIT_FILE,
    verifiedPermit.artifact_bytes,
    dependencies
  );
  const correlation = authority.primary_correlations.create;
  const manifestBytes = verifiedPermit.create_manifest_bytes;
  await writeImmutable(sessionDir, CREATE_MANIFEST, manifestBytes, dependencies);
  const retainedPermitBytes = await readImmutable(
    sessionDir,
    OWNER_REISSUE_PERMIT_FILE,
    256 * 1024
  );
  if (!Buffer.from(retainedPermitBytes).equals(Buffer.from(verifiedPermit.artifact_bytes))) {
    throw new WalmartItemReportCaptureError(
      "OWNER_REISSUE_PERMIT_DRIFT",
      "retained owner reissue permit changed before reservation"
    );
  }
  assertRequestPermitHasPostWindow(verifiedPermit, dependencies);
  await writeExclusiveReservationJson(
    sessionDir,
    REQUEST_RESERVED,
    checkpoint("request", "RESERVED", isoNow(dependencies), {
      attempt: 1,
      post_attempt_limit: 1,
      request_manifest_sha256: walmartItemReportUtf8Sha256(new TextDecoder().decode(manifestBytes)),
      request_correlation_id_sha256: correlation.sha256
    }),
    dependencies
  );
  try {
    assertRequestPermitHasPostWindow(verifiedPermit, dependencies);
  } catch (error) {
    await writeImmutableJson(
      sessionDir,
      REQUEST_MANUAL_REVIEW,
      checkpoint("request", "MANUAL_REVIEW", isoNow(dependencies), {
        reason_code: "OWNER_REISSUE_PERMIT_EXPIRED_AFTER_RESERVATION",
        retry_forbidden: true,
        freshness_error_code: error instanceof WalmartItemReportCaptureError ? error.code : "INVALID_CLOCK"
      }),
      dependencies
    );
    throw new WalmartItemReportManualReviewRequiredError(
      "owner reissue permit lost POST headroom after reservation; retry is forbidden"
    );
  }
  let rawResponse;
  try {
    rawResponse = await sendWithDeadline(dependencies, {
      kind: "walmart-api",
      method: "POST",
      endpoint: "/v3/reports/reportRequests",
      query: { reportType: "ITEM", reportVersion: "v6" },
      url: null,
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
        "content-type": "application/json"
      },
      body: CREATE_BODY,
      correlation_id: correlation.id,
      redirect: "manual",
      max_response_bytes: WALMART_ITEM_REPORT_LIMITS.max_create_response_bytes,
      max_redirect_response_bytes: WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES
    });
  } catch {
    await writeImmutableJson(
      sessionDir,
      REQUEST_MANUAL_REVIEW,
      checkpoint("request", "MANUAL_REVIEW", isoNow(dependencies), {
        reason_code: "AMBIGUOUS_POST_NETWORK_OUTCOME",
        retry_forbidden: true
      }),
      dependencies
    );
    throw new WalmartItemReportManualReviewRequiredError();
  }
  try {
    const response = validateAtomicResponse(
      rawResponse,
      WALMART_ITEM_REPORT_LIMITS.max_create_response_bytes,
      correlation
    );
    await persistResponseAndSeal({
      sessionDir,
      requestManifestBytes: manifestBytes,
      responsePath: CREATE_RESPONSE,
      httpPath: CREATE_HTTP,
      sealPath: CREATE_SEAL,
      response,
      correlation,
      dependencies
    });
    if (response.http.status !== 200 && response.http.status !== 201) {
      await writeImmutableJson(
        sessionDir,
        REQUEST_MANUAL_REVIEW,
        checkpoint("request", "MANUAL_REVIEW", isoNow(dependencies), {
          reason_code: "POST_HTTP_FAILURE",
          http_status: response.http.status,
          retry_forbidden: true
        }),
        dependencies
      );
      throw new WalmartItemReportManualReviewRequiredError("POST returned a non-success response; retry is forbidden");
    }
    const requestId = requestIdFromPayload(response.body, "create response");
    await writeImmutableJson(
      sessionDir,
      REQUEST_COMPLETE,
      checkpoint("request", "COMPLETE", isoNow(dependencies), {
        request_id: requestId,
        request_manifest_path: CREATE_MANIFEST,
        response_body_path: CREATE_RESPONSE,
        response_http_path: CREATE_HTTP,
        exchange_seal_path: CREATE_SEAL
      }),
      dependencies
    );
    return {
      mode: "EXECUTED",
      phase: "request",
      state: "REQUESTED",
      network_calls: 1,
      http_calls: httpCallCounts(1, 0),
      session_dir: sessionDir,
      sanitized_source_path: null
    };
  } catch (error) {
    if (error instanceof WalmartItemReportManualReviewRequiredError) throw error;
    if (!await fileExists(sessionDir, REQUEST_MANUAL_REVIEW)) {
      await writeImmutableJson(
        sessionDir,
        REQUEST_MANUAL_REVIEW,
        checkpoint("request", "MANUAL_REVIEW", isoNow(dependencies), {
          reason_code: "POST_RESPONSE_CAPTURE_INVALID",
          retry_forbidden: true
        }),
        dependencies
      );
    }
    throw new WalmartItemReportManualReviewRequiredError("POST response capture is invalid; retry is forbidden");
  }
}
function requestIdFromCheckpoint(raw) {
  return exactString7(raw.request_id, "request checkpoint request_id");
}
async function assertRequestContinuationAllowed(sessionDir) {
  if (await fileExists(sessionDir, REQUEST_MANUAL_REVIEW)) {
    throw new WalmartItemReportManualReviewRequiredError(
      "request session is marked for manual review; every continuation phase is forbidden"
    );
  }
  if (!await fileExists(sessionDir, REQUEST_COMPLETE)) {
    throw new WalmartItemReportCaptureError(
      "ILLEGAL_TRANSITION",
      "continuation requires a completed request phase"
    );
  }
}
async function executePollPhase(sessionDir, authority, dependencies) {
  await assertRequestContinuationAllowed(sessionDir);
  if (await fileExists(sessionDir, READY_SELECTION)) {
    throw new WalmartItemReportCaptureError("ILLEGAL_TRANSITION", "READY status is already captured");
  }
  const requestId = requestIdFromCheckpoint(await readImmutableJson(sessionDir, REQUEST_COMPLETE));
  const attempts = await listAttemptNumbers(sessionDir, "20-poll");
  const attempt = (attempts.at(-1) ?? 0) + 1;
  const correlation = attempt === 1 ? authority.primary_correlations.ready_status : newCorrelation(dependencies.random_uuid ?? randomUUID2);
  const stem = `20-poll-${padAttempt(attempt)}`;
  const reservedPath = `checkpoints/${stem}-reserved.json`;
  const manifestPath = `capture/${stem}-request-manifest.json`;
  const responsePath = `capture/${stem}-response.bin`;
  const httpPath = `capture/${stem}-response-http.json`;
  const sealPath = `trusted/${stem}-exchange-seal.json`;
  const completePath = `checkpoints/${stem}-complete.json`;
  const failedPath = `checkpoints/${stem}-failed.json`;
  const manifestBytes = jsonBytes(buildWalmartItemReportReadyRequestManifest(
    requestId,
    binding(authority, correlation)
  ));
  await writeImmutableJson(
    sessionDir,
    reservedPath,
    checkpoint("poll", "RESERVED", isoNow(dependencies), {
      attempt,
      get_attempt_limit: 1,
      request_correlation_id: correlation.id,
      request_correlation_id_sha256: correlation.sha256
    }),
    dependencies
  );
  await writeImmutable(sessionDir, manifestPath, manifestBytes, dependencies);
  let rawResponse;
  try {
    rawResponse = await sendWithDeadline(dependencies, {
      kind: "walmart-api",
      method: "GET",
      endpoint: `/v3/reports/reportRequests/${encodeURIComponent(requestId)}`,
      query: {},
      url: null,
      headers: { accept: "application/json", "accept-encoding": "identity" },
      body: null,
      correlation_id: correlation.id,
      redirect: "manual",
      max_response_bytes: WALMART_ITEM_REPORT_LIMITS.max_ready_status_bytes,
      max_redirect_response_bytes: WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES
    });
  } catch {
    await writeImmutableJson(
      sessionDir,
      failedPath,
      checkpoint("poll", "FAILED", isoNow(dependencies), {
        attempt,
        reason_code: "GET_NETWORK_FAILURE",
        safe_to_retry_next_invocation: true
      }),
      dependencies
    );
    throw new WalmartItemReportCaptureError("GET_ATTEMPT_FAILED", "poll GET failed; retry requires a new invocation");
  }
  const response = validateAtomicResponse(rawResponse, WALMART_ITEM_REPORT_LIMITS.max_ready_status_bytes, correlation);
  const seal = await persistResponseAndSeal({
    sessionDir,
    requestManifestBytes: manifestBytes,
    responsePath,
    httpPath,
    sealPath,
    response,
    correlation,
    dependencies
  });
  if (response.http.status !== 200) {
    await writeImmutableJson(
      sessionDir,
      failedPath,
      checkpoint("poll", "FAILED", isoNow(dependencies), {
        attempt,
        reason_code: "GET_HTTP_FAILURE",
        http_status: response.http.status,
        safe_to_retry_next_invocation: true
      }),
      dependencies
    );
    throw new WalmartItemReportCaptureError("GET_ATTEMPT_FAILED", "poll GET returned non-200; retry needs a new invocation");
  }
  const status = statusFromPayload(response.body);
  const observedAt = isoNow(dependencies);
  await writeImmutableJson(
    sessionDir,
    completePath,
    checkpoint("poll", "COMPLETE", observedAt, { attempt, request_status: status }),
    dependencies
  );
  if (status === "READY") {
    const selection = {
      attempt,
      request_manifest_path: manifestPath,
      response_body_path: responsePath,
      response_http_path: httpPath,
      exchange_seal_path: sealPath,
      observed_at: observedAt,
      request_correlation_id: correlation.id,
      request_correlation_id_sha256: correlation.sha256,
      response_body_sha256: exactBytesSha256(response.body),
      exchange_seal_sha256: seal.sha256
    };
    await writeImmutableJson(sessionDir, READY_SELECTION, selection, dependencies);
  }
  return {
    mode: "EXECUTED",
    phase: "poll",
    state: status === "READY" ? "READY" : "NOT_READY",
    network_calls: 1,
    http_calls: httpCallCounts(1, 0),
    session_dir: sessionDir,
    sanitized_source_path: null
  };
}
async function captureLocator(sessionDir, authority, requestId, dependencies, forceRefresh) {
  const retained = await latestLocatorSelection(sessionDir);
  if (retained !== null && !forceRefresh && retained.request_id_sha256 === walmartItemReportUtf8Sha256(requestId) && Date.parse(retained.download_url_expiration_at) > Date.parse(isoNow(dependencies))) {
    return { selection: retained, networkCalls: 0 };
  }
  const attempts = await listAttemptNumbers(sessionDir, "30-locator");
  const attempt = (attempts.at(-1) ?? 0) + 1;
  const correlation = attempt === 1 ? authority.primary_correlations.download_locator : newCorrelation(dependencies.random_uuid ?? randomUUID2);
  const stem = `30-locator-${padAttempt(attempt)}`;
  const reservedPath = `checkpoints/${stem}-reserved.json`;
  const manifestPath = `capture/${stem}-request-manifest.json`;
  const responsePath = `capture/${stem}-response-private.bin`;
  const httpPath = `capture/${stem}-response-http.json`;
  const sealPath = `trusted/${stem}-exchange-seal.json`;
  const failedPath = `checkpoints/${stem}-failed.json`;
  const manifestBytes = jsonBytes(buildWalmartItemReportDownloadLocatorRequestManifest(
    requestId,
    binding(authority, correlation)
  ));
  await writeImmutableJson(
    sessionDir,
    reservedPath,
    checkpoint("download_locator", "RESERVED", isoNow(dependencies), {
      attempt,
      get_attempt_limit: 1,
      request_correlation_id: correlation.id,
      request_correlation_id_sha256: correlation.sha256
    }),
    dependencies
  );
  await writeImmutable(sessionDir, manifestPath, manifestBytes, dependencies);
  let rawResponse;
  try {
    rawResponse = await sendWithDeadline(dependencies, {
      kind: "walmart-api",
      method: "GET",
      endpoint: "/v3/reports/downloadReport",
      query: { requestId },
      url: null,
      headers: { accept: "application/json", "accept-encoding": "identity" },
      body: null,
      correlation_id: correlation.id,
      redirect: "manual",
      max_response_bytes: WALMART_ITEM_REPORT_LIMITS.max_download_locator_response_bytes,
      max_redirect_response_bytes: WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES
    });
  } catch {
    await writeImmutableJson(
      sessionDir,
      failedPath,
      checkpoint("download_locator", "FAILED", isoNow(dependencies), {
        attempt,
        reason_code: "GET_NETWORK_FAILURE",
        safe_to_retry_next_invocation: true
      }),
      dependencies
    );
    throw new WalmartItemReportCaptureError(
      "GET_ATTEMPT_FAILED",
      "download locator GET failed; retry requires a new invocation"
    );
  }
  const response = validateAtomicResponse(
    rawResponse,
    WALMART_ITEM_REPORT_LIMITS.max_download_locator_response_bytes,
    correlation
  );
  const seal = await persistResponseAndSeal({
    sessionDir,
    requestManifestBytes: manifestBytes,
    responsePath,
    httpPath,
    sealPath,
    response,
    correlation,
    dependencies
  });
  if (response.http.status !== 200) {
    await writeImmutableJson(
      sessionDir,
      failedPath,
      checkpoint("download_locator", "FAILED", isoNow(dependencies), {
        attempt,
        reason_code: "GET_HTTP_FAILURE",
        http_status: response.http.status,
        safe_to_retry_next_invocation: true
      }),
      dependencies
    );
    throw new WalmartItemReportCaptureError("GET_ATTEMPT_FAILED", "download locator returned non-200");
  }
  const locator = locatorFromPayload(response.body);
  if (requestIdFromPayload(response.body, "download locator response") !== requestId) {
    throw new WalmartItemReportCaptureError(
      "LOCATOR_REQUEST_ID_MISMATCH",
      "download locator response does not match the retained READY requestId"
    );
  }
  buildWalmartItemReportFileRequestManifest({
    ...binding(authority, authority.primary_correlations.report_file),
    locator_url: locator.url
  });
  const observedAt = isoNow(dependencies);
  const selectionRecord = {
    attempt,
    request_manifest_path: manifestPath,
    response_body_path: responsePath,
    response_http_path: httpPath,
    exchange_seal_path: sealPath,
    observed_at: observedAt,
    request_correlation_id: correlation.id,
    request_correlation_id_sha256: correlation.sha256,
    response_body_sha256: exactBytesSha256(response.body),
    exchange_seal_sha256: seal.sha256,
    request_id_sha256: walmartItemReportUtf8Sha256(requestId),
    download_url_sha256: walmartItemReportUtf8Sha256(locator.url),
    download_url_expiration_at: locator.expirationAt
  };
  const selectionPath = locatorSelectionPath(attempt);
  const selectionBytes = jsonBytes(selectionRecord);
  await writeImmutable(sessionDir, selectionPath, selectionBytes, dependencies);
  return {
    selection: {
      ...selectionRecord,
      selection_path: selectionPath,
      selection_sha256: exactBytesSha256(selectionBytes)
    },
    networkCalls: 1
  };
}
async function captureReportFile(sessionDir, authority, locatorSelection, dependencies) {
  if (await fileExists(sessionDir, FILE_SELECTION)) {
    throw new WalmartItemReportCaptureError("ILLEGAL_TRANSITION", "report file is already captured");
  }
  const locatorBody = await readImmutable(
    sessionDir,
    locatorSelection.response_body_path,
    WALMART_ITEM_REPORT_LIMITS.max_download_locator_response_bytes
  );
  if (exactBytesSha256(locatorBody) !== locatorSelection.response_body_sha256) {
    throw new WalmartItemReportCaptureError(
      "LOCATOR_SELECTION_BODY_MISMATCH",
      "selected locator response bytes do not match the exact retained locator binding"
    );
  }
  const retainedLocatorSeal = await storedSeal(sessionDir, locatorSelection.exchange_seal_path);
  if (retainedLocatorSeal.sha256 !== locatorSelection.exchange_seal_sha256) {
    throw new WalmartItemReportCaptureError(
      "LOCATOR_SELECTION_SEAL_MISMATCH",
      "selected locator exchange seal does not match the exact retained locator binding"
    );
  }
  const locator = locatorFromPayload(locatorBody);
  if (walmartItemReportUtf8Sha256(locator.url) !== locatorSelection.download_url_sha256 || locator.expirationAt !== locatorSelection.download_url_expiration_at) {
    throw new WalmartItemReportCaptureError(
      "LOCATOR_SELECTION_URL_MISMATCH",
      "selected locator URL metadata does not match its exact retained response"
    );
  }
  const beforeRequestAt = isoNow(dependencies);
  if (Date.parse(locator.expirationAt) <= Date.parse(beforeRequestAt)) {
    throw new WalmartItemReportCaptureError(
      "DOWNLOAD_URL_EXPIRED",
      "retained download URL expired; retry download to acquire a new append-only locator"
    );
  }
  const attempts = await listAttemptNumbers(sessionDir, "40-file");
  const attempt = (attempts.at(-1) ?? 0) + 1;
  const correlation = attempt === 1 ? authority.primary_correlations.report_file : newCorrelation(dependencies.random_uuid ?? randomUUID2);
  const stem = `40-file-${padAttempt(attempt)}`;
  const reservedPath = `checkpoints/${stem}-reserved.json`;
  const manifestPath = `capture/${stem}-request-manifest.json`;
  const sealPath = `trusted/${stem}-exchange-seal.json`;
  const failedPath = `checkpoints/${stem}-failed.json`;
  await writeImmutableJson(
    sessionDir,
    reservedPath,
    checkpoint("download_file", "RESERVED", beforeRequestAt, {
      attempt,
      request_chain_attempt_limit_per_url: 1,
      initial_url_sha256: walmartItemReportUtf8Sha256(locator.url),
      locator_selection_path: locatorSelection.selection_path,
      locator_selection_sha256: locatorSelection.selection_sha256,
      locator_attempt: locatorSelection.attempt,
      request_correlation_id: correlation.id,
      request_correlation_id_sha256: correlation.sha256
    }),
    dependencies
  );
  const redirects = [];
  let currentUrl = locator.url;
  let networkCalls = 0;
  let aggregateRedirectBytes = 0;
  for (let hop = 0; hop <= WALMART_ITEM_REPORT_LIMITS.max_redirects; hop += 1) {
    buildWalmartItemReportFileRequestManifest({
      ...binding(authority, correlation),
      locator_url: locator.url,
      redirects
    });
    let rawResponse;
    try {
      networkCalls += 1;
      rawResponse = await sendWithDeadline(dependencies, {
        kind: "presigned-file",
        method: "GET",
        endpoint: null,
        query: {},
        url: currentUrl,
        headers: {
          accept: "application/octet-stream,text/csv,text/tab-separated-values",
          "accept-encoding": "identity"
        },
        body: null,
        correlation_id: null,
        redirect: "manual",
        max_response_bytes: WALMART_ITEM_REPORT_LIMITS.max_transport_bytes,
        max_redirect_response_bytes: WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES
      });
    } catch {
      await writeImmutableJson(
        sessionDir,
        failedPath,
        checkpoint("download_file", "FAILED", isoNow(dependencies), {
          attempt,
          reason_code: "GET_NETWORK_FAILURE",
          safe_to_retry_next_invocation: true
        }),
        dependencies
      );
      throw new WalmartItemReportCaptureError(
        "GET_ATTEMPT_FAILED",
        "presigned file GET failed; retry requires a new invocation"
      );
    }
    const response = validateAtomicResponse(
      rawResponse,
      WALMART_ITEM_REPORT_LIMITS.max_transport_bytes,
      null
    );
    const isRedirect = REDIRECT_STATUSES.has(response.http.status);
    if (isRedirect) {
      if (response.body.byteLength > WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES) {
        throw new WalmartItemReportCaptureError(
          "REDIRECT_BODY_CAP",
          "presigned redirect response exceeded its small-body safety cap"
        );
      }
      aggregateRedirectBytes += response.body.byteLength;
      if (aggregateRedirectBytes > WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_CHAIN_BYTES) {
        throw new WalmartItemReportCaptureError(
          "REDIRECT_CHAIN_BYTE_CAP",
          "presigned redirect chain exceeded its aggregate byte safety cap"
        );
      }
    }
    const hopName = `${stem}-hop-${String(hop).padStart(2, "0")}`;
    const hopBodyPath = `capture/${hopName}-response-private.bin`;
    const hopHttpPath = `capture/${hopName}-response-http.json`;
    const hopPrivatePath = `capture/${hopName}-url-private.json`;
    await writeImmutable(sessionDir, hopBodyPath, response.body, dependencies);
    await writeImmutableJson(sessionDir, hopHttpPath, response.http, dependencies);
    await writeImmutableJson(sessionDir, hopPrivatePath, {
      request_url: currentUrl,
      response_location: response.location
    }, dependencies);
    if (isRedirect) {
      if (response.location === null) {
        throw new WalmartItemReportCaptureError("REDIRECT_WITHOUT_LOCATION", "redirect response has no Location header");
      }
      if (hop >= WALMART_ITEM_REPORT_LIMITS.max_redirects) {
        throw new WalmartItemReportCaptureError("REDIRECT_CAP", "presigned download exceeded redirect safety cap");
      }
      let nextUrl;
      try {
        nextUrl = new URL(response.location, currentUrl).toString();
      } catch {
        throw new WalmartItemReportCaptureError("INVALID_REDIRECT", "redirect Location is invalid");
      }
      const redirect = {
        status: response.http.status,
        from_url: currentUrl,
        to_url: nextUrl
      };
      buildWalmartItemReportFileRequestManifest({
        ...binding(authority, correlation),
        locator_url: locator.url,
        redirects: [...redirects, redirect]
      });
      redirects.push(redirect);
      currentUrl = nextUrl;
      continue;
    }
    if (response.http.status !== 200) {
      await writeImmutableJson(
        sessionDir,
        failedPath,
        checkpoint("download_file", "FAILED", isoNow(dependencies), {
          attempt,
          reason_code: "GET_HTTP_FAILURE",
          http_status: response.http.status,
          safe_to_retry_next_invocation: true
        }),
        dependencies
      );
      throw new WalmartItemReportCaptureError("GET_ATTEMPT_FAILED", "presigned file GET returned non-200");
    }
    if (response.body.byteLength === 0) {
      throw new WalmartItemReportCaptureError("EMPTY_REPORT_FILE", "downloaded report file is empty");
    }
    const manifestBytes = jsonBytes(buildWalmartItemReportFileRequestManifest({
      ...binding(authority, correlation),
      locator_url: locator.url,
      redirects
    }));
    const seal = exchangeSeal(manifestBytes, correlation, response.body, response.http);
    await writeImmutable(sessionDir, manifestPath, manifestBytes, dependencies);
    await writeImmutableJson(sessionDir, sealPath, seal, dependencies);
    const observedAt = isoNow(dependencies);
    if (Date.parse(locator.expirationAt) < Date.parse(observedAt)) {
      throw new WalmartItemReportCaptureError(
        "DOWNLOAD_URL_EXPIRED_DURING_TRANSFER",
        "download completed after the retained URL expiration"
      );
    }
    const selection = {
      attempt,
      request_manifest_path: manifestPath,
      response_body_path: hopBodyPath,
      response_http_path: hopHttpPath,
      exchange_seal_path: sealPath,
      observed_at: observedAt,
      request_correlation_id: correlation.id,
      request_correlation_id_sha256: correlation.sha256,
      response_body_sha256: exactBytesSha256(response.body),
      exchange_seal_sha256: seal.sha256,
      locator_binding: fileLocatorBinding(locatorSelection)
    };
    await writeImmutableJson(sessionDir, FILE_SELECTION, selection, dependencies);
    return { selection, networkCalls };
  }
  throw new WalmartItemReportCaptureError("REDIRECT_CAP", "presigned download exceeded redirect safety cap");
}
async function executeDownloadPhase(sessionDir, authority, dependencies) {
  await assertRequestContinuationAllowed(sessionDir);
  if (!await fileExists(sessionDir, READY_SELECTION)) {
    throw new WalmartItemReportCaptureError("ILLEGAL_TRANSITION", "download requires a captured READY response");
  }
  if (await fileExists(sessionDir, FILE_SELECTION)) {
    throw new WalmartItemReportCaptureError("ILLEGAL_TRANSITION", "download phase is already complete");
  }
  const requestId = requestIdFromCheckpoint(await readImmutableJson(sessionDir, REQUEST_COMPLETE));
  const priorFileAttempts = await listAttemptNumbers(sessionDir, "40-file");
  const locator = await captureLocator(
    sessionDir,
    authority,
    requestId,
    dependencies,
    priorFileAttempts.length > 0
  );
  const reportFile = await captureReportFile(sessionDir, authority, locator.selection, dependencies);
  const calls = httpCallCounts(locator.networkCalls, reportFile.networkCalls);
  return {
    mode: "EXECUTED",
    phase: "download",
    state: "DOWNLOADED",
    network_calls: calls.total_http_calls,
    http_calls: calls,
    session_dir: sessionDir,
    sanitized_source_path: null
  };
}
function parseStoredHttp(raw, label) {
  const status = positiveInteger5(raw.status, `${label}.status`);
  const contentType = raw.content_type === null ? null : exactString7(raw.content_type, `${label}.content_type`);
  let contentLength;
  if (raw.content_length === null) contentLength = null;
  else if (Number.isSafeInteger(raw.content_length) && Number(raw.content_length) >= 0) {
    contentLength = Number(raw.content_length);
  } else throw new WalmartItemReportCaptureError("INVALID_HTTP_METADATA", `${label}.content_length is invalid`);
  const parseDigest = (value, field) => {
    if (value === null) return null;
    const digest5 = exactString7(value, `${label}.${field}`);
    if (!/^[a-f0-9]{64}$/u.test(digest5)) {
      throw new WalmartItemReportCaptureError("INVALID_HTTP_METADATA", `${label}.${field} is invalid`);
    }
    return digest5;
  };
  return {
    status,
    content_type: contentType,
    content_length: contentLength,
    echoed_correlation_id_sha256: parseDigest(
      raw.echoed_correlation_id_sha256,
      "echoed_correlation_id_sha256"
    ),
    echoed_report_request_id_sha256: parseDigest(
      raw.echoed_report_request_id_sha256,
      "echoed_report_request_id_sha256"
    )
  };
}
async function executeCompilePhase(sessionDir, storeIndex, dependencies) {
  await assertRequestContinuationAllowed(sessionDir);
  if (!await fileExists(sessionDir, FILE_SELECTION)) {
    throw new WalmartItemReportCaptureError("ILLEGAL_TRANSITION", "compile requires a completed download phase");
  }
  const authority = await loadSession(sessionDir, storeIndex);
  const ready = await storedSelection(sessionDir, READY_SELECTION);
  const file = await storedFileSelection(sessionDir);
  const locator = await storedLocatorSelection(sessionDir, file.locator_binding.selection_path);
  if (canonicalWalmartItemReportJson(file.locator_binding) !== canonicalWalmartItemReportJson(fileLocatorBinding(locator))) {
    throw new WalmartItemReportCaptureError(
      "FILE_LOCATOR_BACK_REFERENCE_MISMATCH",
      "FILE_SELECTION does not bind the exact retained locator attempt"
    );
  }
  const fileReserved = await readImmutableJson(
    sessionDir,
    `checkpoints/40-file-${padAttempt(file.attempt)}-reserved.json`
  );
  if (fileReserved.locator_selection_path !== locator.selection_path || fileReserved.locator_selection_sha256 !== locator.selection_sha256 || fileReserved.locator_attempt !== locator.attempt) {
    throw new WalmartItemReportCaptureError(
      "FILE_LOCATOR_RESERVATION_MISMATCH",
      "file reservation does not bind the exact retained locator selection"
    );
  }
  const createSeal = await storedSeal(sessionDir, CREATE_SEAL);
  const readySeal = await storedSeal(sessionDir, ready.exchange_seal_path);
  const locatorSeal = await storedSeal(sessionDir, locator.exchange_seal_path);
  const fileSeal = await storedSeal(sessionDir, file.exchange_seal_path);
  const readyBody = await readImmutable(
    sessionDir,
    ready.response_body_path,
    WALMART_ITEM_REPORT_LIMITS.max_ready_status_bytes
  );
  const locatorBody = await readImmutable(
    sessionDir,
    locator.response_body_path,
    WALMART_ITEM_REPORT_LIMITS.max_download_locator_response_bytes
  );
  const fileBody = await readImmutable(
    sessionDir,
    file.response_body_path,
    WALMART_ITEM_REPORT_LIMITS.max_transport_bytes
  );
  if (exactBytesSha256(readyBody) !== ready.response_body_sha256 || readySeal.sha256 !== ready.exchange_seal_sha256 || exactBytesSha256(locatorBody) !== locator.response_body_sha256 || locatorSeal.sha256 !== locator.exchange_seal_sha256 || exactBytesSha256(fileBody) !== file.response_body_sha256 || fileSeal.sha256 !== file.exchange_seal_sha256) {
    throw new WalmartItemReportCaptureError(
      "SELECTION_ARTIFACT_BINDING_MISMATCH",
      "retained selection does not match its exact response bytes and trusted seal"
    );
  }
  const context = {
    account_scope: { ...authority.account_scope },
    request_correlations: {
      create_sha256: authority.primary_correlations.create.sha256,
      ready_status_sha256: ready.request_correlation_id_sha256,
      download_locator_sha256: locator.request_correlation_id_sha256,
      report_file_sha256: file.request_correlation_id_sha256
    },
    trusted_exchange_seals: {
      create_response_sha256: createSeal.sha256,
      ready_status_response_sha256: readySeal.sha256,
      download_locator_response_sha256: locatorSeal.sha256,
      download_response_sha256: fileSeal.sha256
    },
    ready_at: ready.observed_at,
    download_locator_at: locator.observed_at,
    report_file_requested_at: exactString7(fileReserved.observed_at, "file reservation observed_at"),
    downloaded_at: file.observed_at
  };
  await writeImmutableJson(sessionDir, COMPILE_CONTEXT, context, dependencies);
  const capture = {
    create_request_manifest_bytes: await readImmutable(
      sessionDir,
      CREATE_MANIFEST,
      WALMART_ITEM_REPORT_LIMITS.max_create_request_bytes
    ),
    create_response_payload_bytes: await readImmutable(
      sessionDir,
      CREATE_RESPONSE,
      WALMART_ITEM_REPORT_LIMITS.max_create_response_bytes
    ),
    ready_status_request_manifest_bytes: await readImmutable(
      sessionDir,
      ready.request_manifest_path,
      WALMART_ITEM_REPORT_LIMITS.max_ready_request_bytes
    ),
    ready_status_payload_bytes: readyBody,
    download_locator_request_manifest_bytes: await readImmutable(
      sessionDir,
      locator.request_manifest_path,
      WALMART_ITEM_REPORT_LIMITS.max_download_locator_request_bytes
    ),
    download_locator_response_payload_bytes: locatorBody,
    report_file_request_manifest_bytes: await readImmutable(
      sessionDir,
      file.request_manifest_path,
      WALMART_ITEM_REPORT_LIMITS.max_report_file_request_bytes
    ),
    downloaded_body_bytes: fileBody,
    http: {
      create_response: parseStoredHttp(await readImmutableJson(sessionDir, CREATE_HTTP), "create HTTP"),
      ready_status_response: parseStoredHttp(
        await readImmutableJson(sessionDir, ready.response_http_path),
        "READY HTTP"
      ),
      download_locator_response: parseStoredHttp(
        await readImmutableJson(sessionDir, locator.response_http_path),
        "locator HTTP"
      ),
      download_response: parseStoredHttp(
        await readImmutableJson(sessionDir, file.response_http_path),
        "download HTTP"
      )
    }
  };
  const source = compileWalmartItemReportPublishedSource(capture, context);
  verifyWalmartItemReportPublishedSourceAgainstCapture(source, capture, context);
  const catalogSource = compileWalmartItemReportCatalogSource(capture, context);
  verifyWalmartItemReportCatalogSourceAgainstCapture(
    catalogSource,
    capture,
    context
  );
  if (catalogSource.published_source.source_id !== source.source_id || catalogSource.published_source.body_sha256 !== source.body_sha256) {
    throw new WalmartItemReportCaptureError(
      "CATALOG_PUBLISHED_SOURCE_BINDING_MISMATCH",
      "all-status catalog source does not bind the exact verified PUBLISHED source"
    );
  }
  const sanitizedBytes = jsonBytes(source);
  const sanitizedCatalogBytes = jsonBytes(catalogSource);
  const sanitizedSourceSha256 = exactBytesSha256(sanitizedBytes);
  const sanitizedCatalogSourceSha256 = exactBytesSha256(sanitizedCatalogBytes);
  const locatorPrivate = locatorFromPayload(capture.download_locator_response_payload_bytes);
  const sanitizedText = new TextDecoder().decode(sanitizedBytes);
  const sanitizedCatalogText = new TextDecoder().decode(sanitizedCatalogBytes);
  if ([sanitizedText, sanitizedCatalogText].some(
    (value) => value.includes(locatorPrivate.url) || /(?:X-Amz-|X-Goog-|[?&](?:sig|signature|token)=)/iu.test(value)
  )) {
    throw new WalmartItemReportCaptureError(
      "SANITIZATION_FAILURE",
      "sanitized source artifacts contain presigned URL material"
    );
  }
  await writeImmutable(sessionDir, SANITIZED_SOURCE, sanitizedBytes, dependencies);
  await writeImmutable(
    sessionDir,
    SANITIZED_CATALOG_SOURCE,
    sanitizedCatalogBytes,
    dependencies
  );
  if (await fileExists(sessionDir, COMPILE_COMPLETE)) {
    const retainedComplete = await readImmutableJson(sessionDir, COMPILE_COMPLETE);
    if (retainedComplete.phase !== "compile" || retainedComplete.state !== "COMPLETE" || retainedComplete.source_id !== source.source_id || retainedComplete.body_sha256 !== source.body_sha256 || retainedComplete.strongest_capture_aware_verifier !== true || retainedComplete.sanitized_source_path !== SANITIZED_SOURCE || retainedComplete.sanitized_source_sha256 !== sanitizedSourceSha256 || retainedComplete.catalog_source_id !== catalogSource.source_id || retainedComplete.catalog_body_sha256 !== catalogSource.body_sha256 || retainedComplete.catalog_strongest_capture_aware_verifier !== true || retainedComplete.sanitized_catalog_source_path !== SANITIZED_CATALOG_SOURCE || retainedComplete.sanitized_catalog_source_sha256 !== sanitizedCatalogSourceSha256 || retainedComplete.network_calls !== 0) {
      throw new WalmartItemReportCaptureError(
        "COMPILE_CHECKPOINT_MISMATCH",
        "retained compile checkpoint does not match the strongest verified source"
      );
    }
  } else {
    await writeImmutableJson(
      sessionDir,
      COMPILE_COMPLETE,
      checkpoint("compile", "COMPLETE", isoNow(dependencies), {
        source_id: source.source_id,
        body_sha256: source.body_sha256,
        strongest_capture_aware_verifier: true,
        sanitized_source_path: SANITIZED_SOURCE,
        sanitized_source_sha256: sanitizedSourceSha256,
        catalog_source_id: catalogSource.source_id,
        catalog_body_sha256: catalogSource.body_sha256,
        catalog_strongest_capture_aware_verifier: true,
        sanitized_catalog_source_path: SANITIZED_CATALOG_SOURCE,
        sanitized_catalog_source_sha256: sanitizedCatalogSourceSha256,
        network_calls: 0
      }),
      dependencies
    );
  }
  const compileCheckpointBytes = await readImmutable(
    sessionDir,
    COMPILE_COMPLETE,
    1024 * 1024
  );
  const calls = httpCallCounts(0, 0);
  return {
    mode: "EXECUTED",
    phase: "compile",
    state: "COMPILED",
    network_calls: calls.total_http_calls,
    http_calls: calls,
    session_dir: sessionDir,
    sanitized_source_path: path3.join(sessionDir, SANITIZED_SOURCE),
    sanitized_source_sha256: sanitizedSourceSha256,
    published_source_id: source.source_id,
    published_source_body_sha256: source.body_sha256,
    sanitized_catalog_source_path: path3.join(
      sessionDir,
      SANITIZED_CATALOG_SOURCE
    ),
    sanitized_catalog_source_sha256: sanitizedCatalogSourceSha256,
    catalog_source_id: catalogSource.source_id,
    catalog_source_body_sha256: catalogSource.body_sha256,
    compile_checkpoint_path: path3.join(sessionDir, COMPILE_COMPLETE),
    compile_checkpoint_sha256: exactBytesSha256(compileCheckpointBytes)
  };
}
async function runWalmartItemReportCapturePhase(input, dependencies) {
  const plan = planWalmartItemReportCapturePhase(input);
  if (!input.execute) return plan;
  const phase = input.phase;
  const storeIndex = positiveInteger5(input.store_index, "store_index");
  if (phase !== "request" && input.owner_reissue_permit !== void 0) {
    throw new WalmartItemReportCaptureError(
      "OWNER_REISSUE_PERMIT_PHASE_MISMATCH",
      "owner reissue permit is valid only for the request phase"
    );
  }
  const activeScope = phase === "compile" ? null : activeAccountScope(storeIndex, dependencies);
  let verifiedPermit = null;
  if (phase === "request") {
    if (activeScope === null) {
      throw new WalmartItemReportCaptureError(
        "MISSING_CREDENTIAL_SCOPE",
        "request phase requires active Walmart credential scope"
      );
    }
    verifiedPermit = verifyRequestPermitBeforeWrite(input, activeScope, dependencies);
  }
  const { sessionDir, created } = await assertWalmartItemReportCaptureSessionDir(
    input.allowed_capture_root,
    input.session_dir,
    phase === "request"
  );
  const retainedAuthority = created ? null : await loadSession(sessionDir, storeIndex);
  if (activeScope !== null && retainedAuthority !== null) {
    assertActiveAuthorityMatch(retainedAuthority, activeScope);
  }
  if (phase === "request") {
    if (verifiedPermit === null) {
      throw new WalmartItemReportCaptureError(
        "MISSING_OWNER_REISSUE_PERMIT",
        "request phase permit verification did not complete"
      );
    }
    return executeRequestPhase(sessionDir, dependencies, retainedAuthority, verifiedPermit);
  }
  if (retainedAuthority === null) {
    throw new WalmartItemReportCaptureError("INVALID_SESSION", "existing session authority is required");
  }
  if (phase === "poll") return executePollPhase(sessionDir, retainedAuthority, dependencies);
  if (phase === "download") return executeDownloadPhase(sessionDir, retainedAuthority, dependencies);
  return executeCompilePhase(sessionDir, storeIndex, dependencies);
}

// src/lib/walmart/item-report-reissue-executor-v2.ts
import { createHash as createHash12, randomUUID as randomUUID3 } from "node:crypto";
import { constants as fsConstants4 } from "node:fs";
import { builtinModules } from "node:module";
import {
  lstat as lstat4,
  mkdir as mkdir3,
  open as open4,
  readdir as readdir4,
  realpath as realpath4
} from "node:fs/promises";
import path4 from "node:path";
import { fileURLToPath } from "node:url";
var WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_POLICY = "walmart-item-report-reissue-executor/3.3.0";
var WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_PREFLIGHT_SCHEMA = "walmart-item-report-reissue-executor-preflight/v3";
var WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_CHECKPOINT_SCHEMA = "walmart-item-report-reissue-execution-checkpoint/v3";
var WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENGINE_SCHEMA = "walmart-item-report-reissue-v2-frozen-engine/1.0.0";
var WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENGINE_POLICY = "walmart-item-report-reissue-v2-engine-freeze-policy/1.0.0";
var WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENTRYPOINT = "scripts/walmart-item-report-reissue-v2-frozen-executor.mjs";
var WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE = "walmart-item-report-reissue-v2-frozen-executor.bundle.mjs";
var WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_TIMEOUT_MS = 6e4;
var WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_PRE_BURN_HEADROOM_MS = 13e4;
var WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_RESPONSE_BYTES = 1024 * 1024;
var WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_EXACT_ARGV_ORDER = Object.freeze([
  "execute-create",
  "--engine-manifest",
  "--expect-engine-manifest-sha256",
  "--expect-frozen-bundle-sha256",
  "--source-evidence",
  "--expect-source-evidence-sha256",
  "--owner-disposition",
  "--expect-owner-disposition-sha256",
  "--ledger-state-directory",
  "--store-index"
]);
var CREATE_BODY2 = Buffer.from("{}", "utf8");
var ABSENCE_GUARD_QUERY = Object.freeze({
  reportType: "ITEM",
  reportVersion: "v6",
  requestSubmissionStartDate: "2026-07-19T03:55:00Z",
  requestSubmissionEndDate: "2026-07-19T04:00:00Z",
  src: "API"
});
var LOADED_EXECUTOR_MODULE_PATH = fileURLToPath(import.meta.url);
var DIRECTORY_MODE2 = 448;
var FILE_MODE2 = 256;
var REQUIRED_ENGINE_SOURCE_INPUTS = Object.freeze([
  WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENTRYPOINT,
  "scripts/capture-walmart-item-report-source.mjs",
  "src/lib/walmart/item-report-reissue-consumption-ledger-v2.ts",
  "src/lib/walmart/item-report-reissue-executor-v2.ts",
  "src/lib/walmart/item-report-reissue-owner-disposition-v2.ts",
  "src/lib/walmart/owner-control-trust-root.ts",
  "src/lib/walmart/item-report-reissue-permit.ts",
  "src/lib/walmart/item-report-reissue-absence-probe-evidence.ts",
  "src/lib/walmart/item-report-reissue-source-evidence-v2.ts",
  "src/lib/walmart/item-report-reissue-source-evidence-renewal-v1.ts",
  "src/lib/walmart/item-report-capture-session.ts",
  "src/lib/walmart/item-report-published-source.ts"
]);
var REQUIRED_CERTIFICATION_BINDINGS = Object.freeze({
  CAPTURE_SESSION_TEST: "src/lib/walmart/__tests__/item-report-capture-session.test.mjs",
  EXECUTOR_ENTRYPOINT: "scripts/walmart-item-report-reissue-v2-frozen-executor.mjs",
  EXECUTOR_ENTRYPOINT_TEST: "scripts/__tests__/walmart-item-report-reissue-v2-frozen-executor.test.mjs",
  EXECUTOR_FREEZER: "scripts/freeze-walmart-item-report-reissue-v2-executor-engine.mjs",
  EXECUTOR_FREEZER_TEST: "scripts/__tests__/freeze-walmart-item-report-reissue-v2-executor-engine.test.mjs",
  EXECUTOR_MODULE: "src/lib/walmart/item-report-reissue-executor-v2.ts",
  EXECUTOR_TEST: "src/lib/walmart/__tests__/item-report-reissue-executor-v2.test.mjs",
  FREEZER_PRIMITIVE: "scripts/freeze-walmart-item-report-reissue-v2-engine.mjs",
  FREEZER_PRIMITIVE_TEST: "scripts/__tests__/freeze-walmart-item-report-reissue-v2-engine.test.mjs",
  LEDGER_MODULE: "src/lib/walmart/item-report-reissue-consumption-ledger-v2.ts",
  LEDGER_TEST: "src/lib/walmart/__tests__/item-report-reissue-consumption-ledger-v2.test.mjs",
  OWNER_DISPOSITION_MODULE: "src/lib/walmart/item-report-reissue-owner-disposition-v2.ts",
  OWNER_DISPOSITION_TEST: "src/lib/walmart/__tests__/item-report-reissue-owner-disposition-v2.test.mjs",
  OWNER_CONTROL_TRUST_ROOT: "src/lib/walmart/owner-control-trust-root.ts",
  ABSENCE_PROBE_EVIDENCE_MODULE: "src/lib/walmart/item-report-reissue-absence-probe-evidence.ts",
  ABSENCE_PROBE_EVIDENCE_TEST: "scripts/__tests__/capture-walmart-item-v6-absence-probe.test.mjs",
  SOURCE_EVIDENCE_MODULE: "src/lib/walmart/item-report-reissue-source-evidence-v2.ts",
  SOURCE_EVIDENCE_TEST: "src/lib/walmart/__tests__/item-report-reissue-source-evidence-v2.test.mjs",
  SOURCE_EVIDENCE_RENEWAL_MODULE: "src/lib/walmart/item-report-reissue-source-evidence-renewal-v1.ts",
  SOURCE_EVIDENCE_RENEWAL_TEST: "src/lib/walmart/__tests__/item-report-reissue-source-evidence-renewal-v1.test.mjs"
});
var NODE_BUILTIN_SPECIFIERS = new Set(
  builtinModules.flatMap((name) => name.startsWith("node:") ? [name] : [name, `node:${name}`])
);
var CONTINUATION_ENTRYPOINT = "scripts/capture-walmart-item-report-source.mjs";
var CONTINUATION_PHASES = Object.freeze(["poll", "download", "compile"]);
var WalmartItemReportReissueExecutorV2Error = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WalmartItemReportReissueExecutorV2Error";
    this.code = code;
  }
};
var WalmartItemReportReissueExecutorV2ManualReviewError = class extends WalmartItemReportReissueExecutorV2Error {
  constructor(reasonCode, sessionDirectory, message) {
    super("MANUAL_REVIEW_REQUIRED", message);
    this.name = "WalmartItemReportReissueExecutorV2ManualReviewError";
    this.reason_code = reasonCode;
    this.replacement_session_directory = sessionDirectory;
  }
};
function fail7(code, message) {
  throw new WalmartItemReportReissueExecutorV2Error(code, message);
}
function isRecord10(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record6(value, label) {
  if (!isRecord10(value)) fail7("INVALID_INPUT", `${label} must be an object`);
  return value;
}
function exactKeys5(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail7("INVALID_FROZEN_ENGINE", `${label} has missing or extra fields`);
  }
}
function exactString8(value, label, maximum = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail7("INVALID_INPUT", `${label} must be one exact string`);
  }
  return value;
}
function digest4(value, label) {
  const parsed = exactString8(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) fail7("INVALID_INPUT", `${label} must be SHA-256`);
  return parsed;
}
function positiveInteger6(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail7("INVALID_INPUT", `${label} must be a positive safe integer`);
  }
  return Number(value);
}
function nonNegativeInteger4(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail7("INVALID_INPUT", `${label} must be a non-negative safe integer`);
  }
  return Number(value);
}
function sha2565(bytes) {
  return createHash12("sha256").update(bytes).digest("hex");
}
function snapshotArtifact(artifact2, label) {
  if (!isRecord10(artifact2) || !(artifact2.bytes instanceof Uint8Array) || artifact2.bytes.byteLength === 0) {
    fail7("INVALID_INPUT", `${label} exact bytes are required`);
  }
  const bytes = Buffer.from(artifact2.bytes);
  const expected = digest4(artifact2.expected_artifact_sha256, `${label} expected SHA-256`);
  if (sha2565(bytes) !== expected) {
    fail7("ARTIFACT_HASH_MISMATCH", `${label} exact bytes differ from expected SHA-256`);
  }
  return { bytes, sha256: expected };
}
function parseCanonicalJson2(bytes, label) {
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    fail7("INVALID_ARTIFACT", `${label} must contain UTF-8 JSON`);
  }
  const parsed = record6(value, label);
  if (text !== canonicalWalmartItemReportJson(parsed)) {
    fail7("NON_CANONICAL_ARTIFACT", `${label} must use canonical compact JSON bytes`);
  }
  return parsed;
}
function canonicalRelative(value, label) {
  const parsed = exactString8(value, label);
  if (parsed.includes("\\") || path4.posix.isAbsolute(parsed) || parsed === "." || parsed.startsWith("../") || path4.posix.normalize(parsed) !== parsed) {
    fail7("INVALID_FROZEN_ENGINE", `${label} must be canonical project-relative path`);
  }
  return parsed;
}
function parseHashedInventory(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail7("INVALID_FROZEN_ENGINE", `${label} must be non-empty`);
  }
  const parsed = value.map((entry, index) => {
    const item = record6(entry, `${label}[${index}]`);
    exactKeys5(item, ["byte_length", "relative_path", "sha256"], `${label}[${index}]`);
    return {
      relative_path: canonicalRelative(item.relative_path, `${label}[${index}].relative_path`),
      byte_length: nonNegativeInteger4(item.byte_length, `${label}[${index}].byte_length`),
      sha256: digest4(item.sha256, `${label}[${index}].sha256`)
    };
  });
  const sorted = [...parsed].sort((left, right) => left.relative_path < right.relative_path ? -1 : left.relative_path > right.relative_path ? 1 : 0);
  if (canonicalWalmartItemReportJson(parsed) !== canonicalWalmartItemReportJson(sorted) || new Set(parsed.map((entry) => entry.relative_path)).size !== parsed.length) {
    fail7("INVALID_FROZEN_ENGINE", `${label} must be sorted and unique`);
  }
  return parsed;
}
async function verifyFrozenEngine(manifestBytes, manifestSha256, bundleBytes, bundleSha256, environment) {
  const manifest = parseCanonicalJson2(manifestBytes, "frozen engine manifest");
  exactKeys5(manifest, [
    "build",
    "bundle",
    "certification_files",
    "certification_files_sha256",
    "capture",
    "entrypoint",
    "external_runtime_imports",
    "policy_id",
    "project_root_realpath_sha256",
    "runtime",
    "schema_version",
    "source_inputs",
    "source_inputs_sha256"
  ], "frozen engine manifest");
  if (manifest.schema_version !== WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENGINE_SCHEMA || manifest.policy_id !== WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENGINE_POLICY) {
    fail7("INVALID_FROZEN_ENGINE", "frozen engine schema/policy is not the executor release");
  }
  if (sha2565(manifestBytes) !== manifestSha256 || sha2565(bundleBytes) !== bundleSha256) {
    fail7("ARTIFACT_HASH_MISMATCH", "frozen engine bytes drifted");
  }
  digest4(manifest.project_root_realpath_sha256, "project_root_realpath_sha256");
  const bundle = record6(manifest.bundle, "frozen engine bundle");
  exactKeys5(bundle, ["byte_length", "file_name", "sha256"], "frozen engine bundle");
  if (bundle.file_name !== WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE || positiveInteger6(bundle.byte_length, "bundle.byte_length") !== bundleBytes.byteLength || digest4(bundle.sha256, "bundle.sha256") !== bundleSha256) {
    fail7("INVALID_FROZEN_ENGINE", "frozen executor bundle binding differs");
  }
  const entrypoint = record6(manifest.entrypoint, "frozen engine entrypoint");
  exactKeys5(entrypoint, [
    "argument_style",
    "bundle_file_name",
    "command",
    "exact_argv_order",
    "source_relative_path"
  ], "frozen engine entrypoint");
  if (entrypoint.source_relative_path !== WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_ENTRYPOINT || entrypoint.bundle_file_name !== WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE || entrypoint.command !== "execute-create" || entrypoint.argument_style !== "--name=value" || !sameJson(
    entrypoint.exact_argv_order,
    WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_EXACT_ARGV_ORDER
  )) {
    fail7("INVALID_FROZEN_ENGINE", "frozen engine is not the exact execute-create entrypoint");
  }
  const sourceInputs = parseHashedInventory(manifest.source_inputs, "source_inputs");
  if (digest4(manifest.source_inputs_sha256, "source_inputs_sha256") !== sha2565(Buffer.from(canonicalWalmartItemReportJson(sourceInputs), "utf8")) || REQUIRED_ENGINE_SOURCE_INPUTS.some((required) => !sourceInputs.some(
    (entry) => entry.relative_path === required
  ))) {
    fail7("INVALID_FROZEN_ENGINE", "frozen engine source closure is incomplete");
  }
  if (!Array.isArray(manifest.certification_files) || manifest.certification_files.length === 0) {
    fail7("INVALID_FROZEN_ENGINE", "frozen engine certification inventory is empty");
  }
  const certifications = manifest.certification_files.map((entry, index) => {
    const item = record6(entry, `certification_files[${index}]`);
    exactKeys5(
      item,
      ["byte_length", "relative_path", "role", "sha256"],
      `certification_files[${index}]`
    );
    return {
      relative_path: canonicalRelative(item.relative_path, `certification_files[${index}].relative_path`),
      byte_length: nonNegativeInteger4(item.byte_length, `certification_files[${index}].byte_length`),
      role: exactString8(item.role, `certification_files[${index}].role`, 128),
      sha256: digest4(item.sha256, `certification_files[${index}].sha256`)
    };
  });
  const sortedCertifications = [...certifications].sort((left, right) => left.role < right.role ? -1 : left.role > right.role ? 1 : left.relative_path < right.relative_path ? -1 : left.relative_path > right.relative_path ? 1 : 0);
  if (digest4(manifest.certification_files_sha256, "certification_files_sha256") !== sha2565(Buffer.from(canonicalWalmartItemReportJson(certifications), "utf8")) || !sameJson(certifications, sortedCertifications) || new Set(certifications.map((entry) => entry.role)).size !== certifications.length || certifications.length !== Object.keys(REQUIRED_CERTIFICATION_BINDINGS).length || certifications.some((entry) => REQUIRED_CERTIFICATION_BINDINGS[entry.role] !== entry.relative_path)) {
    fail7("INVALID_FROZEN_ENGINE", "frozen executor certification binding is incomplete");
  }
  const capture = record6(manifest.capture, "frozen engine capture binding");
  exactKeys5(capture, [
    "canonical_root",
    "canonical_root_realpath_sha256",
    "continuation_entrypoint",
    "continuation_phases",
    "request_phase_retired_outside_this_executor"
  ], "frozen engine capture binding");
  const canonicalCaptureRoot = exactAbsolute(capture.canonical_root, "capture.canonical_root");
  if (digest4(capture.canonical_root_realpath_sha256, "capture root path SHA-256") !== sha2565(Buffer.from(canonicalCaptureRoot, "utf8")) || capture.continuation_entrypoint !== CONTINUATION_ENTRYPOINT || !sameJson(capture.continuation_phases, CONTINUATION_PHASES) || capture.request_phase_retired_outside_this_executor !== true) {
    fail7("INVALID_FROZEN_ENGINE", "frozen capture/continuation binding is invalid");
  }
  const runtime = record6(manifest.runtime, "frozen engine runtime");
  exactKeys5(runtime, [
    "arch",
    "exec_path_artifact_sha256",
    "exec_path_realpath_sha256",
    "node_options_required",
    "node_path_required",
    "node_version",
    "platform",
    "required_exec_argv"
  ], "frozen engine runtime");
  const nodePath = await realpath4(process.execPath).catch(() => {
    fail7("INVALID_FROZEN_ENGINE", "Node executable realpath cannot be resolved");
  });
  const nodeArtifact = await readStableRuntimeFile(nodePath, "Node executable", {
    single_link: false
  });
  if (runtime.node_version !== process.version || runtime.platform !== process.platform || runtime.arch !== process.arch || digest4(runtime.exec_path_realpath_sha256, "runtime executable path SHA-256") !== sha2565(Buffer.from(nodePath, "utf8")) || digest4(runtime.exec_path_artifact_sha256, "runtime executable artifact SHA-256") !== sha2565(nodeArtifact) || !sameJson(runtime.required_exec_argv, []) || runtime.node_options_required !== "ABSENT" || runtime.node_path_required !== "ABSENT") {
    fail7("INVALID_FROZEN_ENGINE", "frozen executor runtime differs from the current runtime");
  }
  const build = record6(manifest.build, "frozen engine build");
  exactKeys5(build, [
    "bundle",
    "charset",
    "esbuild_version",
    "external_policy",
    "format",
    "legal_comments",
    "metafile",
    "packages",
    "platform",
    "sourcemap",
    "tool",
    "tree_shaking",
    "write"
  ], "frozen engine build");
  if (build.tool !== "esbuild" || typeof build.esbuild_version !== "string" || build.esbuild_version.length === 0 || build.bundle !== true || build.packages !== "bundle" || build.platform !== "node" || build.format !== "esm" || build.sourcemap !== false || build.metafile !== true || build.write !== false || build.legal_comments !== "none" || build.charset !== "utf8" || build.tree_shaking !== false || build.external_policy !== "NODE_BUILTINS_ONLY") {
    fail7("INVALID_FROZEN_ENGINE", "frozen executor build contract is invalid");
  }
  if (!Array.isArray(manifest.external_runtime_imports) || manifest.external_runtime_imports.length === 0 || manifest.external_runtime_imports.some((entry) => typeof entry !== "string" || !/^node:[a-z0-9_./-]+$/u.test(entry) || !NODE_BUILTIN_SPECIFIERS.has(entry)) || !sameJson(
    manifest.external_runtime_imports,
    [...manifest.external_runtime_imports].sort()
  ) || new Set(manifest.external_runtime_imports).size !== manifest.external_runtime_imports.length) {
    fail7("INVALID_FROZEN_ENGINE", "frozen executor external runtime closure is invalid");
  }
  if (environment === "PRODUCTION") {
    if (process.execArgv.length !== 0 || Object.prototype.hasOwnProperty.call(process.env, "NODE_OPTIONS") || Object.prototype.hasOwnProperty.call(process.env, "NODE_PATH")) {
      fail7("INVALID_RUNTIME", "production frozen executor requires an unmodified Node runtime");
    }
    const invoked = exactAbsolute(process.argv[1], "loaded frozen executor path");
    const loadedModulePath = await realpath4(LOADED_EXECUTOR_MODULE_PATH).catch(() => null);
    if (loadedModulePath !== invoked || path4.basename(invoked) !== WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE || await realpath4(invoked).catch(() => null) !== invoked) {
      fail7(
        "LOADED_CODE_BINDING_MISMATCH",
        "currently executing module is not the exact frozen bundle entrypoint"
      );
    }
    const loadedBytes = await readStableRuntimeFile(invoked, "loaded frozen executor", {
      exact_mode: FILE_MODE2,
      single_link: true
    });
    if (sha2565(loadedBytes) !== bundleSha256 || !Buffer.from(loadedBytes).equals(Buffer.from(bundleBytes))) {
      fail7("LOADED_CODE_BINDING_MISMATCH", "loaded executor bytes differ from signed frozen bytes");
    }
  }
  return { canonical_capture_root: canonicalCaptureRoot };
}
function nowDate(now) {
  const value = now?.() ?? /* @__PURE__ */ new Date();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail7("INVALID_CLOCK", "executor clock is invalid");
  }
  return new Date(value.getTime());
}
function assertFullExecutionHeadroom(disposition, now) {
  const effectiveDeadline = assertWalmartItemReportReissueAuthorizationCurrent(
    disposition,
    now
  );
  if (Date.parse(effectiveDeadline) - now.getTime() < WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_PRE_BURN_HEADROOM_MS) {
    fail7(
      "INSUFFICIENT_AUTHORIZATION_HEADROOM",
      "authorization must retain the full request timeout plus safety margin"
    );
  }
  return effectiveDeadline;
}
function normalizeDarwinAlias(value) {
  if (process.platform !== "darwin") return value;
  for (const [alias, canonical] of [["/tmp", "/private/tmp"], ["/var", "/private/var"]]) {
    if (value === alias || value.startsWith(`${alias}/`)) {
      return `${canonical}${value.slice(alias.length)}`;
    }
  }
  return value;
}
function exactAbsolute(value, label) {
  const parsed = exactString8(value, label);
  if (!path4.isAbsolute(parsed) || path4.normalize(parsed) !== parsed || parsed.includes("\0")) {
    fail7("INVALID_PATH", `${label} must be an exact normalized absolute path`);
  }
  return normalizeDarwinAlias(parsed);
}
function requiredNoFollowFlag2() {
  if (typeof fsConstants4.O_NOFOLLOW !== "number") {
    fail7("UNSUPPORTED_PLATFORM", "O_NOFOLLOW is required for executor custody");
  }
  return fsConstants4.O_NOFOLLOW;
}
function requiredDirectoryFlag2() {
  if (typeof fsConstants4.O_DIRECTORY !== "number") {
    fail7("UNSUPPORTED_PLATFORM", "O_DIRECTORY is required for executor custody");
  }
  return fsConstants4.O_DIRECTORY;
}
function sameFsIdentity(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}
function sameStableFileStat2(left, right) {
  return sameFsIdentity(left, right) && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function sameStableRuntimeStat(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino) && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
async function readStableRuntimeFile(absolutePath, label, options = {}) {
  const before = await lstat4(absolutePath).catch(() => {
    fail7("INVALID_FROZEN_ENGINE", `${label} is missing`);
  });
  if (!before.isFile() || before.isSymbolicLink() || options.single_link !== false && before.nlink !== 1 || options.exact_mode !== void 0 && (before.mode & 511) !== options.exact_mode || await realpath4(absolutePath).catch(() => null) !== absolutePath) {
    fail7("INVALID_FROZEN_ENGINE", `${label} does not have stable regular-file custody`);
  }
  const handle = await open4(absolutePath, fsConstants4.O_RDONLY | requiredNoFollowFlag2());
  try {
    const opened = await handle.stat();
    if (!sameStableRuntimeStat(before, opened)) {
      fail7("INVALID_FROZEN_ENGINE", `${label} raced before descriptor read`);
    }
    const bytes = await handle.readFile();
    const afterHandle = await handle.stat();
    const afterPath = await lstat4(absolutePath);
    if (!sameStableRuntimeStat(opened, afterHandle) || !sameStableRuntimeStat(afterHandle, afterPath) || bytes.byteLength !== afterHandle.size) {
      fail7("INVALID_FROZEN_ENGINE", `${label} raced during descriptor read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}
function sameDirectoryCustody(left, right) {
  return left.path === right.path && left.canonical_path === right.canonical_path && left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode;
}
async function inspectPrivateDirectory(directory, label) {
  const pathBefore = await lstat4(directory, { bigint: true }).catch(() => {
    fail7("INVALID_PATH", `${label} does not exist`);
  });
  const canonicalBefore = await realpath4(directory).catch(() => {
    fail7("INVALID_PATH", `${label} realpath cannot be resolved`);
  });
  if (!pathBefore.isDirectory() || pathBefore.isSymbolicLink() || Number(pathBefore.mode & 0o777n) !== DIRECTORY_MODE2 || canonicalBefore !== directory) {
    fail7("INVALID_PATH", `${label} must be one private real 0700 directory`);
  }
  const handle = await open4(
    directory,
    fsConstants4.O_RDONLY | requiredNoFollowFlag2() | requiredDirectoryFlag2()
  ).catch(() => {
    fail7("INVALID_PATH", `${label} cannot be opened without following links`);
  });
  let opened;
  try {
    opened = await handle.stat({ bigint: true });
  } finally {
    await handle.close();
  }
  const pathAfter = await lstat4(directory, { bigint: true }).catch(() => {
    fail7("INVALID_PATH", `${label} changed while inspected`);
  });
  const canonicalAfter = await realpath4(directory).catch(() => {
    fail7("INVALID_PATH", `${label} realpath changed while inspected`);
  });
  if (!opened.isDirectory() || !sameFsIdentity(pathBefore, opened) || !sameFsIdentity(opened, pathAfter) || Number(opened.mode & 0o777n) !== DIRECTORY_MODE2 || Number(pathAfter.mode & 0o777n) !== DIRECTORY_MODE2 || canonicalAfter !== canonicalBefore || typeof process.getuid === "function" && opened.uid !== BigInt(process.getuid())) {
    fail7("INVALID_PATH", `${label} identity, ownership, or mode is unstable`);
  }
  return {
    path: directory,
    canonical_path: canonicalAfter,
    dev: String(opened.dev),
    ino: String(opened.ino),
    uid: String(opened.uid),
    gid: String(opened.gid),
    mode: Number(opened.mode & 0o777n)
  };
}
async function assertDirectoryCustody(expected, label) {
  if (!sameDirectoryCustody(expected, await inspectPrivateDirectory(expected.path, label))) {
    fail7("INVALID_PATH", `${label} identity changed`);
  }
}
function rawSignedBody(value) {
  return record6(value.signed_body, "owner disposition signed_body");
}
function expectedReplacementFromRawDisposition(value) {
  const body = rawSignedBody(value);
  const replacement = record6(body.replacement, "owner disposition replacement");
  return buildWalmartItemReportReissueReplacementPlanV2({
    session_name: exactString8(replacement.session_name, "replacement.session_name", 200),
    session_authority: replacement.session_authority
  });
}
function expectedLedgerFromRawDisposition(value) {
  const body = rawSignedBody(value);
  return record6(
    body.consumption_ledger,
    "owner disposition consumption_ledger"
  );
}
function exactAccount(input, environment) {
  const storeIndex = positiveInteger6(input.store_index, "active_account.store_index");
  const sellerId = exactString8(input.seller_id, "active_account.seller_id", 256);
  const clientId = exactString8(input.client_id, "active_account.client_id", 512);
  const computed = computeWalmartSellerAccountFingerprint({
    store_index: storeIndex,
    client_id: clientId,
    seller_id: sellerId
  });
  let fingerprint = computed;
  if (input.test_only_seller_account_fingerprint_sha256 !== void 0) {
    if (environment !== "TEST_FIXTURE_ONLY") {
      fail7("TEST_OVERRIDE_FORBIDDEN", "account fingerprint override is forbidden in production");
    }
    fingerprint = digest4(
      input.test_only_seller_account_fingerprint_sha256,
      "active_account.test_only_seller_account_fingerprint_sha256"
    );
  }
  return {
    channel: "WALMART_US",
    store_index: storeIndex,
    seller_id: sellerId,
    seller_account_fingerprint_sha256: fingerprint
  };
}
function sameJson(left, right) {
  return canonicalWalmartItemReportJson(left) === canonicalWalmartItemReportJson(right);
}
function verifyExecutionAuthorization(raw, options) {
  if (raw.schema_version === WALMART_ITEM_REPORT_REISSUE_DELEGATED_AUTHORIZATION_V1_SCHEMA) {
    return verifyWalmartItemReportReissueDelegatedAuthorizationV1(raw, options);
  }
  return verifyWalmartItemReportReissueOwnerDispositionV2(raw, options);
}
async function prepareWalmartItemReportReissueExecutorV2(input, now) {
  const engineManifest = snapshotArtifact(input.frozen_engine_manifest, "frozen engine manifest");
  const frozenBundle = snapshotArtifact(input.frozen_bundle, "frozen bundle");
  const sourceEvidence = snapshotArtifact(input.source_evidence, "source evidence");
  const ownerArtifact = snapshotArtifact(input.owner_disposition, "owner disposition");
  const rawDisposition = parseCanonicalJson2(ownerArtifact.bytes, "owner disposition");
  const environment = input.expected_environment ?? "PRODUCTION";
  const frozenEngine = await verifyFrozenEngine(
    engineManifest.bytes,
    engineManifest.sha256,
    frozenBundle.bytes,
    frozenBundle.sha256,
    environment
  );
  const expectedReplacement2 = expectedReplacementFromRawDisposition(rawDisposition);
  const signedLedger = expectedLedgerFromRawDisposition(rawDisposition);
  const firstVerification = verifyExecutionAuthorization(
    rawDisposition,
    {
      expected_environment: environment,
      env: input.owner_trust_env,
      expected_engine_release_sha256: engineManifest.sha256,
      expected_source_evidence_bytes: sourceEvidence.bytes,
      expected_source_evidence_artifact_sha256: sourceEvidence.sha256,
      expected_replacement: expectedReplacement2,
      expected_consumption_ledger: signedLedger,
      now
    }
  );
  const ledgerDirectory = exactAbsolute(
    input.ledger_state_directory,
    "ledger_state_directory"
  );
  const ledger = await openWalmartItemReportReissueConsumptionLedgerV2({
    state_directory: ledgerDirectory,
    expected_binding: firstVerification.signed_body.consumption_ledger
  });
  const actualLedger = ledger.binding;
  const disposition = verifyExecutionAuthorization(
    rawDisposition,
    {
      expected_environment: environment,
      env: input.owner_trust_env,
      expected_engine_release_sha256: engineManifest.sha256,
      expected_source_evidence_bytes: sourceEvidence.bytes,
      expected_source_evidence_artifact_sha256: sourceEvidence.sha256,
      expected_replacement: expectedReplacement2,
      expected_consumption_ledger: actualLedger,
      now
    }
  );
  if (ledger.authorizations.some(
    (entry) => entry.authorization_sha256 === disposition.authorization_sha256
  )) {
    fail7(
      "AUTHORIZATION_ALREADY_CONSUMED",
      "signed authorization is already claimed, requesting, or terminal"
    );
  }
  const effectiveDeadline = assertFullExecutionHeadroom(disposition, now);
  const activeAccount = exactAccount(input.active_account, environment);
  if (!sameJson(disposition.signed_body.account_scope, activeAccount) || !sameJson(disposition.signed_body.replacement.session_authority.account_scope, {
    channel: activeAccount.channel,
    store_index: activeAccount.store_index,
    seller_account_fingerprint_sha256: activeAccount.seller_account_fingerprint_sha256
  })) {
    fail7("ACCOUNT_BINDING_MISMATCH", "active credentials differ from signed account scope");
  }
  const authorization = record6(disposition.signed_body.authorization, "authorization");
  if (authorization.request_body_sha256 !== void 0 || authorization.report_create_post_authorized !== true || authorization.pre_create_absence_guard_required !== true || authorization.same_oauth_transport_required !== true || authorization.maximum_request_timeout_ms !== WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_TIMEOUT_MS || authorization.maximum_oauth_token_calls !== 1 || authorization.maximum_create_post_calls !== 1 || authorization.maximum_walmart_report_api_calls_before_create !== 2 || authorization.maximum_total_http_calls_before_create !== 3 || authorization.maximum_total_http_calls !== 22 || authorization.retry_attempts_allowed !== 0 || authorization.redirects_followed_allowed !== 0 || authorization.original_session_writes_allowed !== 0 || authorization.database_calls_allowed !== 0 || authorization.model_calls_allowed !== 0 || authorization.paid_provider_calls_allowed !== 0 || authorization.listing_content_writes_allowed !== 0 || !sameJson(authorization.absence_guard, {
    method: "GET",
    endpoint: "/v3/reports/reportRequests",
    query: ABSENCE_GUARD_QUERY,
    exact_zero_results_required: true,
    next_cursor_forbidden: true
  }) || !sameJson(authorization.create_request, {
    method: "POST",
    endpoint: "/v3/reports/reportRequests",
    report_type: "ITEM",
    report_version: "v6",
    request_body_sha256: WALMART_ITEM_REPORT_REISSUE_OWNER_DISPOSITION_V2_EMPTY_BODY_SHA256
  }) || !sameJson(authorization.continuation, {
    same_oauth_transport_required: true,
    polling_authorized: true,
    maximum_poll_observations: 9,
    poll_interval_ms: 18e4,
    download_locator_calls_maximum: 1,
    presigned_download_calls_maximum: 9,
    compile_network_calls_maximum: 0
  })) {
    fail7("AUTHORIZATION_POLICY_MISMATCH", "owner authorization is not exact one-shot policy");
  }
  const captureRoot = exactAbsolute(input.capture_root, "capture_root");
  if (captureRoot !== frozenEngine.canonical_capture_root) {
    fail7(
      "NON_CANONICAL_CAPTURE_ROOT",
      "replacement session must use the exact capture root sealed in the frozen manifest"
    );
  }
  const captureRootCustody = await inspectPrivateDirectory(captureRoot, "capture_root");
  const replacementName = disposition.signed_body.replacement.session_name;
  if (replacementName === "." || replacementName === ".." || replacementName.includes("/") || replacementName.includes("\\") || path4.basename(replacementName) !== replacementName) {
    fail7("INVALID_REPLACEMENT", "replacement session must be one direct child");
  }
  const sessionDirectory = path4.join(captureRoot, replacementName);
  const found = await lstat4(sessionDirectory).then(() => true).catch((error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (found) fail7("REPLACEMENT_SESSION_EXISTS", "replacement session path already exists");
  if (replacementName === disposition.signed_body.prior_incident.session_name) {
    fail7("ORIGINAL_SESSION_ALIAS", "replacement may not alias the quarantined session");
  }
  const preflight = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_PREFLIGHT_SCHEMA,
    policy_id: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_POLICY,
    status: "READY_FOR_IRREVERSIBLE_SINGLE_EXECUTION",
    engine_manifest_artifact_sha256: engineManifest.sha256,
    frozen_bundle_artifact_sha256: frozenBundle.sha256,
    source_evidence_artifact_sha256: sourceEvidence.sha256,
    owner_disposition_artifact_sha256: ownerArtifact.sha256,
    authorization_sha256: disposition.authorization_sha256,
    effective_deadline: effectiveDeadline,
    account_scope: activeAccount,
    replacement: disposition.signed_body.replacement,
    consumption_ledger: disposition.signed_body.consumption_ledger,
    ledger_state_directory: ledgerDirectory,
    replacement_session_directory: sessionDirectory,
    request: {
      guard: {
        method: "GET",
        endpoint: "/v3/reports/reportRequests",
        query: ABSENCE_GUARD_QUERY,
        exact_zero_results_required: true
      },
      create: {
        method: "POST",
        endpoint: "/v3/reports/reportRequests",
        query: { reportType: "ITEM", reportVersion: "v6" },
        body_sha256: sha2565(CREATE_BODY2)
      },
      same_oauth_transport_required: true,
      timeout_ms_maximum: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_TIMEOUT_MS,
      redirects: 0,
      retries: 0
    },
    external_effects: {
      filesystem_writes: 0,
      ledger_writes: 0,
      oauth_token_calls: 0,
      walmart_api_calls: 0,
      database_calls: 0,
      model_calls: 0,
      paid_provider_calls: 0,
      listing_content_writes: 0,
      prior_session_writes: 0
    },
    next_action: {
      kind: "IRREVERSIBLE_EXECUTE",
      authorization_will_be_burned_before_oauth: true,
      automatic_retry_allowed: false
    }
  };
  return {
    preflight,
    disposition,
    owner_disposition_bytes: ownerArtifact.bytes,
    capture_root: captureRoot,
    capture_root_custody: captureRootCustody
  };
}
async function preflightWalmartItemReportReissueExecutorV2(input, options = {}) {
  const now = options.now ?? /* @__PURE__ */ new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail7("INVALID_CLOCK", "preflight clock is invalid");
  }
  return (await prepareWalmartItemReportReissueExecutorV2(input, now)).preflight;
}
async function syncDirectory(directory, expected) {
  const custody = expected ?? await inspectPrivateDirectory(directory, "directory to sync");
  if (custody.path !== directory) fail7("INVALID_PATH", "directory sync custody path differs");
  await assertDirectoryCustody(custody, "directory to sync");
  const handle = await open4(
    directory,
    fsConstants4.O_RDONLY | requiredNoFollowFlag2() | requiredDirectoryFlag2()
  );
  try {
    const info = await handle.stat({ bigint: true });
    if (String(info.dev) !== custody.dev || String(info.ino) !== custody.ino || Number(info.mode & 0o777n) !== DIRECTORY_MODE2) {
      fail7("INVALID_PATH", "directory changed before fsync");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertDirectoryCustody(custody, "directory after sync");
  return custody;
}
async function writeExclusive(sessionDirectory, relativePath, bytes, dependencies) {
  if (relativePath.includes("\\") || path4.posix.normalize(relativePath) !== relativePath || relativePath.startsWith("../") || path4.posix.isAbsolute(relativePath)) {
    fail7("INVALID_PATH", "immutable output path is not canonical session-relative");
  }
  const target = path4.join(sessionDirectory, relativePath);
  const sessionCustody = await inspectPrivateDirectory(sessionDirectory, "replacement session");
  const parent = path4.dirname(target);
  const parentCustody = await inspectPrivateDirectory(parent, "immutable output parent");
  const relativeToSession = path4.relative(sessionDirectory, target);
  if (relativeToSession.startsWith(`..${path4.sep}`) || relativeToSession === ".." || path4.isAbsolute(relativeToSession)) {
    fail7("INVALID_PATH", "immutable output escapes replacement session");
  }
  const handle = await open4(
    target,
    fsConstants4.O_RDWR | fsConstants4.O_CREAT | fsConstants4.O_EXCL | requiredNoFollowFlag2(),
    FILE_MODE2
  );
  let writtenStat;
  try {
    await handle.writeFile(bytes);
    await handle.chmod(FILE_MODE2);
    writtenStat = await handle.stat();
    if (!writtenStat.isFile() || writtenStat.nlink !== 1 || (writtenStat.mode & 511) !== FILE_MODE2 || writtenStat.size !== bytes.byteLength) {
      fail7("INVALID_PATH", "immutable output descriptor custody is invalid");
    }
    const retained = Buffer.alloc(bytes.byteLength);
    if (retained.byteLength > 0) {
      const read = await handle.read(retained, 0, retained.byteLength, 0);
      if (read.bytesRead !== retained.byteLength) {
        fail7("INVALID_PATH", "immutable output could not be read back completely");
      }
    }
    if (!retained.equals(Buffer.from(bytes))) {
      fail7("INVALID_PATH", "immutable output bytes differ on descriptor read-back");
    }
    await handle.sync();
    const afterSync = await handle.stat();
    if (!sameStableFileStat2(writtenStat, afterSync)) {
      fail7("INVALID_PATH", "immutable output changed during fsync");
    }
    writtenStat = afterSync;
  } finally {
    await handle.close();
  }
  const pathStat = await lstat4(target);
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1 || !sameFsIdentity(writtenStat, pathStat) || (pathStat.mode & 511) !== FILE_MODE2 || await realpath4(target) !== target) {
    fail7("INVALID_PATH", "immutable output path custody differs from descriptor");
  }
  await assertDirectoryCustody(parentCustody, "immutable output parent");
  await assertDirectoryCustody(sessionCustody, "replacement session");
  await syncDirectory(parent, parentCustody);
  await dependencies.after_immutable_write?.(relativePath);
  const verifyHandle = await open4(target, fsConstants4.O_RDONLY | requiredNoFollowFlag2());
  try {
    const verifyBefore = await verifyHandle.stat();
    if (!sameStableFileStat2(writtenStat, verifyBefore) || verifyBefore.nlink !== 1 || (verifyBefore.mode & 511) !== FILE_MODE2) {
      fail7("INVALID_PATH", "immutable output changed after durable write");
    }
    const retained = await verifyHandle.readFile();
    const verifyAfter = await verifyHandle.stat();
    if (!sameStableFileStat2(verifyBefore, verifyAfter) || !retained.equals(Buffer.from(bytes))) {
      fail7("INVALID_PATH", "immutable output bytes changed after durable write");
    }
  } finally {
    await verifyHandle.close();
  }
  await assertDirectoryCustody(parentCustody, "immutable output parent");
  await assertDirectoryCustody(sessionCustody, "replacement session");
}
async function writeExclusiveJson(sessionDirectory, relativePath, value, dependencies) {
  await writeExclusive(
    sessionDirectory,
    relativePath,
    Buffer.from(canonicalWalmartItemReportJson(value), "utf8"),
    dependencies
  );
}
async function verifyImmutableSessionArtifact(sessionDirectory, relativePath, expectedBytes) {
  const target = path4.join(sessionDirectory, relativePath);
  const before = await lstat4(target).catch(() => {
    fail7("FINAL_ARTIFACT_REVERIFY_FAILED", `${relativePath} disappeared before final verification`);
  });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 511) !== FILE_MODE2 || await realpath4(target).catch(() => null) !== target || typeof process.getuid === "function" && before.uid !== process.getuid()) {
    fail7("FINAL_ARTIFACT_REVERIFY_FAILED", `${relativePath} lost immutable file custody`);
  }
  const handle = await open4(target, fsConstants4.O_RDONLY | requiredNoFollowFlag2());
  try {
    const opened = await handle.stat();
    if (!sameStableFileStat2(before, opened)) {
      fail7("FINAL_ARTIFACT_REVERIFY_FAILED", `${relativePath} raced before final read`);
    }
    const bytes = await handle.readFile();
    const afterHandle = await handle.stat();
    const afterPath = await lstat4(target);
    if (!sameStableFileStat2(opened, afterHandle) || !sameStableFileStat2(afterHandle, afterPath) || !bytes.equals(expectedBytes)) {
      fail7("FINAL_ARTIFACT_REVERIFY_FAILED", `${relativePath} bytes or identity drifted`);
    }
  } finally {
    await handle.close();
  }
}
async function verifyCompleteReplacementSession(prepared, created) {
  await assertDirectoryCustody(prepared.capture_root_custody, "capture_root final verification");
  await assertDirectoryCustody(created.sessionCustody, "replacement session final verification");
  const expectedByDirectory = /* @__PURE__ */ new Map();
  for (const relativePath of created.expectedArtifacts.keys()) {
    const directory = path4.posix.dirname(relativePath);
    const names = expectedByDirectory.get(directory) ?? [];
    names.push(path4.posix.basename(relativePath));
    expectedByDirectory.set(directory, names);
  }
  for (const directory of ["capture", "checkpoints", "trusted", "sanitized"]) {
    const custody = created.directoryCustodies.get(directory);
    if (!custody) fail7("FINAL_ARTIFACT_REVERIFY_FAILED", `missing ${directory} custody binding`);
    await assertDirectoryCustody(custody, `${directory} final verification`);
    const absolute = path4.join(created.sessionDirectory, directory);
    const beforeNames = (await readdir4(absolute)).sort();
    const expectedNames = (expectedByDirectory.get(directory) ?? []).sort();
    if (!sameJson(beforeNames, expectedNames)) {
      fail7("FINAL_ARTIFACT_REVERIFY_FAILED", `${directory} inventory differs at final verification`);
    }
    for (const name of expectedNames) {
      const relativePath = `${directory}/${name}`;
      const expectedBytes = created.expectedArtifacts.get(relativePath);
      if (!expectedBytes) fail7("FINAL_ARTIFACT_REVERIFY_FAILED", `${relativePath} binding is missing`);
      await verifyImmutableSessionArtifact(created.sessionDirectory, relativePath, expectedBytes);
    }
    const afterNames = (await readdir4(absolute)).sort();
    if (!sameJson(beforeNames, afterNames)) {
      fail7("FINAL_ARTIFACT_REVERIFY_FAILED", `${directory} inventory raced during final verification`);
    }
    await assertDirectoryCustody(custody, `${directory} after final verification`);
  }
  await assertDirectoryCustody(created.sessionCustody, "replacement session after final verification");
  await assertDirectoryCustody(prepared.capture_root_custody, "capture_root after final verification");
}
async function createReplacementSession(prepared, consumptionReceipt, reservedAt, dependencies) {
  const sessionDirectory = prepared.preflight.replacement_session_directory;
  await assertDirectoryCustody(prepared.capture_root_custody, "capture_root before mkdir");
  await mkdir3(sessionDirectory, { mode: DIRECTORY_MODE2 });
  const sessionCustody = await inspectPrivateDirectory(sessionDirectory, "replacement session");
  await assertDirectoryCustody(prepared.capture_root_custody, "capture_root after mkdir");
  const directoryCustodies = /* @__PURE__ */ new Map();
  for (const child of ["capture", "checkpoints", "trusted", "sanitized"]) {
    const childPath = path4.join(sessionDirectory, child);
    await mkdir3(childPath, { mode: DIRECTORY_MODE2 });
    directoryCustodies.set(
      child,
      await inspectPrivateDirectory(childPath, `replacement ${child} directory`)
    );
    await assertDirectoryCustody(sessionCustody, "replacement session while creating children");
  }
  const receiptBytes = Buffer.from(canonicalWalmartItemReportJson(consumptionReceipt), "utf8");
  const receiptSha256 = sha2565(receiptBytes);
  const expectedArtifacts = /* @__PURE__ */ new Map();
  const sessionAuthorityBytes = Buffer.from(canonicalWalmartItemReportJson(
    prepared.disposition.signed_body.replacement.session_authority
  ), "utf8");
  const requestManifestBytes = Buffer.from(canonicalWalmartItemReportJson(
    prepared.disposition.signed_body.replacement.create_request_manifest
  ), "utf8");
  const requestReservedBytes = Buffer.from(canonicalWalmartItemReportJson({
    schema_version: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_CHECKPOINT_SCHEMA,
    phase: "request",
    state: "REQUESTING",
    observed_at: reservedAt,
    attempt: 1,
    post_attempt_limit: 1,
    retry_forbidden: true,
    authorization_sha256: prepared.disposition.authorization_sha256,
    consumption_receipt_sha256: receiptSha256,
    request_manifest_sha256: prepared.disposition.signed_body.replacement.create_request_manifest_sha256,
    request_correlation_id_sha256: prepared.disposition.signed_body.replacement.create_request_correlation_id_sha256,
    authorization_consumed_before_oauth: true
  }), "utf8");
  await writeExclusiveJson(
    sessionDirectory,
    "trusted/00-session-authority.json",
    prepared.disposition.signed_body.replacement.session_authority,
    dependencies
  );
  expectedArtifacts.set("trusted/00-session-authority.json", sessionAuthorityBytes);
  await writeExclusive(
    sessionDirectory,
    "trusted/01-owner-disposition.json",
    prepared.owner_disposition_bytes,
    dependencies
  );
  expectedArtifacts.set("trusted/01-owner-disposition.json", prepared.owner_disposition_bytes);
  await writeExclusive(
    sessionDirectory,
    "trusted/02-consumption-receipt.json",
    receiptBytes,
    dependencies
  );
  expectedArtifacts.set("trusted/02-consumption-receipt.json", receiptBytes);
  await writeExclusiveJson(
    sessionDirectory,
    "capture/10-create-request-manifest.json",
    prepared.disposition.signed_body.replacement.create_request_manifest,
    dependencies
  );
  expectedArtifacts.set("capture/10-create-request-manifest.json", requestManifestBytes);
  await writeExclusive(
    sessionDirectory,
    "checkpoints/10-request-reserved.json",
    requestReservedBytes,
    dependencies
  );
  expectedArtifacts.set("checkpoints/10-request-reserved.json", requestReservedBytes);
  for (const child of ["capture", "checkpoints", "trusted", "sanitized"]) {
    await syncDirectory(path4.join(sessionDirectory, child));
  }
  await syncDirectory(sessionDirectory, sessionCustody);
  await syncDirectory(prepared.capture_root, prepared.capture_root_custody);
  return {
    sessionDirectory,
    receiptSha256,
    sessionCustody,
    directoryCustodies,
    expectedArtifacts
  };
}
function zeroCounts(counts) {
  return counts.oauth_token_calls === 0 && counts.walmart_api_calls === 0 && counts.presigned_file_calls === 0 && counts.total_http_calls === 0;
}
function validCounts(counts) {
  return Number.isSafeInteger(counts.oauth_token_calls) && counts.oauth_token_calls >= 0 && Number.isSafeInteger(counts.walmart_api_calls) && counts.walmart_api_calls >= 0 && Number.isSafeInteger(counts.presigned_file_calls) && counts.presigned_file_calls >= 0 && Number.isSafeInteger(counts.total_http_calls) && counts.total_http_calls >= 0 && counts.total_http_calls === counts.oauth_token_calls + counts.walmart_api_calls + counts.presigned_file_calls;
}
function assertTransportAccountBinding(transport, expected) {
  if (typeof transport.get_account_binding !== "function") {
    fail7("INVALID_TRANSPORT", "transport must expose its credential-derived account binding");
  }
  const raw = record6(transport.get_account_binding(), "transport account binding");
  exactKeys5(raw, [
    "channel",
    "seller_account_fingerprint_sha256",
    "seller_id",
    "store_index"
  ], "transport account binding");
  const parsed = {
    channel: raw.channel === "WALMART_US" ? "WALMART_US" : fail7("TRANSPORT_ACCOUNT_BINDING_MISMATCH", "transport channel differs"),
    store_index: positiveInteger6(raw.store_index, "transport account store_index"),
    seller_id: exactString8(raw.seller_id, "transport account seller_id", 256),
    seller_account_fingerprint_sha256: digest4(
      raw.seller_account_fingerprint_sha256,
      "transport account fingerprint"
    )
  };
  if (!sameJson(parsed, expected)) {
    fail7(
      "TRANSPORT_ACCOUNT_BINDING_MISMATCH",
      "transport OAuth credentials differ from the signed active account"
    );
  }
}
function assertUnusedTransport(transport, expectedAccount) {
  if (!transport || typeof transport.send !== "function" || typeof transport.get_http_call_counts !== "function" || typeof transport.get_account_binding !== "function") {
    fail7("INVALID_TRANSPORT", "open_transport must return the exact metered transport contract");
  }
  assertTransportAccountBinding(transport, expectedAccount);
  const counts = transport.get_http_call_counts();
  if (!validCounts(counts) || !zeroCounts(counts)) {
    fail7("TRANSPORT_ALREADY_USED", "executor requires a fresh transport with zero calls");
  }
}
function validateResponse(response, expectedCorrelationSha256) {
  if (!isRecord10(response) || !Number.isSafeInteger(response.status) || Number(response.status) < 100 || Number(response.status) > 599 || !isRecord10(response.headers) || !(response.body instanceof Uint8Array) || response.body.byteLength > WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_RESPONSE_BYTES || Object.values(response.headers).some((value) => typeof value !== "string")) {
    fail7("INVALID_HTTP_RESPONSE", "transport returned an invalid bounded response");
  }
  const length = Object.entries(response.headers).find(
    ([name]) => name.toLowerCase() === "content-length"
  )?.[1];
  if (length !== void 0 && (!/^(?:0|[1-9]\d*)$/u.test(length) || Number(length) !== response.body.byteLength)) {
    fail7("INVALID_HTTP_RESPONSE", "response Content-Length differs from exact bytes");
  }
  const headerValues2 = (names) => {
    const accepted = new Set(names.map((name) => name.toLowerCase()));
    return Object.entries(response.headers).filter(([name]) => accepted.has(name.toLowerCase())).map(([, value]) => exactString8(value, "HTTP response header", 8192));
  };
  const optionalHeader = (names, label) => {
    const values = headerValues2(names);
    if (new Set(values).size > 1) {
      fail7("INVALID_HTTP_RESPONSE", `${label} response headers conflict`);
    }
    return values[0] ?? null;
  };
  const contentEncoding = optionalHeader(["content-encoding"], "Content-Encoding");
  if (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity") {
    fail7("INVALID_HTTP_RESPONSE", "non-identity response encoding is forbidden");
  }
  const contentType = optionalHeader(["content-type"], "Content-Type");
  const echoedCorrelation = optionalHeader(
    ["wm_qos.correlation_id", "wm-qos-correlation-id"],
    "correlation ID"
  );
  if (echoedCorrelation !== null && walmartItemReportUtf8Sha256(echoedCorrelation) !== expectedCorrelationSha256) {
    fail7("INVALID_HTTP_RESPONSE", "echoed correlation differs from signed request");
  }
  const echoedReportRequest = optionalHeader(
    ["wm_qos.report_request_id", "wm-report-request-id"],
    "report request ID"
  );
  return {
    body: new Uint8Array(response.body),
    http: {
      status: response.status,
      content_type: contentType,
      content_length: length === void 0 ? null : Number(length),
      echoed_correlation_id_sha256: echoedCorrelation === null ? null : walmartItemReportUtf8Sha256(echoedCorrelation),
      echoed_report_request_id_sha256: echoedReportRequest === null ? null : walmartItemReportUtf8Sha256(echoedReportRequest)
    }
  };
}
function replacementRequestId(bytes) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail7("INVALID_CREATE_RESPONSE", "replacement create response is not UTF-8 JSON");
  }
  const raw = record6(value, "replacement create response");
  const requestId = exactString8(raw.requestId, "replacement create requestId", 512);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(requestId)) {
    fail7("INVALID_CREATE_RESPONSE", "replacement requestId has unsafe characters");
  }
  return requestId;
}
async function terminalManualReview(sessionDirectory, reasonCode, observedAt, authorizationSha256, dependencies, details = {}, ledgerTerminal) {
  let terminalizationErrorCode = null;
  if (ledgerTerminal !== void 0) {
    try {
      const terminalAt = new Date(Math.max(
        Date.parse(observedAt),
        Date.parse(ledgerTerminal.requesting.requesting_at)
      )).toISOString();
      let settled = false;
      let lastError = null;
      for (let attempt = 0; attempt < 2 && !settled; attempt += 1) {
        try {
          await terminalizeWalmartItemReportReissueAuthorizationV2({
            state_directory: ledgerTerminal.state_directory,
            expected_binding: ledgerTerminal.expected_binding,
            requesting: ledgerTerminal.requesting,
            outcome: {
              state: ledgerTerminal.state,
              terminal_at: terminalAt,
              http_status: ledgerTerminal.http_status,
              response_body_sha256: ledgerTerminal.response_body_sha256,
              report_request_id_sha256: ledgerTerminal.report_request_id_sha256,
              error_code: reasonCode
            }
          });
          settled = true;
        } catch (error) {
          lastError = error;
          const snapshot = await openWalmartItemReportReissueConsumptionLedgerV2({
            state_directory: ledgerTerminal.state_directory,
            expected_binding: ledgerTerminal.expected_binding
          }).catch(() => null);
          const durable = snapshot?.authorizations.find(
            (entry) => entry.authorization_sha256 === ledgerTerminal.requesting.authorization_sha256
          );
          if (durable && (/* @__PURE__ */ new Set(["SUCCEEDED", "AMBIGUOUS", "FAILED"])).has(durable.state)) {
            settled = true;
          } else if (!durable || durable.state !== "REQUESTING") {
            break;
          }
        }
      }
      if (!settled) throw lastError ?? new Error("ledger terminal outcome is missing");
    } catch (error) {
      terminalizationErrorCode = typeof error?.code === "string" ? String(error.code) : "LEDGER_TERMINALIZATION_FAILED";
    }
  }
  if (sessionDirectory !== null) {
    await writeExclusiveJson(
      sessionDirectory,
      "checkpoints/19-request-manual-review.json",
      {
        schema_version: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_CHECKPOINT_SCHEMA,
        phase: "request",
        state: "MANUAL_REVIEW",
        observed_at: observedAt,
        reason_code: reasonCode,
        retry_forbidden: true,
        authorization_sha256: authorizationSha256,
        authorization_consumed: true,
        consumption_ledger_terminalization_error_code: terminalizationErrorCode,
        ...details
      },
      dependencies
    ).catch(() => {
    });
  }
  throw new WalmartItemReportReissueExecutorV2ManualReviewError(
    reasonCode,
    sessionDirectory,
    "replacement POST outcome is terminal/manual-review; authorization cannot be replayed"
  );
}
function ledgerTerminalInput(prepared, requesting, state, httpStatus = null, responseBodySha256 = null, reportRequestIdSha256 = null) {
  return {
    state_directory: prepared.preflight.ledger_state_directory,
    expected_binding: prepared.preflight.consumption_ledger,
    requesting,
    state,
    http_status: httpStatus,
    response_body_sha256: responseBodySha256,
    report_request_id_sha256: reportRequestIdSha256
  };
}
async function terminalizeSucceeded(prepared, requesting, terminalAt, httpStatus, responseBodySha256, reportRequestIdSha256) {
  await terminalizeWalmartItemReportReissueAuthorizationV2({
    state_directory: prepared.preflight.ledger_state_directory,
    expected_binding: prepared.preflight.consumption_ledger,
    requesting,
    outcome: {
      state: "SUCCEEDED",
      terminal_at: terminalAt,
      http_status: httpStatus,
      response_body_sha256: responseBodySha256,
      report_request_id_sha256: reportRequestIdSha256,
      error_code: null
    }
  });
}
async function sendOnePost(transport, correlationId) {
  const controller = new AbortController();
  let timeoutHandle;
  const timeout = new Promise((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new WalmartItemReportReissueExecutorV2Error(
        "REQUEST_TIMEOUT",
        "replacement POST exceeded its one-shot deadline"
      ));
    }, WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_TIMEOUT_MS);
  });
  const request = {
    kind: "walmart-api",
    method: "POST",
    endpoint: "/v3/reports/reportRequests",
    query: { reportType: "ITEM", reportVersion: "v6" },
    url: null,
    headers: {
      accept: "application/json",
      "accept-encoding": "identity",
      "content-type": "application/json"
    },
    body: CREATE_BODY2,
    correlation_id: correlationId,
    redirect: "manual",
    max_response_bytes: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_RESPONSE_BYTES,
    max_redirect_response_bytes: 64 * 1024,
    timeout_ms: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_TIMEOUT_MS,
    signal: controller.signal
  };
  try {
    return await Promise.race([transport.send(request), timeout]);
  } finally {
    if (timeoutHandle !== void 0) clearTimeout(timeoutHandle);
  }
}
async function sendOneAbsenceGuardGet(transport, correlationId) {
  const controller = new AbortController();
  let timeoutHandle;
  const timeout = new Promise((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new WalmartItemReportReissueExecutorV2Error(
        "REQUEST_TIMEOUT",
        "pre-create absence guard exceeded its one-shot deadline"
      ));
    }, WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_TIMEOUT_MS);
  });
  const request = {
    kind: "walmart-api",
    method: "GET",
    endpoint: "/v3/reports/reportRequests",
    query: { ...ABSENCE_GUARD_QUERY },
    url: null,
    headers: {
      accept: "application/json",
      "accept-encoding": "identity"
    },
    body: null,
    correlation_id: correlationId,
    redirect: "manual",
    max_response_bytes: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_RESPONSE_BYTES,
    max_redirect_response_bytes: 64 * 1024,
    timeout_ms: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_TIMEOUT_MS,
    signal: controller.signal
  };
  try {
    return await Promise.race([transport.send(request), timeout]);
  } finally {
    if (timeoutHandle !== void 0) clearTimeout(timeoutHandle);
  }
}
function exactGuardAbsence(bytes, http) {
  if (http.status !== 200 || typeof http.content_type !== "string" || !/^application\/json(?:\s*;|$)/iu.test(http.content_type)) {
    fail7("INVALID_GUARD_RESPONSE", "pre-create absence guard must return HTTP 200 JSON");
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail7("INVALID_GUARD_RESPONSE", "pre-create absence guard body is not UTF-8 JSON");
  }
  const raw = record6(parsed, "pre-create absence guard response");
  if (raw.page !== 1 || !Number.isSafeInteger(raw.totalCount) || Number(raw.totalCount) < 0 || !Number.isSafeInteger(raw.limit) || Number(raw.limit) < 0 || !Array.isArray(raw.requests)) {
    fail7("INVALID_GUARD_RESPONSE", "pre-create absence guard response shape is invalid");
  }
  const nextCursorPresent = typeof raw.nextCursor === "string" && raw.nextCursor.length > 0;
  return {
    absence: raw.totalCount === 0 && raw.requests.length === 0 && !nextCursorPresent,
    page: 1,
    total_count: Number(raw.totalCount),
    limit: Number(raw.limit),
    request_count: raw.requests.length,
    next_cursor_present: nextCursorPresent
  };
}
async function executePreCreateAbsenceGuard(prepared, created, transport, consumptionReceipt, dependencies) {
  const uuid = dependencies.random_uuid ?? randomUUID3;
  const correlationId = exactString8(uuid(), "pre-create guard correlation ID", 128);
  const correlationSha256 = walmartItemReportUtf8Sha256(correlationId);
  const reservedAt = nowDate(dependencies.now).toISOString();
  const requestManifest = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_CHECKPOINT_SCHEMA,
    phase: "pre_create_absence_guard",
    method: "GET",
    endpoint: "/v3/reports/reportRequests",
    query: { ...ABSENCE_GUARD_QUERY },
    request_correlation_id_sha256: correlationSha256,
    exact_zero_results_required: true,
    next_cursor_forbidden: true,
    retries: 0,
    redirects: 0
  };
  const requestManifestBytes = Buffer.from(
    canonicalWalmartItemReportJson(requestManifest),
    "utf8"
  );
  const reservation = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_CHECKPOINT_SCHEMA,
    phase: "pre_create_absence_guard",
    state: "RESERVED",
    observed_at: reservedAt,
    authorization_sha256: prepared.preflight.authorization_sha256,
    request_manifest_sha256: sha2565(requestManifestBytes),
    request_correlation_id_sha256: correlationSha256,
    same_transport_as_create_required: true,
    retry_forbidden: true
  };
  await writeExclusive(
    created.sessionDirectory,
    "capture/05-pre-create-guard-request.json",
    requestManifestBytes,
    dependencies
  );
  created.expectedArtifacts.set(
    "capture/05-pre-create-guard-request.json",
    requestManifestBytes
  );
  const reservationBytes = Buffer.from(canonicalWalmartItemReportJson(reservation), "utf8");
  await writeExclusive(
    created.sessionDirectory,
    "checkpoints/05-pre-create-guard-reserved.json",
    reservationBytes,
    dependencies
  );
  created.expectedArtifacts.set(
    "checkpoints/05-pre-create-guard-reserved.json",
    reservationBytes
  );
  let rawResponse;
  try {
    rawResponse = await sendOneAbsenceGuardGet(transport, correlationId);
  } catch {
    return terminalManualReview(
      created.sessionDirectory,
      "PRE_CREATE_GUARD_NETWORK_OUTCOME_AMBIGUOUS",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      { create_post_calls: 0 },
      ledgerTerminalInput(prepared, consumptionReceipt, "FAILED")
    );
  }
  const rawBytes = Buffer.from(rawResponse.body);
  await writeExclusive(
    created.sessionDirectory,
    "capture/06-pre-create-guard-response.bin",
    rawBytes,
    dependencies
  );
  created.expectedArtifacts.set(
    "capture/06-pre-create-guard-response.bin",
    rawBytes
  );
  let captured;
  let guard;
  try {
    captured = validateResponse(rawResponse, correlationSha256);
    guard = exactGuardAbsence(captured.body, captured.http);
  } catch {
    return terminalManualReview(
      created.sessionDirectory,
      "PRE_CREATE_GUARD_RESPONSE_INVALID",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {
        create_post_calls: 0,
        response_body_sha256: sha2565(rawBytes)
      },
      ledgerTerminalInput(prepared, consumptionReceipt, "FAILED")
    );
  }
  const httpBytes = Buffer.from(canonicalWalmartItemReportJson(captured.http), "utf8");
  await writeExclusive(
    created.sessionDirectory,
    "capture/07-pre-create-guard-response-http.json",
    httpBytes,
    dependencies
  );
  created.expectedArtifacts.set(
    "capture/07-pre-create-guard-response-http.json",
    httpBytes
  );
  const exchangeSeal2 = {
    policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
    sha256: walmartItemReportTrustedExchangeSha256({
      request_manifest_bytes: requestManifestBytes,
      request_correlation_id_sha256: correlationSha256,
      response_payload_bytes: captured.body,
      http: captured.http
    })
  };
  const sealBytes = Buffer.from(canonicalWalmartItemReportJson(exchangeSeal2), "utf8");
  await writeExclusive(
    created.sessionDirectory,
    "trusted/08-pre-create-guard-exchange-seal.json",
    sealBytes,
    dependencies
  );
  created.expectedArtifacts.set(
    "trusted/08-pre-create-guard-exchange-seal.json",
    sealBytes
  );
  const completed = {
    schema_version: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_CHECKPOINT_SCHEMA,
    phase: "pre_create_absence_guard",
    state: guard.absence ? "ABSENCE_CONFIRMED" : "CREATE_FORBIDDEN",
    observed_at: nowDate(dependencies.now).toISOString(),
    authorization_sha256: prepared.preflight.authorization_sha256,
    request_manifest_sha256: sha2565(requestManifestBytes),
    response_body_sha256: sha2565(captured.body),
    response_http_sha256: sha2565(httpBytes),
    exchange_seal_sha256: sha2565(sealBytes),
    result: guard,
    create_post_calls: 0,
    retry_forbidden: true
  };
  const completedBytes = Buffer.from(canonicalWalmartItemReportJson(completed), "utf8");
  await writeExclusive(
    created.sessionDirectory,
    "checkpoints/09-pre-create-guard-complete.json",
    completedBytes,
    dependencies
  );
  created.expectedArtifacts.set(
    "checkpoints/09-pre-create-guard-complete.json",
    completedBytes
  );
  const counts = transport.get_http_call_counts();
  if (!validCounts(counts) || counts.oauth_token_calls !== 1 || counts.walmart_api_calls !== 1 || counts.presigned_file_calls !== 0 || counts.total_http_calls !== 2) {
    return terminalManualReview(
      created.sessionDirectory,
      "PRE_CREATE_GUARD_HTTP_ACCOUNTING_VIOLATION",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      { create_post_calls: 0 },
      ledgerTerminalInput(prepared, consumptionReceipt, "FAILED")
    );
  }
  if (!guard.absence) {
    return terminalManualReview(
      created.sessionDirectory,
      "PRE_CREATE_GUARD_NOT_ABSENT",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {
        create_post_calls: 0,
        total_count: guard.total_count,
        request_count: guard.request_count,
        next_cursor_present: guard.next_cursor_present
      },
      ledgerTerminalInput(prepared, consumptionReceipt, "FAILED")
    );
  }
}
async function completeReportWithSameOauthTransport(prepared, transport, dependencies) {
  if (dependencies.complete_report !== true) return { status: "REQUESTED" };
  const phaseInput = (phase) => ({
    execute: true,
    phase,
    store_index: prepared.preflight.account_scope.store_index,
    session_dir: prepared.preflight.replacement_session_directory,
    allowed_capture_root: prepared.capture_root
  });
  const phaseDependencies = {
    transport,
    account_scope: {
      channel: "WALMART_US",
      store_index: prepared.preflight.account_scope.store_index,
      seller_account_fingerprint_sha256: prepared.preflight.account_scope.seller_account_fingerprint_sha256
    },
    random_uuid: dependencies.random_uuid ?? randomUUID3,
    now: dependencies.now,
    request_timeout_ms: WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_MAX_TIMEOUT_MS
  };
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  try {
    let ready = false;
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const before = transport.get_http_call_counts();
      if (!validCounts(before) || before.oauth_token_calls !== 1 || before.walmart_api_calls !== attempt + 1 || before.presigned_file_calls !== 0 || before.total_http_calls !== attempt + 2) {
        fail7("CONTINUATION_HTTP_ACCOUNTING_VIOLATION", "poll accounting drifted");
      }
      const result = await runWalmartItemReportCapturePhase(
        phaseInput("poll"),
        phaseDependencies
      );
      if (result.mode !== "EXECUTED") {
        fail7("CONTINUATION_STATE_INVALID", "poll did not execute");
      }
      if (result.state === "READY") {
        ready = true;
        break;
      }
      if (attempt < 9) await sleep(18e4);
    }
    if (!ready) {
      return {
        status: "REQUESTED_REPORT_INCOMPLETE",
        continuation_error_code: "POLL_OBSERVATION_BUDGET_EXHAUSTED"
      };
    }
    const downloaded = await runWalmartItemReportCapturePhase(
      phaseInput("download"),
      phaseDependencies
    );
    if (downloaded.mode !== "EXECUTED" || downloaded.state !== "DOWNLOADED") {
      fail7("CONTINUATION_STATE_INVALID", "download did not complete");
    }
    const compiled = await runWalmartItemReportCapturePhase(
      phaseInput("compile"),
      phaseDependencies
    );
    if (compiled.mode !== "EXECUTED" || compiled.state !== "COMPILED" || typeof compiled.sanitized_source_path !== "string" || typeof compiled.sanitized_source_sha256 !== "string" || typeof compiled.sanitized_catalog_source_path !== "string" || typeof compiled.sanitized_catalog_source_sha256 !== "string" || typeof compiled.catalog_source_id !== "string" || typeof compiled.catalog_source_body_sha256 !== "string") {
      fail7("CONTINUATION_STATE_INVALID", "compile did not produce exact source bindings");
    }
    const finalCounts = transport.get_http_call_counts();
    if (!validCounts(finalCounts) || finalCounts.oauth_token_calls !== 1 || finalCounts.walmart_api_calls > 63 || finalCounts.presigned_file_calls > 9 || finalCounts.total_http_calls > 22) {
      fail7("CONTINUATION_HTTP_ACCOUNTING_VIOLATION", "continuation exceeded owner bounds");
    }
    return {
      status: "COMPILED",
      sanitized_source_path: compiled.sanitized_source_path,
      sanitized_source_sha256: compiled.sanitized_source_sha256,
      sanitized_catalog_source_path: compiled.sanitized_catalog_source_path,
      sanitized_catalog_source_sha256: compiled.sanitized_catalog_source_sha256,
      catalog_source_id: compiled.catalog_source_id,
      catalog_source_body_sha256: compiled.catalog_source_body_sha256
    };
  } catch (error) {
    return {
      status: "REQUESTED_REPORT_INCOMPLETE",
      continuation_error_code: typeof error?.code === "string" ? String(error.code) : "CONTINUATION_FAILED"
    };
  }
}
async function executeWalmartItemReportReissueExecutorV2(input, dependencies) {
  if (!dependencies || typeof dependencies.open_transport !== "function") {
    fail7("INVALID_DEPENDENCIES", "open_transport dependency is required");
  }
  const initialNow = nowDate(dependencies.now);
  const prepared = await prepareWalmartItemReportReissueExecutorV2(input, initialNow);
  const consumptionReceipt = await consumeWalmartItemReportReissueAuthorizationV2({
    state_directory: prepared.preflight.ledger_state_directory,
    expected_binding: prepared.preflight.consumption_ledger,
    authorization_sha256: prepared.preflight.authorization_sha256,
    claimed_at: initialNow,
    requesting_at: initialNow
  });
  const requestingAt = nowDate(dependencies.now);
  let sessionDirectory = prepared.preflight.replacement_session_directory;
  let createdSession = null;
  try {
    const created = await createReplacementSession(
      prepared,
      consumptionReceipt,
      requestingAt.toISOString(),
      dependencies
    );
    createdSession = created;
    sessionDirectory = created.sessionDirectory;
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "LOCAL_SESSION_PREPARATION_FAILED_AFTER_AUTHORIZATION_BURN",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {},
      ledgerTerminalInput(prepared, consumptionReceipt, "FAILED")
    );
  }
  try {
    assertFullExecutionHeadroom(
      prepared.disposition,
      nowDate(dependencies.now)
    );
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "AUTHORIZATION_HEADROOM_LOST_AFTER_BURN",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {},
      ledgerTerminalInput(prepared, consumptionReceipt, "FAILED")
    );
  }
  let transport;
  try {
    transport = dependencies.open_transport();
    assertUnusedTransport(transport, prepared.preflight.account_scope);
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "TRANSPORT_INITIALIZATION_FAILED_AFTER_AUTHORIZATION_BURN",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {},
      ledgerTerminalInput(prepared, consumptionReceipt, "FAILED")
    );
  }
  try {
    assertFullExecutionHeadroom(prepared.disposition, nowDate(dependencies.now));
    assertTransportAccountBinding(transport, prepared.preflight.account_scope);
    const counts = transport.get_http_call_counts();
    if (!validCounts(counts) || !zeroCounts(counts)) {
      fail7("TRANSPORT_ALREADY_USED", "transport changed before the one-shot send boundary");
    }
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "FINAL_PRE_OAUTH_GATE_FAILED",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {},
      ledgerTerminalInput(prepared, consumptionReceipt, "FAILED")
    );
  }
  if (!createdSession) {
    return terminalManualReview(
      sessionDirectory,
      "INVALID_STATE_BEFORE_PRE_CREATE_GUARD",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      { create_post_calls: 0 },
      ledgerTerminalInput(prepared, consumptionReceipt, "FAILED")
    );
  }
  await executePreCreateAbsenceGuard(
    prepared,
    createdSession,
    transport,
    consumptionReceipt,
    dependencies
  );
  try {
    assertFullExecutionHeadroom(prepared.disposition, nowDate(dependencies.now));
    assertTransportAccountBinding(transport, prepared.preflight.account_scope);
    const counts = transport.get_http_call_counts();
    if (!validCounts(counts) || counts.oauth_token_calls !== 1 || counts.walmart_api_calls !== 1 || counts.presigned_file_calls !== 0 || counts.total_http_calls !== 2) {
      fail7(
        "PRE_CREATE_GUARD_ACCOUNTING_DRIFT",
        "transport changed after the exact absence guard"
      );
    }
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "FINAL_PRE_CREATE_GATE_FAILED",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      { create_post_calls: 0 },
      ledgerTerminalInput(prepared, consumptionReceipt, "FAILED")
    );
  }
  let rawResponse;
  try {
    rawResponse = await sendOnePost(
      transport,
      prepared.disposition.signed_body.replacement.session_authority.primary_correlations.create.id
    );
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "AMBIGUOUS_POST_NETWORK_OUTCOME",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {},
      ledgerTerminalInput(prepared, consumptionReceipt, "AMBIGUOUS")
    );
  }
  let calls;
  try {
    calls = transport.get_http_call_counts();
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "HTTP_CALL_ACCOUNTING_UNAVAILABLE",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {},
      ledgerTerminalInput(prepared, consumptionReceipt, "AMBIGUOUS")
    );
  }
  if (!validCounts(calls) || calls.oauth_token_calls !== 1 || calls.walmart_api_calls !== 2 || calls.presigned_file_calls !== 0 || calls.total_http_calls !== 3) {
    return terminalManualReview(
      sessionDirectory,
      "HTTP_CALL_ACCOUNTING_VIOLATION",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {},
      ledgerTerminalInput(prepared, consumptionReceipt, "AMBIGUOUS")
    );
  }
  let response;
  try {
    response = validateResponse(
      rawResponse,
      prepared.disposition.signed_body.replacement.create_request_correlation_id_sha256
    );
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "POST_RESPONSE_CAPTURE_INVALID",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {},
      ledgerTerminalInput(prepared, consumptionReceipt, "AMBIGUOUS")
    );
  }
  const observedAt = nowDate(dependencies.now).toISOString();
  const responseBytes = Buffer.from(response.body);
  const responseSha256 = sha2565(responseBytes);
  const http = response.http;
  const httpSha256 = walmartItemReportSha256(http);
  const requestManifestBytes = Buffer.from(canonicalWalmartItemReportJson(
    prepared.disposition.signed_body.replacement.create_request_manifest
  ), "utf8");
  const exchangeSeal2 = responseBytes.byteLength === 0 ? null : {
    policy_id: WALMART_ITEM_REPORT_TRUSTED_EXCHANGE_POLICY_ID,
    sha256: walmartItemReportTrustedExchangeSha256({
      request_manifest_bytes: requestManifestBytes,
      request_correlation_id_sha256: prepared.disposition.signed_body.replacement.create_request_correlation_id_sha256,
      response_payload_bytes: responseBytes,
      http
    })
  };
  try {
    await writeExclusive(
      sessionDirectory,
      "capture/11-create-response.bin",
      responseBytes,
      dependencies
    );
    await writeExclusiveJson(
      sessionDirectory,
      "capture/12-create-response-http.json",
      http,
      dependencies
    );
    if (exchangeSeal2 !== null) {
      await writeExclusiveJson(
        sessionDirectory,
        "trusted/13-create-exchange-seal.json",
        exchangeSeal2,
        dependencies
      );
    }
    await syncDirectory(path4.join(sessionDirectory, "capture"));
    await syncDirectory(path4.join(sessionDirectory, "trusted"));
    await syncDirectory(sessionDirectory);
    if (!createdSession) fail7("INVALID_STATE", "replacement session binding is missing");
    createdSession.expectedArtifacts.set("capture/11-create-response.bin", responseBytes);
    createdSession.expectedArtifacts.set(
      "capture/12-create-response-http.json",
      Buffer.from(canonicalWalmartItemReportJson(http), "utf8")
    );
    if (exchangeSeal2 !== null) {
      createdSession.expectedArtifacts.set(
        "trusted/13-create-exchange-seal.json",
        Buffer.from(canonicalWalmartItemReportJson(exchangeSeal2), "utf8")
      );
    }
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "POST_RESPONSE_PERSISTENCE_FAILED",
      observedAt,
      prepared.preflight.authorization_sha256,
      dependencies,
      { http_status: http.status, response_body_sha256: responseSha256, response_http_sha256: httpSha256 },
      ledgerTerminalInput(
        prepared,
        consumptionReceipt,
        "AMBIGUOUS",
        http.status,
        responseSha256
      )
    );
  }
  if (http.status !== 200 && http.status !== 201) {
    return terminalManualReview(
      sessionDirectory,
      "POST_HTTP_FAILURE",
      observedAt,
      prepared.preflight.authorization_sha256,
      dependencies,
      { http_status: http.status, response_body_sha256: responseSha256 },
      ledgerTerminalInput(
        prepared,
        consumptionReceipt,
        "FAILED",
        http.status,
        responseSha256
      )
    );
  }
  let requestId;
  try {
    requestId = replacementRequestId(response.body);
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "POST_RESPONSE_REQUEST_ID_INVALID",
      observedAt,
      prepared.preflight.authorization_sha256,
      dependencies,
      { http_status: http.status, response_body_sha256: responseSha256 },
      ledgerTerminalInput(
        prepared,
        consumptionReceipt,
        "AMBIGUOUS",
        http.status,
        responseSha256
      )
    );
  }
  const requestIdSha256 = walmartItemReportUtf8Sha256(requestId);
  try {
    await terminalizeSucceeded(
      prepared,
      consumptionReceipt,
      observedAt,
      http.status,
      responseSha256,
      requestIdSha256
    );
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "LEDGER_SUCCESS_TERMINALIZATION_FAILED",
      observedAt,
      prepared.preflight.authorization_sha256,
      dependencies,
      {
        http_status: http.status,
        response_body_sha256: responseSha256,
        report_request_id_sha256: requestIdSha256
      },
      ledgerTerminalInput(
        prepared,
        consumptionReceipt,
        "AMBIGUOUS",
        http.status,
        responseSha256,
        requestIdSha256
      )
    );
  }
  const completeCheckpoint = {
    schema_version: WALMART_ITEM_REPORT_CAPTURE_CHECKPOINT_SCHEMA,
    phase: "request",
    state: "COMPLETE",
    observed_at: observedAt,
    request_id: requestId,
    request_id_sha256: requestIdSha256,
    request_id_origin: "REPLACEMENT_POST_RESPONSE_ONLY",
    original_request_id_adopted: false,
    retry_forbidden: true,
    authorization_sha256: prepared.preflight.authorization_sha256,
    request_manifest_path: "capture/10-create-request-manifest.json",
    response_body_path: "capture/11-create-response.bin",
    response_http_path: "capture/12-create-response-http.json",
    exchange_seal_path: "trusted/13-create-exchange-seal.json"
  };
  const completeCheckpointBytes = Buffer.from(
    canonicalWalmartItemReportJson(completeCheckpoint),
    "utf8"
  );
  try {
    await writeExclusive(
      sessionDirectory,
      "checkpoints/19-request-complete.json",
      completeCheckpointBytes,
      dependencies
    );
    if (!createdSession) fail7("INVALID_STATE", "replacement session binding is missing");
    createdSession.expectedArtifacts.set(
      "checkpoints/19-request-complete.json",
      completeCheckpointBytes
    );
    await syncDirectory(path4.join(sessionDirectory, "checkpoints"));
    await syncDirectory(sessionDirectory);
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "REQUEST_COMPLETE_PERSISTENCE_FAILED",
      observedAt,
      prepared.preflight.authorization_sha256,
      dependencies,
      {
        http_status: http.status,
        response_body_sha256: responseSha256,
        report_request_id_sha256: requestIdSha256,
        consumption_ledger_state: "SUCCEEDED"
      }
    );
  }
  try {
    if (!createdSession) fail7("INVALID_STATE", "replacement session binding is missing");
    await verifyCompleteReplacementSession(prepared, createdSession);
  } catch {
    return terminalManualReview(
      sessionDirectory,
      "FINAL_SESSION_REVERIFY_FAILED",
      nowDate(dependencies.now).toISOString(),
      prepared.preflight.authorization_sha256,
      dependencies,
      {
        http_status: http.status,
        response_body_sha256: responseSha256,
        report_request_id_sha256: requestIdSha256,
        consumption_ledger_state: "SUCCEEDED"
      }
    );
  }
  const continuation = await completeReportWithSameOauthTransport(
    prepared,
    transport,
    dependencies
  );
  const finalCalls = transport.get_http_call_counts();
  return {
    ...continuation,
    authorization_sha256: prepared.preflight.authorization_sha256,
    replacement_session_directory: sessionDirectory,
    request_id: requestId,
    request_id_sha256: requestIdSha256,
    http_status: http.status,
    http_calls: finalCalls,
    authorization_consumed_before_oauth: true,
    automatic_retry_allowed: false,
    prior_session_writes: 0,
    database_calls: 0,
    model_calls: 0,
    paid_provider_calls: 0,
    listing_content_writes: 0
  };
}

// scripts/capture-walmart-item-report-source.mjs
import { randomUUID as randomUUID4 } from "node:crypto";
import path5 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var SCRIPT_DIR = path5.dirname(fileURLToPath2(import.meta.url));
var DEFAULT_CAPTURE_ROOT = path5.resolve(
  SCRIPT_DIR,
  "../data/audits/walmart-source-captures"
);
var WALMART_API_ORIGIN = "https://marketplace.walmartapis.com";
var TOKEN_RESPONSE_CAP = 1024 * 1024;
var REDIRECT_STATUSES2 = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
var WALMART_ITEM_REPORT_REISSUE_V1_RETIRED_CODE = "WALMART_ITEM_REPORT_REISSUE_V1_RETIRED";
function throwRetiredReissueV1() {
  throw new WalmartItemReportCaptureError(
    WALMART_ITEM_REPORT_REISSUE_V1_RETIRED_CODE,
    "live ITEM report request is retired until a separately certified bound reissue release exists"
  );
}
function safeString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", `${label} is invalid`);
  }
  return value;
}
function positiveStoreIndex(value) {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--store-index must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--store-index is outside the safe range");
  }
  return parsed;
}
function exactSha256(value, label) {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new WalmartItemReportCaptureError(
      "INVALID_CLI_INPUT",
      `${label} must be a lowercase SHA-256 digest`
    );
  }
  return value;
}
function parseWalmartItemReportCaptureCliArgs(argv) {
  let execute = false;
  let phase = "request";
  let storeIndex = 1;
  let sessionDir = path5.join(DEFAULT_CAPTURE_ROOT, "PLAN-NOT-EXECUTED");
  let phaseProvided = false;
  let storeProvided = false;
  let sessionProvided = false;
  let ownerReissuePermitPath = null;
  let expectedOwnerReissueArtifactSha256 = null;
  let expectedOwnerReissuePermitSha256 = null;
  let expectedSourceEvidenceReleaseSha256 = null;
  let ownerReissueConfirmation = null;
  for (const argument of argv) {
    if (argument === "--execute") {
      if (execute) throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--execute was repeated");
      execute = true;
    } else if (argument.startsWith("--phase=")) {
      if (phaseProvided) throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--phase was repeated");
      phase = argument.slice("--phase=".length);
      phaseProvided = true;
    } else if (argument.startsWith("--store-index=")) {
      if (storeProvided) throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--store-index was repeated");
      storeIndex = positiveStoreIndex(argument.slice("--store-index=".length));
      storeProvided = true;
    } else if (argument.startsWith("--session-dir=")) {
      if (sessionProvided) throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--session-dir was repeated");
      const rawSessionDir = safeString(argument.slice("--session-dir=".length), "--session-dir");
      if (!path5.isAbsolute(rawSessionDir)) {
        throw new WalmartItemReportCaptureError(
          "INVALID_CLI_INPUT",
          "--session-dir must be an absolute path before normalization"
        );
      }
      sessionDir = path5.resolve(rawSessionDir);
      sessionProvided = true;
    } else if (argument.startsWith("--owner-reissue-permit=")) {
      if (ownerReissuePermitPath !== null) {
        throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--owner-reissue-permit was repeated");
      }
      const rawPath = safeString(argument.slice("--owner-reissue-permit=".length), "--owner-reissue-permit");
      if (!path5.isAbsolute(rawPath) || path5.normalize(rawPath) !== rawPath) {
        throw new WalmartItemReportCaptureError(
          "INVALID_CLI_INPUT",
          "--owner-reissue-permit must be an exact normalized absolute path"
        );
      }
      ownerReissuePermitPath = rawPath;
    } else if (argument.startsWith("--expect-owner-reissue-artifact-sha256=")) {
      if (expectedOwnerReissueArtifactSha256 !== null) {
        throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--expect-owner-reissue-artifact-sha256 was repeated");
      }
      expectedOwnerReissueArtifactSha256 = exactSha256(
        argument.slice("--expect-owner-reissue-artifact-sha256=".length),
        "--expect-owner-reissue-artifact-sha256"
      );
    } else if (argument.startsWith("--expect-owner-reissue-permit-sha256=")) {
      if (expectedOwnerReissuePermitSha256 !== null) {
        throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--expect-owner-reissue-permit-sha256 was repeated");
      }
      expectedOwnerReissuePermitSha256 = exactSha256(
        argument.slice("--expect-owner-reissue-permit-sha256=".length),
        "--expect-owner-reissue-permit-sha256"
      );
    } else if (argument.startsWith("--expect-source-evidence-release-sha256=")) {
      if (expectedSourceEvidenceReleaseSha256 !== null) {
        throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--expect-source-evidence-release-sha256 was repeated");
      }
      expectedSourceEvidenceReleaseSha256 = exactSha256(
        argument.slice("--expect-source-evidence-release-sha256=".length),
        "--expect-source-evidence-release-sha256"
      );
    } else if (argument.startsWith("--owner-reissue-confirmation=")) {
      if (ownerReissueConfirmation !== null) {
        throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--owner-reissue-confirmation was repeated");
      }
      ownerReissueConfirmation = safeString(
        argument.slice("--owner-reissue-confirmation=".length),
        "--owner-reissue-confirmation"
      );
    } else if (argument === "--help") {
      return {
        execute: false,
        phase: "request",
        store_index: 1,
        session_dir: path5.join(DEFAULT_CAPTURE_ROOT, "PLAN-NOT-EXECUTED"),
        allowed_capture_root: DEFAULT_CAPTURE_ROOT,
        owner_reissue_permit_path: null,
        expected_owner_reissue_artifact_sha256: null,
        expected_owner_reissue_permit_sha256: null,
        expected_source_evidence_release_sha256: null,
        owner_reissue_confirmation: null
      };
    } else {
      throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "unsupported CLI argument");
    }
  }
  if (!WALMART_ITEM_REPORT_CAPTURE_PHASES.includes(phase)) {
    throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "--phase is invalid");
  }
  if (execute && phase === "request") throwRetiredReissueV1();
  if (execute && (!phaseProvided || !storeProvided || !sessionProvided)) {
    throw new WalmartItemReportCaptureError(
      "LIVE_FLAGS_REQUIRED",
      "live execution requires explicit --phase, --store-index, and --session-dir"
    );
  }
  if (execute && !path5.isAbsolute(sessionDir)) {
    throw new WalmartItemReportCaptureError("INVALID_CLI_INPUT", "live --session-dir must be absolute");
  }
  const ownerPermitInputs = [
    ownerReissuePermitPath,
    expectedOwnerReissueArtifactSha256,
    expectedOwnerReissuePermitSha256,
    expectedSourceEvidenceReleaseSha256,
    ownerReissueConfirmation
  ];
  if (phase !== "request" && ownerPermitInputs.some((value) => value !== null)) {
    throw new WalmartItemReportCaptureError(
      "OWNER_REISSUE_FLAGS_PHASE_MISMATCH",
      "owner reissue flags are valid only with --phase=request"
    );
  }
  return {
    execute,
    phase,
    store_index: storeIndex,
    session_dir: sessionDir,
    allowed_capture_root: DEFAULT_CAPTURE_ROOT,
    owner_reissue_permit_path: ownerReissuePermitPath,
    expected_owner_reissue_artifact_sha256: expectedOwnerReissueArtifactSha256,
    expected_owner_reissue_permit_sha256: expectedOwnerReissuePermitSha256,
    expected_source_evidence_release_sha256: expectedSourceEvidenceReleaseSha256,
    owner_reissue_confirmation: ownerReissueConfirmation
  };
}
function abortable(promise, signal, onAbort = () => {
}) {
  if (signal.aborted) {
    onAbort();
    return Promise.reject(new WalmartItemReportCaptureError("REQUEST_TIMEOUT", "HTTP attempt deadline elapsed"));
  }
  return new Promise((resolve, reject) => {
    const aborted = () => {
      onAbort();
      reject(new WalmartItemReportCaptureError("REQUEST_TIMEOUT", "HTTP attempt deadline elapsed"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      }
    );
  });
}
async function readExactResponseBytes(response, maximumBytes, maximumRedirectBytes, signal) {
  const responseCap = REDIRECT_STATUSES2.has(response.status) ? Math.min(maximumBytes, maximumRedirectBytes) : maximumBytes;
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null && encoding.toLowerCase() !== "identity") {
    throw new WalmartItemReportCaptureError(
      "UNSUPPORTED_CONTENT_ENCODING",
      "server ignored Accept-Encoding: identity; exact wire-byte capture was refused"
    );
  }
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(rawLength) || Number(rawLength) > responseCap) {
      throw new WalmartItemReportCaptureError("RESPONSE_SIZE_CAP", "HTTP response exceeds its safety cap");
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal, () => {
        void reader.cancel().catch(() => {
        });
      });
      if (done) break;
      total += value.byteLength;
      if (total > responseCap) {
        await reader.cancel();
        throw new WalmartItemReportCaptureError("RESPONSE_SIZE_CAP", "streamed HTTP response exceeds safety cap");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (rawLength !== null && Number(rawLength) !== output.byteLength) {
    throw new WalmartItemReportCaptureError(
      "CONTENT_LENGTH_MISMATCH",
      "HTTP Content-Length does not match captured bytes"
    );
  }
  return output;
}
function responseHeaders(response) {
  const headers = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return headers;
}
function createWalmartItemReportCliTransport({
  credentials,
  fetch_impl = globalThis.fetch,
  random_uuid = randomUUID4,
  request_timeout_ms = WALMART_ITEM_REPORT_CAPTURE_DEFAULT_REQUEST_TIMEOUT_MS
}) {
  if (typeof fetch_impl !== "function") {
    throw new WalmartItemReportCaptureError("MISSING_FETCH", "native fetch is unavailable");
  }
  const clientId = safeString(credentials.client_id, "Walmart client ID");
  const clientSecret = safeString(credentials.client_secret, "Walmart client secret");
  if (!Number.isSafeInteger(request_timeout_ms) || request_timeout_ms < 1 || request_timeout_ms > WALMART_ITEM_REPORT_CAPTURE_MAX_REQUEST_TIMEOUT_MS) {
    throw new WalmartItemReportCaptureError("INVALID_REQUEST_TIMEOUT", "transport timeout is outside 1..60000 ms");
  }
  let accessToken = null;
  const counters = {
    oauth_token_calls: 0,
    walmart_api_calls: 0,
    presigned_file_calls: 0
  };
  const token = async (signal) => {
    if (accessToken !== null) return accessToken;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    let response;
    try {
      counters.oauth_token_calls += 1;
      response = await abortable(fetch_impl(`${WALMART_API_ORIGIN}/v3/token`, {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: `Basic ${basic}`,
          "wm_qos.correlation_id": random_uuid(),
          "wm_svc.name": "Walmart Marketplace",
          accept: "application/json",
          "accept-encoding": "identity",
          "content-type": "application/x-www-form-urlencoded"
        },
        body: "grant_type=client_credentials",
        signal
      }), signal);
    } catch (error) {
      if (error instanceof WalmartItemReportCaptureError && error.code === "REQUEST_TIMEOUT") throw error;
      throw new WalmartItemReportCaptureError("TOKEN_NETWORK_FAILURE", "Walmart token fetch failed");
    }
    const body = await readExactResponseBytes(
      response,
      TOKEN_RESPONSE_CAP,
      WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES,
      signal
    );
    if (response.status !== 200) {
      throw new WalmartItemReportCaptureError("TOKEN_HTTP_FAILURE", "Walmart token fetch returned non-200");
    }
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw new WalmartItemReportCaptureError("TOKEN_INVALID_RESPONSE", "Walmart token response is invalid");
    }
    accessToken = safeString(parsed.access_token, "Walmart access token");
    return accessToken;
  };
  return {
    get_http_call_counts() {
      return Object.freeze({
        ...counters,
        total_http_calls: counters.oauth_token_calls + counters.walmart_api_calls + counters.presigned_file_calls
      });
    },
    async send(request) {
      const requestedTimeout = request.timeout_ms ?? request_timeout_ms;
      if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 1 || requestedTimeout > WALMART_ITEM_REPORT_CAPTURE_MAX_REQUEST_TIMEOUT_MS) {
        throw new WalmartItemReportCaptureError("INVALID_REQUEST_TIMEOUT", "request timeout is outside 1..60000 ms");
      }
      const timeoutMs = Math.min(request_timeout_ms, requestedTimeout);
      const controller = new AbortController();
      const outerSignal = request.signal;
      const forwardAbort = () => controller.abort();
      outerSignal?.addEventListener("abort", forwardAbort, { once: true });
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let url;
        let headers;
        if (request.kind === "walmart-api") {
          if (request.url !== null || request.endpoint === null || request.correlation_id === null) {
            throw new WalmartItemReportCaptureError("INVALID_TRANSPORT_REQUEST", "Walmart API request is invalid");
          }
          const endpoint = safeString(request.endpoint, "Walmart endpoint");
          if (!endpoint.startsWith("/v3/") || endpoint.includes("..")) {
            throw new WalmartItemReportCaptureError("INVALID_TRANSPORT_REQUEST", "Walmart endpoint is not approved");
          }
          const parsedUrl = new URL(endpoint, WALMART_API_ORIGIN);
          for (const [name, value] of Object.entries(request.query)) parsedUrl.searchParams.append(name, value);
          url = parsedUrl.toString();
          const bearer = await token(controller.signal);
          headers = {
            ...request.headers,
            authorization: `Bearer ${bearer}`,
            "wm_sec.access_token": bearer,
            "wm_qos.correlation_id": request.correlation_id,
            "wm_svc.name": "Walmart Marketplace"
          };
        } else {
          if (request.endpoint !== null || request.url === null || request.correlation_id !== null) {
            throw new WalmartItemReportCaptureError("INVALID_TRANSPORT_REQUEST", "presigned request is invalid");
          }
          url = safeString(request.url, "presigned request URL");
          headers = { ...request.headers };
          const forbidden = Object.keys(headers).some((name) => ["authorization", "wm_sec.access_token", "wm_qos.correlation_id", "wm_svc.name"].includes(name.toLowerCase()));
          if (forbidden) {
            throw new WalmartItemReportCaptureError(
              "AUTH_HEADER_LEAK",
              "Walmart authorization headers must never be sent to a presigned report host"
            );
          }
        }
        if (headers["accept-encoding"] !== "identity") {
          throw new WalmartItemReportCaptureError(
            "IDENTITY_ENCODING_REQUIRED",
            "every capture request must send Accept-Encoding: identity"
          );
        }
        let response;
        try {
          if (request.kind === "walmart-api") counters.walmart_api_calls += 1;
          else counters.presigned_file_calls += 1;
          response = await abortable(fetch_impl(url, {
            method: request.method,
            headers,
            body: request.body === null ? void 0 : request.body,
            redirect: "manual",
            signal: controller.signal
          }), controller.signal);
        } catch (error) {
          if (error instanceof WalmartItemReportCaptureError && error.code === "REQUEST_TIMEOUT") throw error;
          throw new WalmartItemReportCaptureError("NETWORK_FAILURE", "capture HTTP request failed");
        }
        const body = await readExactResponseBytes(
          response,
          request.max_response_bytes,
          request.max_redirect_response_bytes ?? WALMART_ITEM_REPORT_CAPTURE_MAX_REDIRECT_BODY_BYTES,
          controller.signal
        );
        return { status: response.status, headers: responseHeaders(response), body };
      } finally {
        clearTimeout(timeoutHandle);
        outerSignal?.removeEventListener("abort", forwardAbort);
      }
    }
  };
}
function loadCredentials(storeIndex) {
  const clientId = process.env[`WALMART_CLIENT_ID_STORE${storeIndex}`];
  const clientSecret = process.env[`WALMART_CLIENT_SECRET_STORE${storeIndex}`];
  const sellerId = process.env[`WALMART_STORE${storeIndex}_SELLER_ID`];
  if (!clientId || !clientSecret || !sellerId) {
    throw new WalmartItemReportCaptureError(
      "MISSING_CREDENTIALS",
      `Walmart credential scope is not configured for store ${storeIndex}`
    );
  }
  return { client_id: clientId, client_secret: clientSecret, seller_id: sellerId };
}
async function main(argv = process.argv.slice(2), injected = {}) {
  const input = parseWalmartItemReportCaptureCliArgs(argv);
  if (!input.execute) {
    const plan = await runWalmartItemReportCapturePhase(input, {
      transport: { send: async () => {
        throw new Error("plan must not call transport");
      } }
    });
    (injected.stdout ?? console.log)(JSON.stringify(plan));
    return plan;
  }
  if (input.phase === "request") throwRetiredReissueV1();
  let runInput = {
    execute: input.execute,
    phase: input.phase,
    store_index: input.store_index,
    session_dir: input.session_dir,
    allowed_capture_root: input.allowed_capture_root
  };
  let transport = { send: async () => {
    throw new Error("compile phase must not call transport");
  } };
  let cliTransport = null;
  let accountScope;
  if (input.phase !== "compile") {
    const credentials = injected.credentials ?? loadCredentials(input.store_index);
    cliTransport = createWalmartItemReportCliTransport({
      credentials,
      fetch_impl: injected.fetch_impl ?? globalThis.fetch,
      random_uuid: injected.random_uuid ?? randomUUID4,
      request_timeout_ms: injected.request_timeout_ms ?? WALMART_ITEM_REPORT_CAPTURE_DEFAULT_REQUEST_TIMEOUT_MS
    });
    transport = cliTransport;
    accountScope = {
      channel: "WALMART_US",
      store_index: input.store_index,
      seller_account_fingerprint_sha256: computeWalmartSellerAccountFingerprint({
        store_index: input.store_index,
        client_id: credentials.client_id,
        seller_id: credentials.seller_id
      })
    };
  }
  const beforeCounts = cliTransport?.get_http_call_counts() ?? {
    oauth_token_calls: 0,
    walmart_api_calls: 0,
    presigned_file_calls: 0,
    total_http_calls: 0
  };
  const libraryResult = await runWalmartItemReportCapturePhase(runInput, {
    transport,
    account_scope: accountScope,
    random_uuid: injected.random_uuid ?? randomUUID4,
    now: injected.now,
    request_timeout_ms: injected.request_timeout_ms
  });
  const afterCounts = cliTransport?.get_http_call_counts() ?? beforeCounts;
  const actualCalls = {
    oauth_token_calls: afterCounts.oauth_token_calls - beforeCounts.oauth_token_calls,
    walmart_api_calls: afterCounts.walmart_api_calls - beforeCounts.walmart_api_calls,
    presigned_file_calls: afterCounts.presigned_file_calls - beforeCounts.presigned_file_calls
  };
  const totalHttpCalls = actualCalls.oauth_token_calls + actualCalls.walmart_api_calls + actualCalls.presigned_file_calls;
  if (libraryResult.mode === "EXECUTED" && (libraryResult.http_calls.walmart_api_calls !== actualCalls.walmart_api_calls || libraryResult.http_calls.presigned_file_calls !== actualCalls.presigned_file_calls)) {
    throw new WalmartItemReportCaptureError(
      "HTTP_ACCOUNTING_MISMATCH",
      "capture session call accounting differs from the CLI transport attempts"
    );
  }
  const result = libraryResult.mode === "EXECUTED" ? {
    ...libraryResult,
    network_calls: totalHttpCalls,
    http_calls: {
      ...actualCalls,
      total_http_calls: totalHttpCalls
    }
  } : libraryResult;
  (injected.stdout ?? console.log)(JSON.stringify(result));
  return result;
}
function isWalmartItemReportCaptureDirectEntrypoint(invokedPath2, modulePath = fileURLToPath2(import.meta.url)) {
  return typeof invokedPath2 === "string" && path5.basename(invokedPath2) === "capture-walmart-item-report-source.mjs" && path5.resolve(invokedPath2) === modulePath;
}
var isMain = isWalmartItemReportCaptureDirectEntrypoint(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    const code = error instanceof WalmartItemReportCaptureError ? error.code : "UNEXPECTED_ERROR";
    const message = error instanceof Error ? error.message : "capture failed";
    console.error(JSON.stringify({ ok: false, error_code: code, message }));
    process.exitCode = 1;
  });
}

// scripts/walmart-item-report-reissue-v2-frozen-executor.mjs
import { createHash as createHash13 } from "node:crypto";
import { constants as fsConstants5 } from "node:fs";
import { lstat as lstat5, open as open5, realpath as realpath5 } from "node:fs/promises";
import path6 from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
var SCRIPT_PATH = fileURLToPath3(import.meta.url);
var MANIFEST_FILE_NAME = "engine-release.json";
var PRIVATE_FILE_MODE = 256;
var PRIVATE_DIRECTORY_MODES = /* @__PURE__ */ new Set([320, 448]);
function fail8(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function sha2566(bytes) {
  return createHash13("sha256").update(bytes).digest("hex");
}
function exactSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail8("INVALID_CLI_INPUT", `${label} must be one lowercase SHA-256`);
  }
  return value;
}
function normalizeDarwinAlias2(value) {
  if (process.platform !== "darwin") return value;
  for (const [alias, canonical] of [["/tmp", "/private/tmp"], ["/var", "/private/var"]]) {
    if (value === alias || value.startsWith(`${alias}/`)) {
      return `${canonical}${value.slice(alias.length)}`;
    }
  }
  return value;
}
function exactAbsolute2(value, label) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || !path6.isAbsolute(value) || path6.normalize(value) !== value || value.includes("\0")) {
    fail8("INVALID_CLI_INPUT", `${label} must be an exact normalized absolute path`);
  }
  return normalizeDarwinAlias2(value);
}
function positiveStoreIndex2(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    fail8("INVALID_CLI_INPUT", "--store-index must be a positive safe integer");
  }
  return Number(value);
}
function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
async function inspectPrivateParent(filePath, label) {
  const parent = path6.dirname(filePath);
  const before = await lstat5(parent, { bigint: true }).catch(() => {
    fail8("INVALID_ARTIFACT_CUSTODY", `${label} parent is missing`);
  });
  if (!before.isDirectory() || before.isSymbolicLink() || !PRIVATE_DIRECTORY_MODES.has(Number(before.mode & 0o777n)) || await realpath5(parent).catch(() => null) !== parent || typeof process.getuid === "function" && before.uid !== BigInt(process.getuid())) {
    fail8("INVALID_ARTIFACT_CUSTODY", `${label} parent must be current-user private and real`);
  }
  const handle = await open5(
    parent,
    fsConstants5.O_RDONLY | fsConstants5.O_NOFOLLOW | fsConstants5.O_DIRECTORY
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const after = await lstat5(parent, { bigint: true });
    if (!sameStat(before, opened) || !sameStat(opened, after)) {
      fail8("INVALID_ARTIFACT_CUSTODY", `${label} parent identity raced`);
    }
    return { parent, stat: opened };
  } finally {
    await handle.close();
  }
}
async function readImmutableArtifact(filePath, label) {
  const absolute = exactAbsolute2(filePath, label);
  const parent = await inspectPrivateParent(absolute, label);
  const before = await lstat5(absolute, { bigint: true }).catch(() => {
    fail8("INVALID_ARTIFACT_CUSTODY", `${label} is missing`);
  });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || Number(before.mode & 0o777n) !== PRIVATE_FILE_MODE || await realpath5(absolute).catch(() => null) !== absolute || typeof process.getuid === "function" && before.uid !== BigInt(process.getuid())) {
    fail8("INVALID_ARTIFACT_CUSTODY", `${label} must be current-user 0400 single-link real file`);
  }
  const handle = await open5(absolute, fsConstants5.O_RDONLY | fsConstants5.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameStat(before, opened)) fail8("INVALID_ARTIFACT_CUSTODY", `${label} raced before read`);
    const bytes = await handle.readFile();
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstat5(absolute, { bigint: true });
    const parentAfter = await lstat5(parent.parent, { bigint: true });
    if (!sameStat(opened, afterHandle) || !sameStat(afterHandle, afterPath) || !sameStat(parent.stat, parentAfter) || BigInt(bytes.byteLength) !== afterHandle.size) {
      fail8("INVALID_ARTIFACT_CUSTODY", `${label} raced during descriptor read`);
    }
    return { path: absolute, bytes };
  } finally {
    await handle.close();
  }
}
function parseWalmartItemReportReissueV2FrozenExecutorCli(argv) {
  if (!Array.isArray(argv) || argv.length !== WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_EXACT_ARGV_ORDER.length) {
    fail8("INVALID_CLI_INPUT", "executor requires the exact frozen execute-create argv");
  }
  const actualOrder = [argv[0]];
  const values = /* @__PURE__ */ new Map();
  for (const argument of argv.slice(1)) {
    if (typeof argument !== "string" || !argument.startsWith("--") || !argument.includes("=")) {
      fail8("INVALID_CLI_INPUT", "all executor options must use --name=value");
    }
    const separator = argument.indexOf("=");
    const name = argument.slice(0, separator);
    const value = argument.slice(separator + 1);
    if (!value || values.has(name)) fail8("INVALID_CLI_INPUT", "executor option is empty or repeated");
    actualOrder.push(name);
    values.set(name, value);
  }
  if (canonicalWalmartItemReportJson(actualOrder) !== canonicalWalmartItemReportJson(WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_EXACT_ARGV_ORDER)) {
    fail8("INVALID_CLI_INPUT", "executor argv names/order differ from the frozen contract");
  }
  return Object.freeze({
    engine_manifest: exactAbsolute2(values.get("--engine-manifest"), "--engine-manifest"),
    expected_engine_manifest_sha256: exactSha(
      values.get("--expect-engine-manifest-sha256"),
      "--expect-engine-manifest-sha256"
    ),
    expected_frozen_bundle_sha256: exactSha(
      values.get("--expect-frozen-bundle-sha256"),
      "--expect-frozen-bundle-sha256"
    ),
    source_evidence: exactAbsolute2(values.get("--source-evidence"), "--source-evidence"),
    expected_source_evidence_sha256: exactSha(
      values.get("--expect-source-evidence-sha256"),
      "--expect-source-evidence-sha256"
    ),
    owner_disposition: exactAbsolute2(values.get("--owner-disposition"), "--owner-disposition"),
    expected_owner_disposition_sha256: exactSha(
      values.get("--expect-owner-disposition-sha256"),
      "--expect-owner-disposition-sha256"
    ),
    ledger_state_directory: exactAbsolute2(
      values.get("--ledger-state-directory"),
      "--ledger-state-directory"
    ),
    store_index: positiveStoreIndex2(values.get("--store-index"))
  });
}
function parseCanonicalManifest(bytes) {
  let text;
  let parsed;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    fail8("INVALID_FROZEN_ENGINE", "engine manifest is not UTF-8 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || text !== canonicalWalmartItemReportJson(parsed)) {
    fail8("INVALID_FROZEN_ENGINE", "engine manifest is not canonical compact JSON");
  }
  return parsed;
}
function loadedCredentials(storeIndex, env) {
  const clientId = env[`WALMART_CLIENT_ID_STORE${storeIndex}`];
  const clientSecret = env[`WALMART_CLIENT_SECRET_STORE${storeIndex}`];
  const sellerId = env[`WALMART_STORE${storeIndex}_SELLER_ID`];
  for (const [label, value] of [
    ["Walmart client ID", clientId],
    ["Walmart client secret", clientSecret],
    ["Walmart seller ID", sellerId]
  ]) {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
      fail8("MISSING_CREDENTIALS", `${label} is not configured exactly`);
    }
  }
  return Object.freeze({ client_id: clientId, client_secret: clientSecret, seller_id: sellerId });
}
async function main2(argv = process.argv.slice(2), injected = {}) {
  const parsed = parseWalmartItemReportReissueV2FrozenExecutorCli(argv);
  const loadedBundle = await readImmutableArtifact(
    normalizeDarwinAlias2(path6.resolve(process.argv[1] ?? SCRIPT_PATH)),
    "loaded frozen executor"
  );
  if (path6.basename(loadedBundle.path) !== WALMART_ITEM_REPORT_REISSUE_EXECUTOR_V2_FROZEN_BUNDLE || sha2566(loadedBundle.bytes) !== parsed.expected_frozen_bundle_sha256) {
    fail8("LOADED_CODE_BINDING_MISMATCH", "loaded code differs from externally pinned bundle");
  }
  const expectedManifestPath = path6.join(path6.dirname(loadedBundle.path), MANIFEST_FILE_NAME);
  if (parsed.engine_manifest !== expectedManifestPath) {
    fail8("LOADED_CODE_BINDING_MISMATCH", "engine manifest must be beside the loaded bundle");
  }
  const manifestArtifact = await readImmutableArtifact(parsed.engine_manifest, "engine manifest");
  if (sha2566(manifestArtifact.bytes) !== parsed.expected_engine_manifest_sha256) {
    fail8("ARTIFACT_HASH_MISMATCH", "engine manifest differs from externally pinned SHA-256");
  }
  const manifest = parseCanonicalManifest(manifestArtifact.bytes);
  const captureRoot = exactAbsolute2(manifest?.capture?.canonical_root, "manifest capture root");
  const sourceEvidence = await readImmutableArtifact(parsed.source_evidence, "source evidence");
  if (sha2566(sourceEvidence.bytes) !== parsed.expected_source_evidence_sha256) {
    fail8("ARTIFACT_HASH_MISMATCH", "source evidence differs from externally pinned SHA-256");
  }
  const ownerDisposition = await readImmutableArtifact(parsed.owner_disposition, "owner disposition");
  if (sha2566(ownerDisposition.bytes) !== parsed.expected_owner_disposition_sha256) {
    fail8("ARTIFACT_HASH_MISMATCH", "owner disposition differs from externally pinned SHA-256");
  }
  const credentials = loadedCredentials(parsed.store_index, injected.env ?? process.env);
  const accountBinding = Object.freeze({
    channel: "WALMART_US",
    store_index: parsed.store_index,
    seller_id: credentials.seller_id,
    seller_account_fingerprint_sha256: computeWalmartSellerAccountFingerprint({
      store_index: parsed.store_index,
      client_id: credentials.client_id,
      seller_id: credentials.seller_id
    })
  });
  const result = await executeWalmartItemReportReissueExecutorV2({
    frozen_engine_manifest: {
      bytes: manifestArtifact.bytes,
      expected_artifact_sha256: parsed.expected_engine_manifest_sha256
    },
    frozen_bundle: {
      bytes: loadedBundle.bytes,
      expected_artifact_sha256: parsed.expected_frozen_bundle_sha256
    },
    source_evidence: {
      bytes: sourceEvidence.bytes,
      expected_artifact_sha256: parsed.expected_source_evidence_sha256
    },
    owner_disposition: {
      bytes: ownerDisposition.bytes,
      expected_artifact_sha256: parsed.expected_owner_disposition_sha256
    },
    expected_environment: "PRODUCTION",
    active_account: {
      store_index: parsed.store_index,
      seller_id: credentials.seller_id,
      client_id: credentials.client_id
    },
    ledger_state_directory: parsed.ledger_state_directory,
    capture_root: captureRoot
  }, {
    now: injected.now,
    random_uuid: injected.random_uuid,
    sleep: injected.sleep,
    complete_report: true,
    open_transport: () => {
      const underlying = createWalmartItemReportCliTransport({
        credentials,
        fetch_impl: injected.fetch_impl ?? globalThis.fetch,
        random_uuid: injected.random_uuid
      });
      return Object.freeze({
        send: underlying.send,
        get_http_call_counts: underlying.get_http_call_counts,
        get_account_binding: () => ({ ...accountBinding })
      });
    }
  });
  (injected.stdout ?? console.log)(JSON.stringify(result));
  return result;
}
var invokedPath = process.argv[1] ? await realpath5(path6.resolve(process.argv[1])).catch(() => null) : null;
if (invokedPath === await realpath5(SCRIPT_PATH)) {
  main2().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error_code: typeof error?.code === "string" ? error.code : "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : "execution failed"
    })}
`);
    process.exitCode = 1;
  });
}
export {
  main2 as main,
  parseWalmartItemReportReissueV2FrozenExecutorCli
};
