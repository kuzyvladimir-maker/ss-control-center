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

**Two-step write+verify (added 2026-05-19 after Vladimir caught a silent persistence failure on order `113-6751472-0567441`):**

1. **PUT** the package as above.
2. **GET** `/allocations/{allocationId}` and compare the returned `allocation_package` against what we sent. Tolerance: 0.5oz on weight, 0.05in on each dimension. If readback doesn't match, the API returns `veeqo: { ok: false, reason }` and the dialog stays open with a red banner explaining what drifted — so the operator doesn't see a green "Saved" while Veeqo keeps quoting against the old packaging.

The previous version sent `save_for_similar_shipments: true` (thinking that's what made Veeqo remember dims for the next order with the same SKU+qty), but Veeqo's own docs say "Should be `false`" when setting dimensions via the API, and `true` triggered the silent no-persist behavior described above. Our DB already remembers per-SKU dims via SkuShippingData / PackingProfile, so Veeqo doesn't need to.

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
