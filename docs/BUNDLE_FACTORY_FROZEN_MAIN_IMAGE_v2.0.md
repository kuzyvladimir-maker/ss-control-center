# Bundle Factory — Frozen MAIN Image Spec (v2.0)

> **Effective:** 2026-07-18
>
> **Owner:** Vladimir
>
> **Status:** frozen production contract for Uncrustables Amazon MAIN images
> **Supersedes:** `BUNDLE_FACTORY_FROZEN_MAIN_IMAGE_v1.0.md` for the
> Uncrustables production path.

## 1. Decision

An Uncrustables MAIN image is a truthful photograph-style rendering of the
exact recipe inside the owner-approved Salutem frozen-shipping kit. Production
generation uses **GPT Image 2** with immutable visual references. It is not a
free-form illustration task.

The deterministic `empty-cooler-v1` / `empty-cooler-v2` compositor is rejected
for production. Its logo, gel-pack design, perspective, and pasted product
placement did not match the approved result. It may run only as an explicitly
labelled experiment and its output may not enter a marketplace batch.

Machine QA is necessary but cannot publish an image. An immutable owner visual
approval is required before a batch and per-image authenticity verification is
required before a generated MAIN can be assigned to a listing.

## 2. Authoritative kit anchor

The first reference for every Uncrustables frozen MAIN generation must be this
exact file:

- Repo asset: `ss-control-center/public/bundle-factory/frozen-refs/ref-uncrustables.png`
- SHA-256: `9c45164a56e3cda1e9e0c2590e7d75d94e6320af012b841bc9e5b73594a1fd33`
- Production R2 URL: `${R2_PUBLIC_URL}/prod/frozen-refs/anchor-uncrustables.png`
- Public fallback URL:
  `https://salutemsolutions.info/bundle-factory/frozen-refs/ref-uncrustables.png`

The fetched anchor bytes must match the SHA-256 above. A missing anchor, an
unreachable URL, or a hash mismatch blocks generation. A similar-looking image
is not a substitute.

The Jimmy Dean anchor is retained as secondary historical evidence, not as the
first Uncrustables reference:

- `ss-control-center/public/bundle-factory/frozen-refs/ref-jimmy-dean.png`
- SHA-256: `d6387696c6a8e100a838c284bf73533bd3f3682a470ce48ac714e9511dae4900`

## 3. Reference contract

Reference order is semantic and immutable:

1. Reference #1 is the approved Uncrustables kit anchor. It controls only the
   cooler, Salutem branding, gel packs, camera, lighting, and composition.
2. References #2 through #N are exact, reviewed donor product-art references.
   They are grouped first by recipe flavor order and then by the stable order
   of the selected package designs in the reviewed art registry. A flavor may
   therefore require more than one reference when its exact carton
   decomposition uses more than one genuine retail pack size.
3. A retail-carton image may be generated only from reviewed retail-carton art
   for that exact flavor and pack size.
4. An individual-wrapper image may be generated only from reviewed individual
   wrapper art for every flavor. A carton-only donor is never sufficient to
   invent wrapper art.

The production art registry is
`ss-control-center/src/lib/bundle-factory/audit/data/uncrustables-authenticity-registry-v1.json`,
sealed as
`9723d515a110859e54efa8f8bff1b5f7e56f49c28b411834a2d267b68e827157`.
The bytes fetched from every candidate donor URL must match an evidence
SHA-256 on the resolved registry art. Matching a title, flavor label, URL, or
presentation name without the byte match is not sufficient.

Missing, ambiguous, unreviewed, out-of-order, or wrong-presentation donor
evidence is a hard stop. Never fill the gap with a search result, a similar
flavor, generic packaging, or model invention.

Product-name similarity never establishes identity. In particular,
`Peanut Butter & Chocolate Flavored Spread`, `Chocolate Flavored Hazelnut
Spread`, and `Peanut Butter & Chocolate Flavored Hazelnut Spread` are three
distinct products and must have separate flavor IDs and separate reviewed art.
None may authorize another one's carton or wrapper.

## 4. Exact frozen-kit geometry

Every approved image must preserve all of the following:

