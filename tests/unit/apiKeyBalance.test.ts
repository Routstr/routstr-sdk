/**
 * Unit tests for `persistApiKeyBalance`, the only writer of API-key balances.
 * It stores whole sats and refuses reads that are unusable or that belong to a
 * key storage no longer holds.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  persistApiKeyBalance,
  stampBalanceRead,
  type BalanceRead,
} from "../../wallet/apiKeyBalance";
import { BalanceManager } from "../../wallet/BalanceManager";
import type { CashuSpender } from "../../wallet/CashuSpender";
import type { ApiKeyEntry } from "../../wallet/interfaces";
import type { SdkLogger } from "../../core/types";

const BASE_URL = "https://provider.example.com/";
const KEY = "sk_key_123";

const read = (overrides: Partial<BalanceRead> = {}): BalanceRead => ({
  amount: 6000,
  reserved: 0,
  unit: "msat",
  apiKey: "",
  isInvalidApiKey: false,
  balanceUnknown: false,
  ...overrides,
});

const createStorage = (storedKey: string | null = KEY) => {
  const writes: Array<[string, number, number | undefined]> = [];
  const storage = {
    getApiKey: (baseUrl: string): ApiKeyEntry | null =>
      storedKey
        ? { baseUrl, key: storedKey, balance: 0, reserved: 0, lastUsed: null }
        : null,
    updateApiKeyBalance: (
      baseUrl: string,
      balance: number,
      reserved?: number
    ) => {
      writes.push([baseUrl, balance, reserved]);
    },
  };
  return { storage, writes };
};

describe("persistApiKeyBalance", () => {
  it("stores whole sats for the key the read came from", () => {
    const { storage, writes } = createStorage();

    expect(persistApiKeyBalance(storage, BASE_URL, KEY, read())).toEqual({
      balance: 6,
      reserved: 0,
    });
    // 1.5 sat is stored as 1: storage keeps whole sats.
    expect(
      persistApiKeyBalance(storage, BASE_URL, KEY, read({ amount: 1500 }))
    ).toEqual({ balance: 1, reserved: 0 });
    // A sats-denominated read is not divided.
    expect(
      persistApiKeyBalance(
        storage,
        BASE_URL,
        KEY,
        read({ amount: 12, unit: "sat", reserved: 3 })
      )
    ).toEqual({ balance: 12, reserved: 3 });
    expect(writes).toEqual([
      [BASE_URL, 6, 0],
      [BASE_URL, 1, 0],
      [BASE_URL, 12, 3],
    ]);
  });

  it("writes nothing when the read is unusable", () => {
    const { storage, writes } = createStorage();
    const unusable = [
      read({ balanceUnknown: true }),
      read({ amount: -1 }),
      read({ reserved: -1 }),
      null,
      undefined,
    ];

    for (const info of unusable) {
      expect(
        persistApiKeyBalance(storage, BASE_URL, KEY, info)
      ).toBeUndefined();
    }
    expect(writes).toEqual([]);
  });

  it.each([
    ["a replacement was stored", "sk_canonical_key_456"],
    ["no key is stored at all", null],
  ])("writes nothing when %s", (_case, storedKey) => {
    const { storage, writes } = createStorage(storedKey);

    expect(
      persistApiKeyBalance(storage, BASE_URL, KEY, read())
    ).toBeUndefined();
    expect(writes).toEqual([]);
  });
});

/**
 * Accounting behind a paid reply runs off the response path, so two requests on
 * one key can settle in either order. The write order is the read-issue order,
 * not the arrival order: these tests pin that an older figure can never move
 * the stored snapshot backwards.
 */
