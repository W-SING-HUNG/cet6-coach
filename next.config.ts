import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * Browser source maps are **off**, and this is deliberate rather than a
   * default being left implicit.
   *
   * Next.js already defaults `productionBrowserSourceMaps` to false — the
   * documented reason is "to prevent you leaking your source on the client".
   * Stating it here makes the intent reviewable: a future edit that turns it on
   * has to argue with a comment that says why not.
   *
   * Note the scope. This flag covers the **browser** bundle only. Next still
   * emits source maps for server-side chunks, and those are checked separately
   * by `tools/check-client-bundle.mjs`, which walks `.next/server/chunks/**`
   * and `.next/build/**` and asserts no machine-identity path appears in them.
   * A published artefact carries the whole `.next/` tree, not just the client
   * slice, so "not served to the browser" is not the same as "not published".
   *
   * Verified against the Next.js documentation for `productionBrowserSourceMaps`.
   */
  productionBrowserSourceMaps: false,
};

export default nextConfig;
