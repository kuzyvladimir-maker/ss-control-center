# Product Truth backfill plans

This directory contains immutable, read-only `backfill-plan` evidence.

Creating a plan may read the exact production schema, migration ledgers,
writer state, authoritative listing scopes, and canonical scoped COGS outcomes.
It does not authorize or execute `backfill-apply`, provider calls, marketplace
mutations, paid enrichment, or procurement actions.

Each run must use a new child directory and bind the exact authoritative Phase 1
manifest plus the canonical production migration report and certification.
