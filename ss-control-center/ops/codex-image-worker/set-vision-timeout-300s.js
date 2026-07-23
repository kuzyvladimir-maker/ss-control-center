#!/usr/bin/env node
"use strict";

/** One-purpose atomic migration of the worker vision timeout to 300 seconds. */

// Worker sources are CommonJS because server.js is deployed directly by Node.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");

const target = "/root/codex-image-worker/.env";
const temp = `${target}.vision-timeout-migration-${process.pid}`;
const source = fs.readFileSync(target, "utf8");
const lines = source.split(/\r?\n/u).filter((line) => !/^VISION_TIMEOUT_MS=/u.test(line));
while (lines.length && lines.at(-1) === "") lines.pop();
const bytes = Buffer.from(`${lines.join("\n")}\nVISION_TIMEOUT_MS=300000\n`, "utf8");
const descriptor = fs.openSync(temp, "wx", 0o600);
try {
  fs.writeFileSync(descriptor, bytes);
  fs.fsyncSync(descriptor);
} finally {
  fs.closeSync(descriptor);
}
fs.renameSync(temp, target);
const directory = fs.openSync(path.dirname(target), "r");
try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
process.stdout.write("VISION_TIMEOUT_MS_UPDATED_ATOMICALLY\n");
