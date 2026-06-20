# Veeqo allocation_package sync

## Problem

`getShippingRates(allocationId)` requests rates with `from_allocation_package=true`. That means **Veeqo uses its own cached packaging for the allocation, not our DB**. Saving new L/W/H to our `PackingProfile` / `SkuShippingData` doesn't change the rates Veeqo returns — it just changes what we display.

The user noticed Veeqo "remembers" the last dimensions for a given SKU+qty composition. That's because Veeqo's own UI sets `save_for_similar_shipments: true` when packing.

## Fix

`POST /api/shipping/edit-package` now also pushes packaging to Veeqo:

```http
PUT /allocations/{allocationId}/allocation_package
{
  "allocation_package": {
    "weight": <oz>,
    "weight_unit": "oz",
    "depth": <inches, longest>,
    "width": <inches>,
    "height": <inches>,
    "dimensions_unit": "in",
    "package_provider": "CUSTOM",
    "package_selection_source": "ONE_OFF",
    "save_for_similar_shipments": false
  }
}
```

UI passes `allocationId` (from `plan.allocationId`) through to the API.

**Write+verify (added 2026-05-19, rewritten 2026-05-23):**

1. **PUT** the package as above.
2. Verify by reading `data.attributes` from the **PUT response body itself**. Tolerance: 0.5 oz on weight, 0.05 in on each dimension. If the saved values disagree with what we sent, the API returns `veeqo: { ok: false, reason }` and the dialog stays open with a red banner explaining what drifted.

The previous implementation did a separate `GET /allocations/{allocationId}` to read back the saved package. That endpoint **does not include `allocation_package`** in its response — it returns `{}` for most allocations (no `GET /allocations/{id}/allocation_package` either; that's a 404) — so the readback always reported "no allocation_package" and the operator saw `Veeqo did NOT update its packaging` on every Save, even though Veeqo had actually accepted the PUT and persisted the new values. The Edit Package modal was effectively broken from when the readback was added (2026-05-19) until 2026-05-23 when Vladimir surfaced the issue.

The PUT response is now treated as the canonical post-update state — Veeqo returns the saved fields directly in `data.attributes`, no GET needed:

```json
{ "data": { "type": "allocation_package",
            "attributes": { "depth": 11, "width": 8, "height": 6,
                            "dimensions_unit": "inches",
                            "weight": 80, "weight_unit": "oz",
                            "package_selection_source": "ONE_OFF",
                            "allocation_id": <id>, ... } } }
```

The previous version also sent `save_for_similar_shipments: true` (thinking that's what made Veeqo remember dims for the next order with the same SKU+qty), but Veeqo's own docs say "Should be `false`" when setting dimensions via the API, and `true` triggered a different silent no-persist behavior. Our DB already remembers per-SKU dims via SkuShippingData / PackingProfile, so Veeqo doesn't need to.

## Units

We convert in the client wrapper:
- Weight: lbs (UI) → oz (Veeqo) via `× 16`
- Dimensions: inches both sides (no conversion)

## Field mapping

Veeqo uses `depth / width / height`, where `depth` is the longest dimension (= shipping label length). We pass our `L` straight to `depth`.

## Sources

- [Veeqo API: Update Allocation Package](https://developers.veeqo.com/api/operations/update-allocation-package/)
- [`src/lib/veeqo/client.ts`](../../ss-control-center/src/lib/veeqo/client.ts) → `updateAllocationPackage()`
- [`src/app/api/shipping/edit-package/route.ts`](../../ss-control-center/src/app/api/shipping/edit-package/route.ts) → `pushPackageToVeeqo()`

## Связано с
- [Veeqo API](veeqo-api.md) — клиент-обёртка и эндпоинты Veeqo
- [Shipping labels](shipping-labels.md) — использует габариты пакета для рейтов
