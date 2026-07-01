/**
 * Tiny build/version stamp shown in a page corner so the owner can confirm at a
 * glance whether a deploy actually landed. The version is a human label we bump
 * per release; the commit SHA (from Vercel's build env) changes on EVERY deploy,
 * so if the 7-char hash is different from last time, the new build is live.
 *
 * Server component — reads VERCEL_GIT_COMMIT_SHA at build/runtime. Reusable on
 * any module page: <VersionBadge module="Bundle Factory" version="v2.0" />.
 */
export function VersionBadge({
  module,
  version,
}: {
  module: string;
  version: string;
}) {
  const sha = (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7);
  return (
    <div
      className="pointer-events-none fixed bottom-2 right-2 z-50 select-none rounded-md bg-green px-2.5 py-1 font-mono text-[11px] font-medium leading-none text-green-cream shadow-md"
      title={sha ? `build ${sha}` : "local build"}
    >
      {module} {version}
      {sha ? ` · ${sha}` : " · dev"}
    </div>
  );
}