- White textured EPS insulated cooler, realistic 3/4 front view, with the lid
  leaning behind it.
- The exact ornate green Salutem emblem on the cooler.
- The black `SALUTEM SOLUTIONS` wordmark and black
  `OUR BEST SOLUTIONS FOR YOU` slogan on the cooler.
- **Exactly four** white sealed gel packs:
  - two inside the cooler, one on the left and one on the right of the product;
  - two standing outside along the front/right presentation area.
- Every gel pack has the approved blue `FROZEN GEL PACK` header, blue
  `KEEP FROZEN` / `FOR FROZEN SHIPMENTS` wording, the ornate green emblem,
  and the black Salutem wordmark/slogan.
- Subtle cold condensation or frost is permitted. Loose ice, ice cubes,
  crushed ice, snow piles, and water puddles are forbidden.

`2 to 4`, `about four`, generic cold packs, altered logos, and alternate gel
pack layouts do not satisfy this contract.

## 5. Product presentation modes

The recipe and reviewed art registry determine one of three presentation
classes. The generator does not choose by visual convenience.

### `retail_boxes_single`

- One genuine Uncrustables flavor and one or more exact reviewed carton
  designs for that same flavor. Genuine retail boxes may be 4-, 10-, 15-count,
  or another pack size actually present in the reviewed art registry.
- The selected carton multiset must sum exactly to the recipe flavor quantity.
  For example, a 24-count single-flavor recipe may truthfully use
  `10 + 10 + 4` when exact reviewed 10-count and 4-count art exists for that
  flavor.
- The deterministic planner minimizes the total number of cartons. Ties use
  the stable reviewed-registry art order; output is also grouped in that order.
- A remainder, an unreviewed pack size, a pack size reviewed only for another
  flavor, ambiguous art for the same pack size, or no exact decomposition
  blocks carton mode. Counts are never rounded or guessed.
- Every visible carton must be an exact copy of its corresponding reviewed
  same-flavor/count design. A uniform one-design presentation is not required.

### `retail_boxes_mix`

- Every recipe flavor is visible using its own exact reviewed carton art.
- The same deterministic decomposition rule is applied independently to each
  flavor quantity. One flavor's reviewed pack sizes never authorize another
  flavor's cartons.
- Every component must reconcile exactly. No component may use a global or
  guessed pack-size list, and no flavor may be omitted, merged, or substituted.

### `individual_wraps`

- Each visible unit is one genuinely branded, individually sealed wrapper.
- No retail carton, bare sandwich, plain wrapper, or generic wrapper is shown.
- Every recipe flavor uses its own reviewed wrapper art, and the visible number
  of wrappers for each flavor equals its recipe quantity.
- This mode is allowed only when exact reviewed wrapper evidence exists for
  every component. If a carton plan cannot divide and wrapper evidence is
  unavailable, generation blocks rather than fabricating a fallback.

## 6. Genuine donor-count rule

Printed manufacturer pack counts are part of genuine package art and must not
be erased.

- Preserve exactly the retail count actually printed on the corresponding
  reviewed donor carton, including a genuine `4`, `8`, `10`, `15`, or another
  reviewed count.
- Never change a donor count, borrow one from another flavor/size, or invent a
  count badge.
- Never print the aggregate listing quantity (for example 24, 30, 45, 90, or
  120) as a carton badge, wrapper badge, cooler label, gel-pack label, or image
  overlay. Aggregate quantity is communicated by the number of visible genuine
  cartons/wrappers and by listing text outside the MAIN image.
- If the aggregate quantity happens to equal a genuine donor retail count, the
  number may appear only because the reviewed donor art itself contains it,
  never because the generator derived it from the listing total.
- A wrapper keeps any genuine text/numerals present in its reviewed art, but no
  synthetic count badge or listing-total numeral may be added.

The obsolete v1 instruction to remove all digits/count badges is revoked.

## 7. Physical seating and image composition

Products must look physically packed inside the cooler, not pasted over it:

- lower product edges are occluded behind the cooler's front inner rim;
- camera perspective, scale, lighting, and focus are shared with the cooler;
- every carton/wrapper has believable contact, overlap, cavity depth, and
  contact shadow;
