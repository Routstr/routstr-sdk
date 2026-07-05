import { ModelManager, ProviderManager } from "@routstr/sdk";
import {
  createShardedDiscoveryAdapter,
  createProviderRegistryFromDiscoveryAdapter,
} from "@routstr/sdk/storage";
import { createSqliteDriver } from "@routstr/sdk/storage/node";

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
  const adapter = await createShardedDiscoveryAdapter({ driver: createSqliteDriver() });
  const providerRegistry = createProviderRegistryFromDiscoveryAdapter(adapter);

  logStep("Bootstrapping providers and fetching models...");
  const modelManager = await ModelManager.init(adapter);
  const providerManager = new ProviderManager(providerRegistry);
  logStep("Bootstrapped providers and fetched models.");

  logStep("Ranking providers by pricing...");
  const ranking = providerManager.getProviderPriceRankingForModel(modelId);
  logStep(`Ranked ${ranking.length} matching providers.`);

  if (ranking.length === 0) {
    console.log(`No providers found for model: ${modelId}`);
    return;
  }

  for (const entry of ranking) {
    const prompt = entry.promptPerMillion.toFixed(2);
    const completion = entry.completionPerMillion.toFixed(2);
    const total = entry.totalPerMillion.toFixed(2);
    console.log(
      `${entry.baseUrl} prompt=${prompt} sats/M completion=${completion} sats/M total=${total} sats/M`
    );
  }
}

main().catch((error) => {
  console.error("Failed to find providers for model:", error);
  process.exit(1);
});
