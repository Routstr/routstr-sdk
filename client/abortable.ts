/** Stop awaiting discovery/preflight when the caller disconnects. The underlying
 * shared discovery/cache operation may complete, but routing must not continue. */
export async function awaitWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    // The operation may already have started; always observe its rejection.
    void operation.catch(() => {});
    throw new DOMException("Request aborted", "AbortError");
  }
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("Request aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
