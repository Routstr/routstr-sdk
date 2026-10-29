import { describe, expect, it, vi } from "vitest";
import { awaitWithAbort } from "../../client/abortable";

describe("awaitWithAbort", () => {
  it("returns operation results and cleans listeners", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    expect(await awaitWithAbort(Promise.resolve(42), controller.signal)).toBe(
      42,
    );
    expect(remove).toHaveBeenCalledOnce();
  });
  it("preserves operation rejection", async () => {
    const failure = new Error("discovery failed");
    await expect(
      awaitWithAbort(Promise.reject(failure), new AbortController().signal),
    ).rejects.toBe(failure);
  });
  it("handles already-aborted callers without unhandled underlying rejection", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      awaitWithAbort(Promise.resolve(1), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
