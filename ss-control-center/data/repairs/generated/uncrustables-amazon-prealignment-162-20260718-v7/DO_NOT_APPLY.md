# DO NOT APPLY

This immutable 162-SKU plan is a pre-alignment diagnostic input only.

- Amazon `VALIDATION_PREVIEW` completed all 605 actions.
- 34 `TEXT_COUNT` actions were rejected solely because `item_name` must match the existing Amazon catalog title (`8541`).
- Two staged KP actions were rejected solely because their stateless previews see the pre-repair `unit_count` (`90244`).
- The plan is superseded by the catalog-aligned successor produced from the complete sealed checkpoint set.

Never pass this plan to `--apply`.
