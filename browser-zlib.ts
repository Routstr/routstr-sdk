// Browser fallback for @tinfoilsh/verifier's capability-gated Node fallback.
// Modern browsers use DecompressionStream and never call this function.
export function gunzipSync(): never {
  throw new Error(
    "Gzip decompression requires the browser DecompressionStream API"
  );
}
