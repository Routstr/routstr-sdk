import { describe, expect, it } from "vitest";
import {
  SDK_STORAGE_KEYS,
  createMemoryDriver,
  createSdkStore,
} from "../../storage";

/**
 * Most basic storage test — baseUrl normalization.
 *
 * The entire SDK revolves around provider baseUrls. If trailing-slash
 * normalization doesn't work, nothing downstream (wallet, client, discovery)
 * can match providers correctly.
 */
describe("storage: baseUrl normalization", () => {
  it("normalizes all baseUrls to include a trailing slash", async () => {
    const seed = {
      [SDK_STORAGE_KEYS.XCASHU_TOKENS]: JSON.stringify({
        "https://provider.example.com": [
          {
            baseUrl: "https://provider.example.com",
            token: "token-1",
            createdAt: Date.now(),
            tryCount: 0,
          },
        ],
      }),
      [SDK_STORAGE_KEYS.BASE_URLS_LIST]: JSON.stringify([
        "https://provider.example.com",
      ]),
      [SDK_STORAGE_KEYS.DISABLED_PROVIDERS]: JSON.stringify([
        "https://provider.example.com",
      ]),
    };

    const driver = createMemoryDriver(seed);
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;

    const state = store.getState();

    // xcashuTokens is a Record keyed by normalized baseUrl
    const tokens = state.xcashuTokens["https://provider.example.com/"];
    expect(tokens).toBeDefined();
    expect(tokens?.[0]?.baseUrl).toBe("https://provider.example.com/");

    expect(state.baseUrlsList).toEqual([
      "https://provider.example.com/",
    ]);
    expect(state.disabledProviders).toEqual([
      "https://provider.example.com/",
    ]);
  });
});
