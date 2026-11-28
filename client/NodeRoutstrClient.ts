import { RoutstrClient, type AlertLevel, type RouteRequestParams, type RoutstrClientConfig, type RoutstrClientMode, type RoutstrResponse } from "./RoutstrClient";
import { createEnclavaRequiredTransport, type EnclavaRequiredOptions } from "./NodeEnclavaTransport";
import { isTinfoilModel } from "./TinfoilSecure";
import { ModelManager, type ModelManagerConfig } from "../discovery/ModelManager";
import type { DiscoveryAdapter } from "../discovery/interfaces";
import type { WalletAdapter, StorageAdapter } from "../wallet/interfaces";

export interface NodeRoutstrClientConfig extends RoutstrClientConfig {
  enclava?: Omit<EnclavaRequiredOptions, "events"> & {
    discovery?: Pick<ModelManagerConfig, "routstrPubkey" | "nostrRelays" | "filterLocalNetworkUrls">;
  };
}

export class NodeRoutstrClient extends RoutstrClient {
  private readonly attested?: { origin: string; send: ReturnType<typeof createEnclavaRequiredTransport> };

  constructor(
    walletAdapter: WalletAdapter, storageAdapter: StorageAdapter, discoveryAdapter: DiscoveryAdapter,
    alertLevel: AlertLevel, mode: RoutstrClientMode = "xcashu", options: NodeRoutstrClientConfig = {},
  ) {
    super(walletAdapter, storageAdapter, discoveryAdapter, alertLevel, mode, options);
    const config = options.enclava;
    if (!config) return;
    const { origin, coordinate } = config;
    const manager = new ModelManager(discoveryAdapter, { ...config.discovery, logger: options.logger });
    const send = createEnclavaRequiredTransport({ ...config, events: {
      async getEnclavaAnnouncement() {
        await manager.assertEnclavaProviderReviewed(coordinate, origin);
        return manager.getEnclavaAnnouncement(coordinate);
      },
      getEnclavaRelease: id => manager.getEnclavaRelease(id),
    } });
    this.attested = { origin, send };
  }

  protected override async routeTeeRequired(params: RouteRequestParams): Promise<RoutstrResponse> {
    const configured = this.attested;
    if (!configured) return super.routeTeeRequired(params);
    if (this.getMode() !== "apikeys" || !params.pinnedProvider ||
        (params.baseUrl !== configured.origin && params.baseUrl !== `${configured.origin}/`) ||
        params.method !== "POST" || params.path !== "/v1/chat/completions" || params.autoModelPath ||
        params.userCacheSecret !== undefined || params.lifecycle || params.requestLifecycleDriver ||
        params.trackLifecycle === true || params.deadlines || params.reservedBalanceWaitMs !== undefined) {
      throw new Error("TEE-required routing supports only pinned, non-streaming chat in API-key mode");
    }
    const key = params.teeRequired?.providerApiKey;
    if (typeof key !== "string" || !/^[\x21-\x7e]+$/.test(key)) throw new Error("TEE-required routing needs an explicit provider API key");
    const body = JSON.stringify(params.body);
    const wire = body === undefined ? undefined : JSON.parse(body);
    if (!wire || typeof wire.model !== "string" || !wire.model.trim() ||
        (wire.stream !== undefined && wire.stream !== false) || isTinfoilModel(wire.model) ||
        (params.modelId !== undefined && isTinfoilModel(params.modelId))) {
      throw new Error("TEE-required routing needs a non-streaming chat body with a native model ID");
    }
    const headers = new Headers(params.headers);
    for (const name of ["authorization", "x-api-key", "x-cashu", "x-routstr-model-path"]) {
      if (headers.has(name)) throw new Error("Use the explicit provider key and native model in TEE-required routing");
    }
    headers.set("authorization", `Bearer ${key}`);
    headers.set("content-type", "application/json");
    const outgoing: Record<string, string> = {};
    headers.forEach((value, name) => { outgoing[name] = value; });
    return configured.send({ path: params.path, method: "POST", headers: outgoing, body, signal: params.signal });
  }
}