describe("persistApiKeyBalance ordering", () => {
  it("ignores a read issued before the one already stored", () => {
    const { storage, writes } = createStorage();

    expect(
      persistApiKeyBalance(storage, BASE_URL, KEY, read({ amount: 150_000, readSeq: 2 }))
    ).toEqual({ balance: 150, reserved: 0 });
    // Issued first, settled last: its figures are older than what is stored.
    expect(
      persistApiKeyBalance(storage, BASE_URL, KEY, read({ amount: 90_000, readSeq: 1 }))
    ).toBeUndefined();
    expect(writes).toEqual([[BASE_URL, 150, 0]]);
  });

  it("writes a newer read, whatever order it arrives in", () => {
    const { storage, writes } = createStorage();

    persistApiKeyBalance(storage, BASE_URL, KEY, read({ amount: 90_000, readSeq: 1 }));
    expect(
      persistApiKeyBalance(storage, BASE_URL, KEY, read({ amount: 150_000, readSeq: 2 }))
    ).toEqual({ balance: 150, reserved: 0 });
    expect(writes).toEqual([
      [BASE_URL, 90, 0],
      [BASE_URL, 150, 0],
    ]);
  });

  it("orders each key separately, and each client separately", () => {
    // One client, one provider, and the stored key rotates. The sequence for
    // the old key must not retire the fresh one for the key that replaced it.
    let storedKey = KEY;
    const first = {
      storage: {
        getApiKey: (baseUrl: string): ApiKeyEntry => ({
          baseUrl,
          key: storedKey,
          balance: 0,
          reserved: 0,
          lastUsed: null,
        }),
        updateApiKeyBalance: () => {},
      },
      writes: [] as Array<[string, number, number | undefined]>,
    };
    const second = createStorage();

    expect(
      persistApiKeyBalance(first.storage, BASE_URL, KEY, read({ amount: 90_000, readSeq: 9 }))
    ).toEqual({ balance: 90, reserved: 0 });
    storedKey = "sk_second_key";
    expect(
      persistApiKeyBalance(
        first.storage,
        BASE_URL,
        "sk_second_key",
        read({ amount: 150_000, readSeq: 1 })
      )
    ).toEqual({ balance: 150, reserved: 0 });
    // Another client keeps its own sequence, not the module's.
    expect(
      persistApiKeyBalance(second.storage, BASE_URL, KEY, read({ amount: 150_000, readSeq: 1 }))
    ).toEqual({ balance: 150, reserved: 0 });
  });

  it("retires older reads when a newer one is unusable", () => {
    const { storage, writes } = createStorage();

    // A failed read is still newer information than one issued before it.
    expect(
      persistApiKeyBalance(storage, BASE_URL, KEY, read({ balanceUnknown: true, readSeq: 5 }))
    ).toBeUndefined();
    expect(
      persistApiKeyBalance(storage, BASE_URL, KEY, read({ amount: 90_000, readSeq: 4 }))
    ).toBeUndefined();
    expect(writes).toEqual([]);
  });

  it("writes an unstamped read as before", () => {
    const { storage, writes } = createStorage();

    persistApiKeyBalance(storage, BASE_URL, KEY, read({ amount: 90_000, readSeq: 2 }));
    // Hand-built reads (tests, drivers) carry no stamp; ordering needs both
    // sides stamped, so they are written rather than silently dropped.
    expect(
      persistApiKeyBalance(storage, BASE_URL, KEY, read({ amount: 150_000 }))
    ).toEqual({ balance: 150, reserved: 0 });
    expect(writes).toHaveLength(2);
  });
});

/**
 * The stamp has to be taken on the way out, not on the way back: the reads it
 * orders are concurrent, and `getTokenBalance` is where they enter the SDK.
 */
describe("balance read stamping", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stamps when the read is issued, so the later read outranks the earlier", async () => {
    const silent: SdkLogger = {
      log: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => silent,
    };
    const manager = new BalanceManager(
      {} as never,
      {} as never,
      undefined,
      {} as CashuSpender,
      silent
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ balance: 10_000, reserved: 0, api_key: KEY }))
    );

    const before = stampBalanceRead();
    const first = await manager.getTokenBalance(KEY, BASE_URL);
    const second = await manager.getTokenBalance(KEY, BASE_URL);

    expect(first.readSeq).toBeGreaterThan(before);
    expect(second.readSeq).toBeGreaterThan(first.readSeq);

    // Stored in arrival order, the newer read wins and the older is ignored.
    const { storage, writes } = createStorage();
    persistApiKeyBalance(storage, BASE_URL, KEY, second);
    expect(
      persistApiKeyBalance(storage, BASE_URL, KEY, first)
    ).toBeUndefined();
    expect(writes).toEqual([[BASE_URL, 10, 0]]);
  });
});
