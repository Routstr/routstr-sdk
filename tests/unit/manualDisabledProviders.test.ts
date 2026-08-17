/**
 * Tests for the manual vs. auto-disabled providers fix.
 *
 * Bug: syncReviewedProvidersFromNostr() was replacing the entire disabled
 * list with only review-based entries, silently re-enabling manually-disabled
 * providers that had an lgtm Nostr review.
 *
 * Fix: separate storage for manually-disabled providers; getDisabledProviders()
 * returns the union of both sets; setDisabledProviders() (review sync) never
 * touches manuallyDisabledProviders.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { createMemoryDriver } from "../../storage/drivers/memory";
import { createSdkStore } from "../../storage/store";
import {
  createDiscoveryAdapterFromStore,
} from "../../storage/store";
import type { DiscoveryAdapter } from "../../discovery/interfaces";

function makeAdapter(): DiscoveryAdapter {
  const driver = createMemoryDriver();
  const { store } = createSdkStore({ driver });
  return createDiscoveryAdapterFromStore(store);
}

// ─── Storage layer ──────────────────────────────────────────────────────────

describe("manual vs auto disabled providers — storage layer", () => {
  it("getDisabledProviders returns the union of review-disabled and manually-disabled", async () => {
    const adapter = makeAdapter();

    // Simulate syncReviewedProvidersFromNostr writing review-based disables
    adapter.setDisabledProviders!(["https://review-bad.example.com/"]);

    // Simulate routstrd providers disable writing a manual disable
    adapter.setManuallyDisabledProviders!(["https://manual-bad.example.com/"]);

    const effective = adapter.getDisabledProviders();
    expect(effective).toContain("https://review-bad.example.com/");
    expect(effective).toContain("https://manual-bad.example.com/");
  });

  it("setDisabledProviders (review sync) does NOT clobber manually-disabled providers", async () => {
    const adapter = makeAdapter();

    // User manually disables a provider
    adapter.setManuallyDisabledProviders!(["https://manual-bad.example.com/"]);

    // syncReviewedProvidersFromNostr runs and replaces the review list
    adapter.setDisabledProviders!(["https://other-review-bad.example.com/"]);

    const effective = adapter.getDisabledProviders();
    // Manual disable must survive the review sync
    expect(effective).toContain("https://manual-bad.example.com/");
    // Review disable is present too
    expect(effective).toContain("https://other-review-bad.example.com/");
  });

  it("a provider with a lgtm review is re-enabled from the review set but remains if manually disabled", async () => {
    const adapter = makeAdapter();

    const providerUrl = "https://provider.example.com/";

    // Provider is first review-disabled (no lgtm)
    adapter.setDisabledProviders!([providerUrl]);

    // User also manually disables it
    adapter.setManuallyDisabledProviders!([providerUrl]);

    // Provider gets an lgtm review → review sync drops it from review-disabled
    adapter.setDisabledProviders!([]); // empty review-disabled list

    // Still manually disabled → must stay in effective list
    const effective = adapter.getDisabledProviders();
    expect(effective).toContain(providerUrl);
  });

  it("manually enabling a provider removes it from the effective disabled set", async () => {
    const adapter = makeAdapter();

    const providerUrl = "https://provider.example.com/";

    adapter.setManuallyDisabledProviders!([providerUrl]);
    expect(adapter.getDisabledProviders()).toContain(providerUrl);

    // User runs "routstrd providers enable"
    adapter.setManuallyDisabledProviders!([]);
    expect(adapter.getDisabledProviders()).not.toContain(providerUrl);
  });

  it("manually enabling a review-disabled provider overrides the review disable", async () => {
    const adapter = makeAdapter();

    const providerUrl = "https://review-bad.example.com/";

    // Review sync disables a provider without an lgtm review
    adapter.setDisabledProviders!([providerUrl]);
    expect(adapter.getDisabledProviders()).toContain(providerUrl);

    // User force-enables it
    adapter.setManuallyEnabledProviders!([providerUrl]);
    expect(adapter.getDisabledProviders()).not.toContain(providerUrl);
  });

  it("setDisabledProviders (review sync) respects manually-enabled providers", async () => {
    const adapter = makeAdapter();

    const providerUrl = "https://review-bad.example.com/";

    adapter.setManuallyEnabledProviders!([providerUrl]);

    // Review sync runs and would disable the provider, but it is manually enabled
    adapter.setDisabledProviders!([providerUrl]);

    expect(adapter.getDisabledProviders()).not.toContain(providerUrl);
  });

  it("getManuallyDisabledProviders returns only user-intent disables", async () => {
    const adapter = makeAdapter();

    adapter.setDisabledProviders!(["https://review-bad.example.com/"]);
    adapter.setManuallyDisabledProviders!(["https://manual-bad.example.com/"]);

    expect(adapter.getManuallyDisabledProviders()).toEqual([
      "https://manual-bad.example.com/",
    ]);
    expect(adapter.getManuallyDisabledProviders()).not.toContain(
      "https://review-bad.example.com/"
    );
  });
});

// ─── URL normalisation ───────────────────────────────────────────────────────

describe("manual vs auto disabled providers — URL normalisation", () => {
  it("normalises provider URLs with trailing slash", async () => {
    const adapter = makeAdapter();

    // Without trailing slash
    adapter.setManuallyDisabledProviders!(["https://provider.example.com"]);

    const effective = adapter.getDisabledProviders();
    expect(effective).toContain("https://provider.example.com/");
  });
});
