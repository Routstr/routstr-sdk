import { afterEach, describe, expect, it, vi } from "vitest";
import { localStorageDriver } from "../../storage/drivers/localStorage";

describe("credential storage failures", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("reports quota exhaustion instead of acknowledging an unsaved key", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("window", { localStorage: {
      setItem: () => { throw new DOMException("full", "QuotaExceededError"); },
      removeItem: vi.fn(),
    } });
    await expect(localStorageDriver.setItem("api_keys", [{ key: "fixture" }])).rejects.toMatchObject({ name: "QuotaExceededError" });
  });

  it("rejects an unreadable record without deleting credentials", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const removeItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { getItem: () => "{invalid", removeItem } });
    await expect(localStorageDriver.getItem("api_keys", [])).rejects.toThrow();
    expect(removeItem).not.toHaveBeenCalled();
  });
});
