# Product Truth matcher v2.2 — pause checkpoint

> **Checkpoint consumed on 2026-07-20.** The resume items below are historical.
> Current authority is
> `product-truth-matcher-runtime-verifier-2026-07-19/runtime-verifier-status.v2.2.json`;
> the only Claude handoff is the sibling `CLAUDE_CODE_OPERATOR_PROMPT.md`.

Paused at owner request before VS Code restart: `2026-07-20T02:20Z`.

## Completed and frozen

- Engine commit: `78e0664908cd37c3746a311084f4826a031b3658`
- Engine tree: `7a2eb1a6bbc0886fec33898268db3036e240aa22`
- Clean engine root:
  `/private/tmp/product-truth-matcher-consensus-v22.f2xgHH/repo/ss-control-center`
- Focused tests: `23/23 PASS`
- Full Product Truth certification: `432/432 PASS`
- Final corpus:
  `release-artifacts/product-truth-matcher-adjudication-2026-07-19/assembled-v22-post-blind-consensus-final/corpus.json`
- Final corpus SHA-256:
  `a1310fce60fcfe3e463cc853181fb155b9a200bc45ddaa5bda6ee8b79827e06f`
- Final eight-input packet parser/canonical preflight: PASS (`7/7` tooling tests).
- Runtime wrapper tests after adding `9e0619...` to the built-in rejection list:
  `12/12 PASS`.
- Wrapper SHA-256:
  `7022edca836d0bb563a21bf7d0dd66a321c951d8fb97de652e084a98d6669dfc`
- Codex runtime manifest is sealed:
  `release-artifacts/product-truth-matcher-runtime-verifier-2026-07-19/runtime-manifest.v2.2.codex-certification.json`
  SHA-256 `3ef7a5abce048178f0c87f601015ca5856ef4e16135c5606e6db3d0f2344c2be`.
- Claude runtime manifest is sealed but deliberately unconsumed:
  `release-artifacts/product-truth-matcher-runtime-verifier-2026-07-19/runtime-manifest.v2.2.claude-operator.json`
  SHA-256 `2927749ae03fc563175682afae83f96bfe037cd383c0530cce6929e9df812d11`.
- Final Codex wrapper replay on corpus `a131...` completed with the expected
  evidence-partial exit `2`:
  - semantic matcher: `304/304 PASS`;
  - quarantine: `300 resolved / 86 unresolved`;
  - golden: `2 cases / 4 comparisons`, all required tiers;
  - matcher mismatches: `0`;
  - only blocker: `UNRESOLVED_EVIDENCE_PRESENT`;
  - full-corpus truth: `BLOCKED`;
  - report SHA-256:
    `29aa05aaf8590fe09905e3b85f4d55f4dcc46e01a9b92cdec59deaf47e4fa8d5`;
  - artifact-index SHA-256:
    `2bffe77e99c1a943e85ff7295226876528ba6bfa00362d14d68da073113cc937`.

No DB, network, model, paid/provider or marketplace calls occurred.

## Do not repeat after restart

- Do not rebuild the matcher or corpus.
- Do not replay the Codex certification output directory.
- Do not use the old `10b2...` corpus or the `INVALID-*` v2.1/v2.2 packets.
- Do not run the untouched Claude manifest until the final operator handoff is ready.
- Do not launch the 1,458-SKU queue or any production/paid action.

## Resume point

1. Verify the sealed Codex report/index and finish the runtime-verifier release notes.
2. Update canonical Wiki/AGENTS status from v2.1 to honest v2.2 post-blind consensus.
3. Finish the code-release packet `SHA256SUMS`/materialization note.
4. Produce the one short exact prompt for Claude Code using the untouched sealed
   Claude manifest. Claude must run the wrapper only, not the direct runner.
5. Keep Gate 1 truth open: 86 cases still need authoritative evidence, and production
   matcher version/provenance migration remains a separate blocker.
