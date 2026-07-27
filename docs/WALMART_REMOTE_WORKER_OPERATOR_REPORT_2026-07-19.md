# Walmart remote image worker — Claude operator report, 2026-07-19

Status: `DEPLOYED_AND_AUTHENTICATED_HEALTH_REPORTED`

This file records the operator report supplied by Claude BF-Images in the shared
VS Code workspace. The values are valid freeze inputs, but the report is not an
independent Codex capture. The observer will repeat authenticated `/health` and
fail closed against the frozen build/ledger contract before any model POST.

## Reported execution

- Deployed the four source-of-truth worker files from
  `ops/codex-image-worker/`: `server.js`, `prompt.js`,
  `image-preflight.js`, and `vision-contract.js`.
- Restarted `codex-image-worker`; no source code was edited.
- Preserved the existing Ed25519 attestation key.
- Bootstrapped the previously absent reservation ledger using the documented
  two-step procedure, then pinned `VISION_CALL_LEDGER_EXPECTED_ID` and
  `VISION_CALL_LEDGER_EXPECTED_EPOCH` in the protected worker environment.
- Reported an authenticated `/health` response with
  `health_authorization_verified=true` and byte-identical ledger/build values
  across the bootstrap restart.
- Model calls, Walmart writes, and access to the quarantined ITEM session: `0`.

## Reported current identity

```text
worker_build = sha256:fed5fa5e49914c1df1ae2197c51be4d7c0342f2adad4d01819f792622614f0f9
worker_receipt_schema = vision-worker-receipt/v2
attestation_key_id = walmart-listing-vision-aaf60dc3afc25bba
attestation_public_key_spki_sha256 = aaf60dc3afc25bba5bac48086524b813ad62b0103c290886769a1352eb4b8ea3
reservation_ledger_id = ledger-2c53fa5f-f761-4660-80b9-24e934e172aa
reservation_ledger_epoch = epoch-986b9a13-740b-4403-b433-378f2613d4f0
state_directory_path_sha256 = ae43d594a2a43b6bc856529cfa729d73d9784d1dd3f3e4dffddf27feccfece53
directory_identity_sha256 = c0e7a611777a5b7063c36a94c3c4c27ea6943e34ba2622944c0426d7685c0db1
identity_artifact_sha256 = ffd380901c51e88205454d1ddd68141d94e811c286b62d556c60e335e84e3a68
codex_model = gpt-5.6-sol
codex_reasoning = medium
codex_cli = 0.144.5
claude_model = sonnet
claude_cli = 2.1.179
node = v20.20.1
platform = linux/x64
vision_timeout_ms = 180000
```

Previous worker build
`sha256:080d3a50d0d7354b38d6ca82ea0c5628357810f87d9fc1ec3ac20fc68bf65368`
and every checkpoint/run-lock bound to it are obsolete for new execution.

## Provenance boundary

An exact sanitized health-response capture may be retained as additional evidence,
but it is not a separate engine gate: live authenticated health is mandatory and
rechecked against the frozen values at execution. Any build, key, ledger, epoch,
path/custody fingerprint, runtime, or timeout drift stops before the model call.

Production execution remains blocked on authoritative
ITEM disposition/source, approved Product Truth, numeric buyer PDP and complete
MAIN/gallery snapshots, Shadow-50, and the gallery pilot. This report authorizes
no model call and no Walmart write.
