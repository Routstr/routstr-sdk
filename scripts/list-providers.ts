import { ModelManager } from "@routstr/sdk";
import { createSdkStore, createDiscoveryAdapterFromStore } from "@routstr/sdk/storage";
import { createSqliteDriver } from "@routstr/sdk/storage/node";

async function main(): Promise<void> {
  const { store, hydrate } = createSdkStore({ driver: createSqliteDriver() });
  await hydrate;
  const adapter = createDiscoveryAdapterFromStore(store);
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
