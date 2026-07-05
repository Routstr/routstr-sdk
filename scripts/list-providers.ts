import { ModelManager } from "@routstr/sdk";
import { createShardedDiscoveryAdapter } from "@routstr/sdk/storage";
import { createSqliteDriver } from "@routstr/sdk/storage/node";

async function main(): Promise<void> {
  const adapter = await createShardedDiscoveryAdapter({ driver: createSqliteDriver() });
  const modelManager = new ModelManager(adapter);
  const providers = await modelManager.bootstrapProviders(false);
  await modelManager.fetchModels(providers);
  const uniqueProviders = Array.from(new Set(providers)).sort();

  for (const url of uniqueProviders) {
    console.log(url);
  }
}

main().catch((error) => {
  console.error("Failed to fetch Routstr providers:", error);
  process.exit(1);
});
