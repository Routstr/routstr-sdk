import { ModelManager, ProviderManager } from "@routstr/sdk";
import { createSdkStore } from "@routstr/sdk/storage";
import { createSqliteDriver } from "@routstr/sdk/storage/node";
import {
  createDiscoveryAdapterFromStore,
} from "@routstr/sdk/storage";

async function main(): Promise<void> {
  const modelId = process.argv[2]?.trim();
  if (!modelId) {
    console.error("Usage: npx tsx scripts/find-model-providers.ts <model-id>");
    process.exit(1);
  }

  const start = Date.now();
  const logStep = (label: string): void => {
    const elapsedSeconds = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[${new Date().toISOString()}] +${elapsedSeconds}s ${label}`);
  };

  logStep(`Starting lookup for model: ${modelId}`);
  const { store, hydrate } = createSdkStore({ driver: createSqliteDriver() });
  await hydrate;
  const adapter = createDiscoveryAdapterFromStore(store);

  logStep("Bootstrapping providers and fetching models...");
  const modelManager = await ModelManager.init(adapter);
  const providerManager = new ProviderManager(adapter);
  logStep("Bootstrapped providers and fetched models.");

  logStep("Ranking providers by request cost...");
  const ranking = providerManager.getProviderPriceRankingForModel(modelId);
  logStep(`Ranked ${ranking.length} matching providers.`);

  if (ranking.length === 0) {
    console.log(`No providers found for model: ${modelId}`);
    return;
  }

  const { basket } = ranking[0];
  console.log(
    `Basket: ${basket.promptTokens} prompt @ ${(basket.cacheHitRate * 100).toFixed(0)}% cache hit / ` +
      `${(basket.cacheWriteRate * 100).toFixed(0)}% cache write, ${basket.outputTokens} output`
  );

  for (const entry of ranking) {
    const { breakdown, rates } = entry;
    console.log(
      `${entry.baseUrl} cost=${entry.cost.toFixed(2)} sats ` +
        `(fresh=${breakdown.freshInputSats.toFixed(2)} ` +
        `cache-read=${breakdown.cacheReadSats.toFixed(2)} ` +
        `cache-write=${breakdown.cacheWriteSats.toFixed(2)} ` +
        `out=${breakdown.outputSats.toFixed(2)}) ` +
        `rates: prompt=${rates.prompt} cache-read=${rates.cacheRead} (${rates.cacheReadSource}) ` +
        `cache-write=${rates.cacheWrite} (${rates.cacheWriteSource}) completion=${rates.completion} ` +
        `request=${breakdown.requestSats.toFixed(2)} (reserved, not billed)`
    );
  }
}

main().catch((error) => {
  console.error("Failed to find providers for model:", error);
  process.exit(1);
});
