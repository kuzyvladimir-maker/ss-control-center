# Uncrustables live forensic repair set

Marketplace snapshot: `2026-07-17T22:43:12.080Z`  
Rows: **164 exact live ASINs**  
Body SHA-256: `f91a6678caa681aa7f90d5c466895870b04e4665624d2951cb92878991225595`

## Findings

- Existing MAIN: KEEP 0; REGENERATE 8; NEEDS_EVIDENCE 0; UNOBSERVABLE 156.
- Gallery structure: FAIL_SECONDARY_COUNT 1; FAIL_INFOGRAPHIC_SLOT_1 3; PASS_METADATA_AND_HASH_ALLOWLIST 160. Live product-secondary pixels remain visually unobservable for all 164.
- Text deterministic audit: 107 limited pass; 57 fail. Fully evidence-certified: 0.
- Price: 163 have an unambiguous repair target; 1 require recipe-count resolution first. 163/163 unambiguous sealed OFFER actions match the current pinned canonical model.
- Operations: 145 buyable; 163 discoverable; 54 rows carry Amazon issues.
- Repair-plan gaps: 1 current text failure and 1 gallery-structure failure are not covered by the sealed plan; 1 price target has conflicting recipe-count authorities.

## Evidence boundaries

The eight inspected old-live MAIN samples are byte-hashed and visibly fail the owner cooler/logo/gel/composition criteria. Their hashes do not occur in the later rejected UHG batch. The other 156 are UNOBSERVABLE because URL presence is not pixel evidence. Future gallery `verified:true` flags are not treated as live or visual proof.
