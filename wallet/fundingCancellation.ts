/** Cancellation is a gate before new financial work, never an interruption of
 * a send's persistence/recovery. Shared work stays live for any live caller. */
export function throwIfFundingAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
}

export class FundingCallers {
  readonly controller = new AbortController();
  private callers: Array<{ signal?: AbortSignal; onAbort: () => void }> = [];

  add(signal?: AbortSignal): void {
    const onAbort = () => {
      if (this.callers.every((caller) => caller.signal?.aborted)) {
        this.controller.abort();
      }
    };
    this.callers.push({ signal, onAbort });
    signal?.addEventListener("abort", onAbort, { once: true });
    onAbort();
  }

  dispose(): void {
    for (const { signal, onAbort } of this.callers) {
      signal?.removeEventListener("abort", onAbort);
    }
    this.callers = [];
  }
}
