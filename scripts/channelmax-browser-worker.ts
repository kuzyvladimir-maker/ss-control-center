// Run from ss-control-center: npm run channelmax:worker

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  ChannelMaxBrowserWorker,
  ChannelMaxBrowserWorkerError,
  type ChannelMaxBrowserWorkerConfig,
} from "../src/lib/channelmax-agent/browser-worker";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ChannelMaxBrowserWorkerError(
      "INVALID_CONFIG",
      `${name} is required.`,
    );
  }
  return value;
}

function positiveIntegerEnvironment(
  name: string,
  fallback: number,
): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new ChannelMaxBrowserWorkerError(
      "INVALID_CONFIG",
      `${name} must be a positive integer.`,
    );
  }
  return Number(raw);
}

function resolveCdpScriptPath(): string {
  const configured = process.env.CHANNELMAX_CDP_SCRIPT_PATH;
  if (configured) return resolve(configured);
  const candidates = [
    resolve(process.cwd(), "../scripts/cdp_browser.py"),
    resolve(process.cwd(), "scripts/cdp_browser.py"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new ChannelMaxBrowserWorkerError(
      "INVALID_CONFIG",
      "Could not locate the top-level scripts/cdp_browser.py helper.",
    );
  }
  return found;
}

function configFromEnvironment(): ChannelMaxBrowserWorkerConfig {
  const baseUrl = requiredEnvironment("SSCC_BASE_URL");
  if (
    baseUrl.startsWith("http://") &&
    process.env.CHANNELMAX_ALLOW_HTTP_LOCALHOST !== "1"
  ) {
    throw new ChannelMaxBrowserWorkerError(
      "INVALID_CONFIG",
      "Set CHANNELMAX_ALLOW_HTTP_LOCALHOST=1 only for explicit loopback development.",
    );
  }
  return {
    controlPlaneBaseUrl: baseUrl,
    allowHttpLocalhost:
      process.env.CHANNELMAX_ALLOW_HTTP_LOCALHOST === "1",
    jackieApiToken: requiredEnvironment("JACKIE_API_TOKEN"),
    workerId: requiredEnvironment("CHANNELMAX_WORKER_ID"),
    cdpScriptPath: resolveCdpScriptPath(),
    pythonExecutable: process.env.CHANNELMAX_PYTHON_EXECUTABLE ?? "python3",
    cdpPort: positiveIntegerEnvironment("CHANNELMAX_CDP_PORT", 9222),
    leaseSeconds: positiveIntegerEnvironment("CHANNELMAX_LEASE_SECONDS", 120),
    requestTimeoutMs: positiveIntegerEnvironment(
      "CHANNELMAX_REQUEST_TIMEOUT_MS",
      20_000,
    ),
    cdpTimeoutMs: positiveIntegerEnvironment(
      "CHANNELMAX_CDP_TIMEOUT_MS",
      30_000,
    ),
    idlePollMs: positiveIntegerEnvironment("CHANNELMAX_IDLE_POLL_MS", 5_000),
    maxBackoffMs: positiveIntegerEnvironment(
      "CHANNELMAX_MAX_BACKOFF_MS",
      60_000,
    ),
  };
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const worker = new ChannelMaxBrowserWorker(configFromEnvironment());
    await worker.run(controller.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "ChannelMAX browser worker failed.";
  console.error(
    JSON.stringify({
      level: "error",
      message,
      code:
        error instanceof ChannelMaxBrowserWorkerError
          ? error.code
          : "WORKER_FATAL",
    }),
  );
  process.exitCode = 1;
});
