# Incomplete diagnostic checkpoint set — do not use

The run for repair plan `99854ed8606535cda86f917cb6ce49320862daf3d7ebe24c8adbb5da0e719656`
was intentionally interrupted after Amazon returned HTTP 400 for every OFFER
`merge` operation in `VALIDATION_PREVIEW` mode:

`Merge operation is not allowed for VALIDATION_PREVIEW requests.`

No Amazon mutation was made. This partial checkpoint set must not be used for
alignment, rollback preparation, apply authorization, or completion claims.
A new sealed plan and a complete checkpoint set using a recorded selector
`replace` preview surrogate are required.
