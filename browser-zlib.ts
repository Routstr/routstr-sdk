/**
 * Browser fallback for packages that keep a dynamic Node `zlib` import behind
 * a `DecompressionStream` capability check. Modern browsers never call this;
 * the explicit error is clearer on older runtimes than an unresolved module.
 */
export function gunzipSync(): never {
  throw new Error(
    "Gzip decompression requires the browser DecompressionStream API"
  );
}
