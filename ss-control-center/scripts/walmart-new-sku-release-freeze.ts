#!/usr/bin/env node

import { runWalmartNewSkuReleaseProcess } from "./walmart-new-sku-release";

const argv = process.argv.slice(2);
void runWalmartNewSkuReleaseProcess(
  "freeze",
  argv.some((value) => value === "--help" || value === "-h" || value === "help")
    ? ["--help"]
    : ["freeze", ...argv],
);
