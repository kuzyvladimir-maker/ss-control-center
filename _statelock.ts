// A publisher and a re-poller both do read → mutate → writeFileSync on the same state
// JSON, so they must not overlap. The first guard I wrote asked `pgrep -f "_publish_gen.ts"`,
// which matches ANY process whose command line merely mentions the name — including the
// shell that launched the check. It false-fired the moment a one-liner happened to contain
// the string, and in a cron tick it could wedge the re-poller shut forever.
//
// So: an explicit lock file holding the owner's pid. Held only for the write window,
// verified against a live process, and self-healing if the holder was killed.
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

const lockPath = (stateFile: string) => `${stateFile}.lock`;

/** True when another LIVE process holds the lock for this state file. */
export function stateLocked(stateFile: string): boolean {
  const p = lockPath(stateFile);
  if (!existsSync(p)) return false;
  const pid = Number(readFileSync(p, "utf8").trim());
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; }        // signal 0 = liveness probe, no signal sent
  catch { try { unlinkSync(p); } catch { } return false; }  // holder died mid-run — clear it
}

/** Take the lock and return a release function. Releases on exit too, so a crash or a
 *  Ctrl-C cannot strand it. Throws if someone else holds it — callers decide what to do. */
export function acquireStateLock(stateFile: string): () => void {
  if (stateLocked(stateFile)) throw new Error(`${stateFile} заблокирован другим процессом`);
  const p = lockPath(stateFile);
  writeFileSync(p, String(process.pid));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { if (existsSync(p) && Number(readFileSync(p, "utf8").trim()) === process.pid) unlinkSync(p); } catch { }
  };
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { release(); process.exit(130); });
  return release;
}
