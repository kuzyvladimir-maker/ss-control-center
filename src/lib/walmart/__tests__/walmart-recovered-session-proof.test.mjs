import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import {
  buildCodexVisionWrappedPrompt,
  validateRecoveredCodexSessionProof,
} from "../../../../scripts/lib/walmart-recovered-session-proof.mjs";
import { buildBlindObservationPrompt } from "../catalog-visual-audit.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SESSION_FILE = path.join(
  ROOT,
  "data/audits/walmart-visual-pilot-recoveries",
  "rollout-2026-07-18T17-09-05-019f770f-b1bf-7841-acfe-ee3b627a70bf.jsonl",
);
const EVIDENCE_FILE = path.join(
  ROOT,
  "data/audits/walmart-visual-pilot-recoveries/singleton-call-21-20260718-v2.json",
);
const LOCAL_FULL_VIEW_FILE = path.join(
  ROOT,
  "data/audits/walmart-visual-pilot-snapshots/walmart-main-bbf179123bd9139dbe9e/derived",
  "full-df859229ae95e471356e469d28ef59ac6bea80d72efaac4eb2640ffbe558b4f1.jpg",
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

let fixturePromise;
async function fixture() {
  fixturePromise ??= (async () => {
    const [sessionLogBytes, evidenceBytes, localFullViewJpegBytes] = await Promise.all([
      readFile(SESSION_FILE),
      readFile(EVIDENCE_FILE, "utf8"),
      readFile(LOCAL_FULL_VIEW_FILE),
    ]);
    const evidence = JSON.parse(evidenceBytes);
    const basePrompt = buildBlindObservationPrompt(evidence.binding.image_ids);
    return {
      sessionLogBytes,
      localFullViewJpegBytes,
      expected: {
        session_log: {
          sha256: evidence.source.session_log_sha256,
          byte_length: evidence.source.session_log_bytes,
        },
        session: {
          id: evidence.source.session_id,
          cli_version: evidence.source.cli_version,
          model: evidence.source.model,
          reasoning_effort: evidence.source.reasoning_effort,
          started_at: evidence.source.started_at,
          completed_at: evidence.source.completed_at,
          duration_ms: evidence.source.duration_ms,
        },
        prompt: {
          base: basePrompt,
          base_sha256: evidence.binding.prompt_sha256,
          wrapped: buildCodexVisionWrappedPrompt(basePrompt, 1),
        },
        result: evidence.result,
        result_canonical_sha256: evidence.source.result_canonical_sha256,
        embedded_image: {
          sha256: evidence.source.embedded_input_image_sha256,
          byte_length: evidence.source.embedded_input_image_bytes,
          width: evidence.source.embedded_input_image_width,
          height: evidence.source.embedded_input_image_height,
        },
        local_full_view: {
          sha256: evidence.binding.full_view_sha256[0],
          byte_length: localFullViewJpegBytes.length,
          width: 1800,
          height: 1800,
        },
      },
    };
  })();
  return fixturePromise;
}

function withSessionHash(expected, bytes) {
  return {
    ...expected,
    session_log: { sha256: sha256(bytes), byte_length: bytes.length },
  };
}

function mutateJsonl(bytes, mutator) {
  const records = bytes.toString("utf8").slice(0, -1).split("\n").map(JSON.parse);
  mutator(records);
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

test("raw recovery proof validates the actual immutable Codex session offline", async () => {
  const input = await fixture();
  const proof = await validateRecoveredCodexSessionProof(input);
  assert.equal(proof.valid, true);
  assert.equal(proof.session.sha256, input.expected.session_log.sha256);
  assert.equal(proof.embedded_image.sha256, input.expected.embedded_image.sha256);
  assert.equal(proof.local_full_view.sha256, input.expected.local_full_view.sha256);
  assert.equal(proof.prompt.exact_wrapped_prompt, true);
  assert.equal(proof.result.exact_final_json, true);
  assert.equal(proof.image_link.deterministic, true);
  assert.equal(proof.image_link.cryptographic, false);
  assert.equal(proof.image_link.byte_identical, false);
  assert.ok(proof.image_link.metrics.mean_absolute_error < 1.2);
  assert.ok(proof.image_link.metrics.root_mean_square_error < 2.7);
  assert.ok(proof.image_link.metrics.pearson_correlation > 0.9995);
});

test("raw recovery proof rejects any byte change before trusting parsed claims", async () => {
  const input = await fixture();
  const tampered = Buffer.from(input.sessionLogBytes);
  tampered[100] ^= 1;
  await assert.rejects(
    validateRecoveredCodexSessionProof({ ...input, sessionLogBytes: tampered }),
    /session_log\.sha256 mismatch/,
  );
});

test("raw recovery proof rejects model drift even when the changed JSONL has a declared hash", async () => {
  const input = await fixture();
  const tampered = mutateJsonl(input.sessionLogBytes, (records) => {
    const context = records.find((record) => record.type === "turn_context");
    context.payload.model = "different-model";
    context.payload.collaboration_mode.settings.model = "different-model";
  });
  await assert.rejects(
    validateRecoveredCodexSessionProof({
      ...input,
      sessionLogBytes: tampered,
      expected: withSessionHash(input.expected, tampered),
    }),
    /model\/reasoning effort/,
  );
});

test("raw recovery proof independently rejects CLI, session-id, effort, and timestamp drift", async () => {
  const input = await fixture();
  const cases = [
    {
      label: "CLI",
      pattern: /identity\/CLI\/origin/,
      mutate(records) {
        records[0].payload.cli_version = "0.144.6";
      },
    },
    {
      label: "session id",
      pattern: /identity\/CLI\/origin/,
      mutate(records) {
        records[0].payload.session_id = "00000000-0000-0000-0000-000000000000";
        records[0].payload.id = "00000000-0000-0000-0000-000000000000";
      },
    },
    {
      label: "reasoning effort",
      pattern: /model\/reasoning effort/,
      mutate(records) {
        const context = records.find((record) => record.type === "turn_context");
        context.payload.effort = "high";
        context.payload.collaboration_mode.settings.reasoning_effort = "high";
      },
    },
    {
      label: "monotonic timestamp",
      pattern: /timestamps are not monotonic/,
      mutate(records) {
        const context = records.find((record) => record.type === "turn_context");
        context.timestamp = records[0].timestamp;
      },
    },
  ];
  for (const item of cases) {
    const tampered = mutateJsonl(input.sessionLogBytes, item.mutate);
    await assert.rejects(
      validateRecoveredCodexSessionProof({
        ...input,
        sessionLogBytes: tampered,
        expected: withSessionHash(input.expected, tampered),
      }),
      item.pattern,
      item.label,
    );
  }
});

test("raw recovery proof rejects a second user input_image", async () => {
  const input = await fixture();
  const tampered = mutateJsonl(input.sessionLogBytes, (records) => {
    const message = records.find((record) => (
      record.type === "response_item"
      && record.payload.role === "user"
      && record.payload.content?.some((item) => item.type === "input_image")
    ));
    const image = message.payload.content.find((item) => item.type === "input_image");
    message.payload.content.splice(2, 0, structuredClone(image));
  });
  await assert.rejects(
    validateRecoveredCodexSessionProof({
      ...input,
      sessionLogBytes: tampered,
      expected: withSessionHash(input.expected, tampered),
    }),
    /exactly one user input_image/,
  );
});

test("raw recovery proof rejects wrapped-prompt drift", async () => {
  const input = await fixture();
  const tampered = mutateJsonl(input.sessionLogBytes, (records) => {
    const message = records.find((record) => (
      record.type === "response_item"
      && record.payload.role === "user"
      && record.payload.content?.some((item) => item.type === "input_image")
    ));
    message.payload.content.at(-1).text += " altered";
  });
  await assert.rejects(
    validateRecoveredCodexSessionProof({
      ...input,
      sessionLogBytes: tampered,
      expected: withSessionHash(input.expected, tampered),
    }),
    /exact wrapped prompt/,
  );
});

test("raw recovery proof rejects final-result drift across redundant records", async () => {
  const input = await fixture();
  const tampered = mutateJsonl(input.sessionLogBytes, (records) => {
    const assistant = records.find((record) => (
      record.type === "response_item" && record.payload.role === "assistant"
    ));
    assistant.payload.content[0].text = "{}";
  });
  await assert.rejects(
    validateRecoveredCodexSessionProof({
      ...input,
      sessionLogBytes: tampered,
      expected: withSessionHash(input.expected, tampered),
    }),
    /final JSON text/,
  );
});

test("raw recovery proof rejects embedded JPEG drift after recomputed JSONL hash", async () => {
  const input = await fixture();
  const tampered = mutateJsonl(input.sessionLogBytes, (records) => {
    const message = records.find((record) => (
      record.type === "response_item"
      && record.payload.role === "user"
      && record.payload.content?.some((item) => item.type === "input_image")
    ));
    const image = message.payload.content.find((item) => item.type === "input_image");
    const finalBase64Index = image.image_url.length - 3;
    image.image_url = `${image.image_url.slice(0, finalBase64Index)}A${image.image_url.slice(finalBase64Index + 1)}`;
  });
  await assert.rejects(
    validateRecoveredCodexSessionProof({
      ...input,
      sessionLogBytes: tampered,
      expected: withSessionHash(input.expected, tampered),
    }),
    /embedded_image\.sha256 mismatch|cannot be decoded|not a complete JPEG/,
  );
});

test("declaring an impostor local JPEG hash cannot bypass canonical pixel identity", async () => {
  const input = await fixture();
  const impostor = await sharp(input.localFullViewJpegBytes)
    .negate({ alpha: false })
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
  const expected = structuredClone(input.expected);
  expected.local_full_view = {
    ...expected.local_full_view,
    sha256: sha256(impostor),
    byte_length: impostor.length,
  };
  await assert.rejects(
    validateRecoveredCodexSessionProof({
      sessionLogBytes: input.sessionLogBytes,
      localFullViewJpegBytes: impostor,
      expected,
    }),
    /not the deterministic visual counterpart/,
  );
});

test("expected result requires its independently supplied canonical SHA", async () => {
  const input = await fixture();
  const expected = structuredClone(input.expected);
  expected.result.observations[0].visible_variant_text = "MUTATED";
  assert.notEqual(
    sha256(canonicalJson(expected.result)),
    input.expected.result_canonical_sha256,
  );
  await assert.rejects(
    validateRecoveredCodexSessionProof({ ...input, expected }),
    /expected result_canonical_sha256 mismatch/,
  );
});
