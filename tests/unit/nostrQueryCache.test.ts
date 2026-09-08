import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryDriver,
  createShardedDiscoveryAdapter,
} from "../../storage";
import { SDK_STORAGE_KEYS } from "../../storage/keys";

describe("discovery query storage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("defaults an unreadable query cache without failing adapter initialization", async () => {
    const memory = createMemoryDriver();
    const adapter = await createShardedDiscoveryAdapter({
      driver: {
        ...memory,
        getItem: async <T>(key: string, fallback: T) => {
          if (key === SDK_STORAGE_KEYS.NOSTR_QUERY_LAST_UPDATE)
            throw new Error("unreadable cache");
          return memory.getItem(key, fallback);
        },
      },
    });
    expect(adapter.getNostrQueryLastUpdate!()).toEqual({});
  });

  it("keeps fresh in-memory query times when the cache cannot be written", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const memory = createMemoryDriver();
    const adapter = await createShardedDiscoveryAdapter({
      driver: {
        ...memory,
        setItem: async (key: string, value: unknown) => {
          if (key === SDK_STORAGE_KEYS.NOSTR_QUERY_LAST_UPDATE)
            throw new Error("quota");
          return memory.setItem(key, value);
        },
      },
    });
    const queryTimes = { '["38421"]': Date.now() };
    adapter.setNostrQueryLastUpdate!(queryTimes);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(adapter.getNostrQueryLastUpdate!()).toEqual(queryTimes);
  });
});
