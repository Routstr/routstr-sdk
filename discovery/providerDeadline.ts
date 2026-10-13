/**
 * Bound the caller's wait for the whole HTTP operation, including its body.
 * Some runtimes do not honor abort during connect. Cancellation is therefore
 * best effort; operations must return data only, never publish cache updates.
 */
export function withProviderDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Provider request timed out after ${timeoutMs}ms`);
      error.name = "TimeoutError";
      reject(error);
      controller.abort();
    }, timeoutMs);
  });
  // Promise.race observes even a late rejection from a runtime ignoring abort.
  const request = Promise.resolve().then(() => operation(controller.signal));
  return Promise.race([request, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