- no floating product, gap beneath a product, alpha halo, flat cutout edge,
  impossible intersection, or product protruding through a cooler wall;
- the exact recipe products are the visual focus and remain readable;
- pure white Amazon MAIN background, square 1:1, clean studio lighting;
- no people, hands, lifestyle scene, props, retailer badges, price stickers,
  corner ribbons, watermarks, UI, overlay text, or extra products.

Salutem branding belongs only to the cooler and gel packs. Smucker's and
Uncrustables branding belongs only to genuine third-party package art.

## 8. Retry policy

A failed vision/compliance retry may ban only unexpected marks such as retailer
logos, store badges, watermarks, or products foreign to the exact recipe.

Retries must preserve the recipe-approved genuine `Smucker's` and
`Uncrustables` marks and donor package art. They must never request generic or
unbranded replacement packaging. If a detector cannot distinguish an expected
product mark from an unexpected logo, the image is blocked for human review;
the pipeline does not erase the real product identity.

## 9. Owner approval gate

Before any batch:

1. Generate at least one preview for each presentation/composition class used
   by the batch: `retail_boxes_single`, `retail_boxes_mix`, and/or
   `individual_wraps`.
2. Record model, complete prompt, ordered reference locators and hashes, output
   dimensions, and output SHA-256 in a generation manifest.
3. The owner opens the full-resolution files and explicitly approves the exact
   output SHA-256 values.
4. Any change to the model, prompt, anchor bytes, donor art, count plan,
   gel-pack layout, cooler layout, or rendering workflow invalidates the class
   approval and requires new previews.
5. Every batch output still passes recipe/art/count/geometry QA and an
   image-bound human authenticity approval. Approval of a class preview is not
   blanket approval of 164 unseen outputs.

### Owner-approved v2 class fixtures

All three fixtures are 1536×1536 GPT Image 2 outputs approved in the
2026-07-17–18 review session:

| Class | Immutable fixture | SHA-256 |
|---|---|---|
| `retail_boxes_single` | `ss-control-center/data/audits/uncrustables-gpt-image-2-previews-20260718/01c-retail-boxes-single-pb-24-four-gel-packs.png` | `4cdd7bec9ab5c1d5f97b5746d7569a4ffc891a36b8d1fb159168176f06e19076` |
| `retail_boxes_mix` | `ss-control-center/data/audits/uncrustables-gpt-image-2-previews-20260718/02b-retail-boxes-mix-pb-blackberry-24-four-gel-packs.png` | `9d0294242508529022a0e2b1cdd2df0adce469ef9dbb8bd2dd7d448031ea839d` |
| `individual_wraps` | `ss-control-center/data/audits/uncrustables-gpt-image-2-previews-20260718/03-individual-wraps-mix-hazelnut-berry-24.png` | `d2f7ffdd0a3e411725a3dc1dac013f9f5f50c1e6dd9d34164c12cbe5cacc722f` |

## 10. Fail-closed pre-publish checklist

A MAIN image is blocked if any answer below is not an evidence-backed **yes**:

1. Was GPT Image 2 used with the exact approved anchor first?
2. Did every recipe component receive matching reviewed donor art in order and
   in the correct carton/wrapper presentation?
3. Are only the exact recipe flavors/products visible?
4. Do visible package counts exactly reconcile to every recipe quantity?
5. Are all printed retail counts genuine donor counts, with no synthetic
   aggregate listing count?
6. Are there exactly four correctly branded gel packs in the approved 2-inside
   plus 2-outside layout?
7. Do the cooler logo, wordmark, slogan, texture, angle, and lid match the
   approved kit?
8. Are all products physically seated behind the front rim with believable
   perspective, contact, and shadow?
9. Are foreign products, fictional flavors, generic wrappers, altered package
   art, retailer marks, overlays, loose ice, and visual defects absent?
10. Do the generated bytes, manifest, reviewed art registry, structured visual
    observation, and human approval have matching immutable hashes?

No marketplace update is authorized by this document alone. Generation,
validation, approval, and publication remain separate gated operations.
