# Plan: move the model-path whitelist out of the SDK and onto Nostr (kind 38427)

## Goal

Today the auto-pinning "model path" policy is compiled into the SDK:
`DEEPSEEK_MODEL_PATH_WHITELIST` (the ordered upstream routes), `DEEPSEEK_AUTO_MODEL_ID`
(the one model that gets auto-pinned) and `DEEPSEEK_AUTO_NODE_URLS` (the three nodes
allowed to serve it) are all constants in `utils/modelPaths.ts`. Adding a route,
turning the feature off, adding a second model, or dropping a node all require an SDK
release + a client redeploy.

Move that policy onto Nostr as an authoritative signed snapshot, exactly the way
`MODEL_ID_MAPPINGS` already works: **kind 38427, `d` tag `model-path-whitelist`,
authored by `routstrModelsPubkey`** (falling back to `routstrPubkey`), fetched through
the existing relay/trust/persistence pipeline, with the constants demoted to an
offline bootstrap fallback.

After this change:

| Policy | Today | After |
| --- | --- | --- |
| Route whitelist (order = preference) | `DEEPSEEK_MODEL_PATH_WHITELIST` const | `models[id].routes` in the 38427 snapshot |
| Which models get auto-pinned | `DEEPSEEK_AUTO_MODEL_ID` (1 model) | the key set of `models` (N models) |
| Nodes allowed to serve the pin | `DEEPSEEK_AUTO_NODE_URLS` (3 consts) | `models[id].nodes` — optional; omitted means "any enabled node that advertises the route" (§2.1) |
| Turn the feature off | ship a release | publish `{"models":{}}` |

Non-goals:

- Changing the selector wire format, the `x-routstr-model-path` header, or the node-side
  `GET /v1/models/paths` contract. The SDK keeps using the node's **verbatim** advertised
  selector; nothing here builds a selector from scratch.
- Changing failover semantics, cooldown scoping, or the deposit/reserve math
  (`ProviderManager.getRequiredSatsForModel` keeps using the pinned route's own
  `sats_pricing`).
- Making the request path wait on a relay. The snapshot is hydrated during
  bootstrap/refresh only; routing reads it synchronously from the adapter.
- Discovering nodes from this event. Nodes stay discovered by kind 38421 + review-synced
  by kind 38425. `nodes`, when present, is an **allowlist/priority over the enabled set**,
  not a node source; when absent the SDK probes the enabled set itself and lets the
  `/v1/models/paths` probe decide capability (§2.1).

Validation baseline: `routstr-sdk` local `main`. Anchors below are given as
`file:symbol` rather than line numbers where practical.

---

## 1. What is hardcoded today

| Anchor | What it is | Consumed by |
| --- | --- | --- |
| `utils/modelPaths.ts:DEEPSEEK_MODEL_PATH_WHITELIST` | ordered `{url, endpoint?}` routes; index 0 = default pin | `whitelistedDeepSeekRoute`, `resolveDeepSeekModelPathSelectors`, `deepSeekModelPath` |
| `utils/modelPaths.ts:DEEPSEEK_AUTO_MODEL_ID` | `"deepseek-v4.1-flash"` | `resolveRequestContext.isAutoModelPathModel` |
| `utils/modelPaths.ts:DEEPSEEK_AUTO_NODE_URLS` / `DEEPSEEK_AUTO_NODE_URL` | 3 node base URLs | `ProviderManager.getModelPathProviderRanking`, forced-provider branch of `resolveRequestContext` |
| `utils/index.ts` | re-exports all of the above (public API) | hosts (`routstrd`), scripts, skill script |
| `tests/unit/*` | 6 test files assert the exact constants | — |

Two behaviours worth restating because the plan preserves them exactly:

1. **Route order is load-bearing.** `available[0]` is the default pin *and* the node
   ranking metric *and* the deposit envelope. The Nostr snapshot must never be sorted or
   re-ordered by the SDK — array order is the contract.
2. **A selector is only valid on the node that advertised it.** `resolveDeepSeekModelPathSelectors`
   returns the node's own advertised strings verbatim, so a whitelist entry can only ever
   pin a route the target node actually serves. This is what bounds the blast radius of a
   bad snapshot (§9).

---

## 2. The event — kind 38427

| Field | Value |
| --- | --- |
| kind | `38427` |
| addressable (`d`) tag | `model-path-whitelist` |
| author | `routstrModelsPubkey` (falls back to `routstrPubkey`) |
| relays | same set as 38421/38423/38425/38426 (`nostrRelays` or `DEFAULT_NOSTR_RELAYS`) |
| content | complete JSON snapshot (below) |

```json
{
  "version": 1,
  "models": {
    "deepseek-v4.1-flash": {
      "nodes": [
        "https://ai.redsh1ft.com",
        "https://routstr.otrta.me",
        "https://api.nonkycai.com"
      ],
      "routes": [
        { "url": "https://openrouter.ai/api/v1", "endpoint": "deepseek" },
        { "url": "https://openrouter.ai/api/v1", "endpoint": "fireworks" },
        { "url": "https://api.ppq.ai" },
        { "url": "https://openrouter.ai/api/v1", "endpoint": "venice/fp8" },
        { "url": "https://openrouter.ai/api/v1", "endpoint": "wafer" },
        { "url": "https://api.venice.ai/api/v1" },
        { "url": "https://api.fireworks.ai/inference/v1" }
      ]
    }
  }
}
```

**Why one snapshot event instead of one event per model** (`#d` = model id): the mapping
snapshot (38426) already establishes the "one `d` tag, complete replacement, newest wins"
pattern, and reusing it means one fetch, one cache slot, one persistence path, one set of
tests. Per-model events would give independent refresh and smaller blast radius, but also
make "is this model auto-pinned at all?" depend on the presence of an event, and make
removal a delete. Revisit only if the snapshot outgrows a relay-friendly size (see §5
caps).

**Why a per-model `routes` array instead of a shared route pool**: two models commonly
share an upstream (`openrouter.ai/api/v1`) but not an `endpoint` set, and each has its own
preference order. A pool + per-model ordering indirection would be harder to validate.
Duplication is fine — the snapshot is small.

### 2.1 `nodes` is optional — the probe is the capability gate

**The node list is not required.** Nothing in the protocol or the code needs it: a selector
is only ever sent verbatim from the *target node's own* `/v1/models/paths` response
(`resolveModelPathSelectors`), so any node that advertises a whitelisted route can serve
the pin. The existing comment on `DEEPSEEK_AUTO_NODE_URLS` already states the intent to
drop it in favour of capability discovery.

Semantics of the field:

| `nodes` | Candidate set for that model |
| --- | --- |
| present (non-empty) | that allowlist, in priority order (also the equal-cost tiebreak) |
| absent or `[]` | every discovered provider minus the disabled set, filtered per-node as today |

The candidates are then filtered identically either way: model must be in the node's
catalog (`findModelForId`), Tor/clearnet invariant, not disabled by the 38425 review sync,
not on cooldown, mint-acceptable, and the per-model lookup
`getNodeModelPathsForModel` (`GET /v1/models/paths/model?model_id=...`) must resolve a
whitelisted route. Empty results (including 404) and failed/budget-exceeding lookups are
skipped. A node with no matching path support is therefore excluded by the probe itself
— that *is* the capability signal.

**Why the list still exists at all** — probed evidence, `plans/model-paths-enabled-providers-2026-10-09.json`:

| Node (enabled set, 12 nodes) | Advertises whitelisted route? | Per-route pricing? | In the hardcoded list |
| --- | --- | --- | --- |
| `ai.redsh1ft.com` | yes (2 routes) | yes | yes |
| `routstr.otrta.me` | yes (2 routes) | yes | yes |
| `api.nonkycai.com` | probe: `terminated` | — | yes |
| `llm.satsandsports.cash` | yes (2 routes) | **no** (`sats_pricing: null`) | **no** |
| other 8 enabled nodes | no (no paths / no model / 404 / 401) | — | no |

3 of 12 enabled nodes advertise the model; only 6 of 12 even answer `/v1/models/paths`
with 200. So the hardcoded 3 are frozen curation, not the capable set — removing the field
*widens* eligibility (notably admitting `llm.satsandsports.cash`) and therefore changes the
default pin wherever a newly-eligible node is cheaper, along with the deposit envelope that
follows the pinned route's `max_cost`.

**Two prerequisites before publishing `nodes` as absent/empty:**

1. **Verify the existing per-model fetch protections with widened candidates.** Current
   ranking already uses `getNodeModelPathsForModel`, with negative caching and exponential
   backoff, in-flight deduplication, stale-while-revalidate, and a `withBudget` ranking
   wrapper (`MODEL_PATH_RANKING_BUDGET_MS`). Successful empty results (including 404) are
   cached too. Retain these protections and test them with `nodes` absent/empty; no new
   negative memo is required. The older full-catalog `getNodeModelPaths` helper does not
   cache failures, but it is not the ranking path and must not replace the per-model
   lookup. The earlier full-catalog probe artifact is evidence of capability, not a
   measurement of current per-request round-trips; recheck the per-model endpoint before
   widening eligibility.
2. **A decision on metadata-less nodes.** `llm.satsandsports.cash` advertises the
   whitelisted routes with `sats_pricing: null`, so it enters the ranking on the
   `model.sats_pricing?.completion` fallback and the deposit gate falls back to the model
   aggregate instead of a route envelope — the route-vs-aggregate mixing
   `ProviderManager.getRequiredSatsForModel` warns about. **Implementation decision:
   accept this existing pre-metadata fallback**, rather than changing pricing eligibility
   in this feature. Probe reports must make missing metadata visible before widening.

The field therefore stays in the snapshot as an *override*, not a requirement: publish it
to restrict/prioritise, omit it to let the probe decide. Whichever shape becomes the
default, both must be exercised by tests (§6) and validated by the probe (§7 step 2).

`version` is advisory and currently must be `1` (absent is accepted as 1). An unknown
`version` makes the snapshot invalid, so a future incompatible shape can be published
without old clients mis-parsing it.

---

## 3. Semantics

Mirror `fetchModelIdMappings` / `applyModelIdMappingEvents` exactly:

| Situation | Behaviour |
| --- | --- |
| Snapshot with ≥1 model | replaces the whole policy: those models auto-pin, everything else does not |
| Snapshot with zero models (`{"models":{}}`) | **feature off**: no model auto-pins; requests degrade to the normal unpinned price ranking |
| Absent / malformed / invalid / forge-rejected event | last good snapshot retained; genuinely nothing ever accepted → bundled fallback |
| Two valid events, different versions | newest `created_at` wins; ties broken by lowest `id` (ascending lexicographic, as in 38426 / Nostr replaceable-event ordering) |
| Fresh install, relays unreachable | bundled bootstrap snapshot (= today's hardcoded values, so first-run behaviour is unchanged) |
| Configured author changes | the stored projection is discarded and rebuilt only from events for the new author |

The empty-snapshot rule is the one deliberate semantic difference from 38426: 38426's
empty snapshot clears mappings and falls back to the bundled table only on a *fresh*
install; here the bundled table is a bootstrap value and a published empty snapshot is an
explicit, immediate kill switch that survives restarts. That is the whole point of moving
this to Nostr — being able to stop pinning without a release — so it must not silently
fall back to the constants.

**Resolution of a requested model id.** `models` keys are expected to be canonical model
ids (`MODEL_ID_MAPPINGS` values / routstr21 spellings), but lookup goes through
`modelIdVariants(requestedId, mappings)` — canonical first, then mapped variants — so a
publisher that (or a client that) spells it `deepseek-v4-1-flash` still resolves. This is
the same spelling-closure trick `resolveDeepSeekModelPathSelectors` already applies to
node catalog entries. Keys that collide after canonicalization make the snapshot invalid
(§4).

---

## 4. Validation (all-or-nothing)

`parseModelPathWhitelist(event.content, mappings)` throws → `isModelPathWhitelistEvent`
returns false → the event is ignored wholesale, never partially applied. `mappings` is
an explicit snapshot captured after `fetchModelIdMappings` completes for this discovery
pass (§5.3), not an adapter read performed separately for each candidate. Reject when:

- content is not JSON, or not an object;
- `models` is absent, `null`, an array, or not an object;
- model count > **100** or routes per model > **200** (mirrors the `too many mappings`
  guard in `parseModelIdMappings`); `nodes` per model > **50**;
- a model key is empty/whitespace, or is `__proto__` / `constructor` / `prototype`
  (prototype-pollution guard, same list as the 38426 parser); build the map with
  `Object.create(null)` or a `Map` so a `__proto__` key can never reach the prototype;
- two model keys canonicalize to the same id (via `canonicalizeModelId` with the explicit
  mapping snapshot captured for this pass) — otherwise "which entry wins" would silently
  depend on key order;
- `routes` is absent, not an array, or empty;
- a route is not an object, or `url` is empty/whitespace, or `endpoint` is present but
  empty/whitespace, or `url` is not an absolute `http(s)` URL;
- `nodes` is present but not an array, or contains an empty/non-`http(s)` string; `nodes`
  absent or `[]` is valid and means "probe the enabled set" (§2.1), not "no candidates";
- any validation that makes the identity ambiguous.

Normalization applied *at parse time*, so downstream comparisons are exact:

- Route `url`: use an idempotent WHATWG `URL` parse/serialize normalizer. Scheme and host
  are case-insensitive; default ports are removed; an empty root path and `/` are
  equivalent (`https://api.ppq.ai` → `https://api.ppq.ai/`). Standard URL parsing also
  resolves dot segments. Preserve serialized path case, non-root trailing slashes,
  non-default ports, and query values/order; do not sort query parameters, decode/re-encode
  path escapes manually, or strip a slash from a non-root path. In particular `/v1` and
  `/v1/` remain distinct. Reject credentials and fragments in policy route URLs; advertised
  selectors containing either cannot match a policy route. Keep the normalized form only
  for **matching**; the header value is always the node's own advertised string.
- `endpoint`: exact, case-sensitive matching; do not trim or otherwise normalize a valid
  non-empty value. Absent and present are distinct identities.
- `nodes`: strip a trailing `/` and lowercase the host, then run through
  `normalizeProviderUrl` so they compare with discovered base URLs.
- **Dedupe by normalized `(url, endpoint)` keeping the first occurrence, never sorting.**
  A duplicate is dropped silently (a publisher typo) rather than invalidating the snapshot;
  dropping the *later* copy preserves preference order.

Fields other than `version`, `models`, and the documented per-model fields are ignored, so
the publisher can add annotations without a client release. Unknown fields inside a route
object are ignored for the same reason, but a *bad* known field invalidates the snapshot.

Note the exact-match consequence of normalization: `whitelistedDeepSeekRoute` currently
matches `route.url === params.url` on the raw advertised string. After this change both
sides go through the same normalizer (`normalizeRoute(url, endpoint)`), so a node
advertising `https://api.ppq.ai/` matches the snapshot's `https://api.ppq.ai`. The explicitly
listed equivalences can merge previously distinct strings; deduplication keeps the first
policy occurrence but does not prove that arbitrary URLs are interchangeable. Do not add
further equivalences implicitly. Test normalization idempotence and both matching and
nonmatching cases, and continue sending the advertised selector verbatim.

---

## 5. Code changes

### 5.1 `core/modelPathWhitelist.ts` (new — the contract)

Mirrors `core/modelMappings.ts` (which holds the contract) with `utils/modelPaths.ts`
keeping encoding/fetch/matching.

```ts
export interface ModelPathRoute { url: string; endpoint?: string }

export interface ModelPathPolicy {
  /** Ordered upstream routes; index 0 is the default pin. Never re-sorted. */
  routes: ModelPathRoute[];
  /**
   * Optional node allowlist/priority, intersected with the enabled discovered set.
   * Absent or empty means "any enabled node that advertises the route" — the SDK then
   * probes every non-disabled discovered provider and skips the ones that cannot
   * resolve a route. See §2.1.
   */
  nodes?: string[];
}

/** undefined when the model is not auto-pinned in this snapshot. */
export type ModelPathWhitelist = Record<string, ModelPathPolicy>;

/** Bundled fallback: exactly today's constants. Used only before a snapshot is accepted. */
export const MODEL_PATH_BOOTSTRAP: ModelPathWhitelist = { ... };

export function parseModelPathWhitelist(content: string,
  mappings: ModelIdMappings): ModelPathWhitelist;                             // throws on invalid
export function modelPathPolicyFor(id: string, whitelist: ModelPathWhitelist,
  mappings?: ModelIdMappings): ModelPathPolicy | undefined;                    // via modelIdVariants
export function canonicalizeModelPathKey(id: string, mappings?: ModelIdMappings): string;
```

Implementation decision: use a JSON-safe record built with `Object.create(null)` and
own-property lookups. Persist normalized variant keys rather than canonical keys frozen
under the mappings active at first acceptance; canonical-first lookup uses the current
mapping snapshot. This avoids `Map` serialization and prototype hazards.

Backward-compatible re-exports in `utils/modelPaths.ts`: `DEEPSEEK_MODEL_PATH_WHITELIST`
becomes `MODEL_PATH_BOOTSTRAP[<canonical id>].routes`, `DEEPSEEK_AUTO_MODEL_ID` becomes the
first bootstrap key, `DEEPSEEK_AUTO_NODE_URLS` becomes its `nodes`, `DEEPSEEK_AUTO_NODE_URL`
stays `DEEPSEEK_AUTO_NODE_URLS[0]`. They remain exported (public API, used by `routstrd`,
scripts and the `model-paths` skill) but are documented as "bundled fallback only; the
runtime policy comes from the adapter snapshot". They currently live in `utils/modelPaths.ts`;
moving the source of truth to `core/` and re-deriving them keeps `utils/index.ts` exports
stable.

### 5.2 Discovery adapter + storage

Follow the 38426 plumbing 1:1 so there is one well-understood pattern.

| File | Change |
| --- | --- |
| `discovery/interfaces.ts` | 6 new members: `getModelPathWhitelist`, `setModelPathWhitelist`, `getModelPathWhitelistEvent`, `setModelPathWhitelistEvent`, `getModelPathWhitelistLastUpdate?`, `setModelPathWhitelistLastUpdate?` |
| `storage/keys.ts` | `MODEL_PATH_WHITELIST_EVENT`, `MODEL_PATH_WHITELIST`, `LAST_MODEL_PATH_WHITELIST_UPDATE` |
| `storage/types.ts` | 3 fields on `SdkStorageState` |
| `storage/store.ts` | defaults (`null`), 3 setters writing through `driver.setItem`, 3 hydration `getItem` entries in the existing `Promise.all`, state assembly, and the 6 adapter accessors |
| `storage/shardedDiscoveryAdapter.ts` | hydrate the 3 raw values, hold `_modelPathWhitelist*` vars, expose the 6 adapter methods next to the `-- Kind 38426 model ID mappings (kv) --` block |

Required (not optional) methods, matching the precedent set for 38426: the constructor
throws `DiscoveryAdapter must implement <method> for the Nostr model-path whitelist`. Both
in-repo adapters get them, and the two hand-rolled adapters in
`tests/unit/modelManagerCacheInvariant.test.ts` / `modelManagerNostrCollection.test.ts` need
the same treatment as their existing `mappings` plumbing. README gets a migration note
alongside the existing 38426 one.

### 5.3 `discovery/ModelManager.ts`

```ts
const DISCOVERY_KINDS = [38421, 38423, 38425, 38426, 38427];
const MODEL_PATH_WHITELIST_D_TAG = "model-path-whitelist";
```

New private/public members, structurally identical to the mappings ones:

- `getModelPathWhitelist()` — synchronous, `adapter.getModelPathWhitelist() ?? MODEL_PATH_BOOTSTRAP`. This is the **only** thing the request path reads; it never fetches.
- `parseModelPathWhitelist(event, mappings)` / `isModelPathWhitelistEvent(event, mappings)` — kind, author, `d` tag, trust gate, then the §4 parser using the explicit mappings argument.
- `applyModelPathWhitelistEvents(events, mappings)` — merge the adapter's *saved signed event* with fetched candidates, filter, sort by descending `created_at` then ascending `id` (`b.created_at - a.created_at || a.id.localeCompare(b.id)`), take the first, persist event + projection + `lastUpdate`, return the projection. Use the same captured mappings for every candidate. If none is valid under those mappings, retain the last-good projection and signed event; do not clear them or restore bootstrap merely because mappings changed.
- `fetchModelPathWhitelist(forceRefresh)` — **first await `fetchModelIdMappings(forceRefresh)`**, then capture its returned snapshot for all whitelist validation and application in this call. After that dependency completes, use the mappings-style cache-TTL short-circuit, hydrate the saved event into the event store, query `getNostrEvents({kinds:[38427], "#d":[MODEL_PATH_WHITELIST_D_TAG], authors:[routstrModelsPubkey]}, forceRefresh, undefined, e => this.isModelPathWhitelistEvent(e, mappings))`, then apply with those same mappings. A changed mapping snapshot must bypass the whitelist TTL shortcut so collision validation runs even when the whitelist event has not changed. If the mapping fetch fails, use the last-good mappings (or their bundled fallback); never race validation against an unfinished fetch.
- Constructor: add the 4 required methods to the arity loop. Restore mappings before parsing the saved whitelist. Purge whitelist state for an author/trust mismatch, but do not discard a previously accepted projection merely because changed mappings now produce a collision; retain the last-good state as above.
- `refreshNostrEvents()`: replace the standalone 38426 fetch with `fetchModelPathWhitelist(true)`, which owns the ordered mappings → whitelist chain; add 38427 to the doc comment listing tracked kinds.
- `bootstrapProviders()`: replace the standalone mappings fetch in both prefetch paths (warm-cache branch + Nostr branch) with `fetchModelPathWhitelist(forceRefresh)`; `bootstrapFromHttp()` likewise. Unrelated discovery work may remain parallel, but **never put mappings and whitelist application in independent `Promise.all` siblings**. The same dependency must hold for direct calls to `fetchModelPathWhitelist`, not just these orchestration sites.
- Optionally expose `getModelPathWhitelistEvent()` / a debug dump for hosts, matching whatever `routstrd` does for mappings.

### 5.4 `utils/modelPaths.ts` — parameterize, stop reading constants

| Function | Change |
| --- | --- |
| `whitelistedDeepSeekRoute(selector)` | → `whitelistedModelPathRoute(selector, routes: readonly ModelPathRoute[])`; match on normalized `(url, endpoint)` (§4) |
| `isWhitelistedDeepSeekModelPath(selector)` | → `isWhitelistedModelPath(selector, routes)` |
| `resolveDeepSeekModelPathSelectors(nodePaths, modelId, mappings?)` | → `resolveModelPathSelectors(nodePaths, modelId, routes, mappings?)`; the `selectors`/`satsPricing` arrays become `routes.length` long |
| `deepSeekModelPath(modelId, route?)` | default route param dropped or kept pointing at `MODEL_PATH_BOOTSTRAP[0].routes[0]`; the builder is otherwise generic |
| `canonicalModelPath`, `modelPathCandidateKey`, `sameNode`, `fetchModelPaths`, `parseModelPathsPayload`, `getNodeModelPaths`, `getNodeModelPathsForModel`, `MODEL_PATH_HEADER`, caches | **unchanged**; retain per-model alias lookup, negative caching/backoff, in-flight dedupe, and stale-while-revalidate |

Keep `...DeepSeek...` aliases delegating to the generic functions for one minor release
(the model-paths skill and external scripts import them), then remove in the next major.

### 5.5 `client/ProviderManager.ts`

`getModelPathProviderRanking(modelId, options)`:

1. Read the policy: `const policy = modelPathPolicyFor(modelId, this.getModelPathWhitelist(), this.getModelIdMappings())`; **return `[]` when undefined** (model not auto-pinned → caller degrades to unpinned ranking, same as an empty ranking today when all nodes are down).
2. Candidate nodes: `policy.nodes?.length ? policy.nodes : Object.keys(this.discoveryAdapter.getCachedModels())` (§2.1). Keys from the store are already normalized while snapshot entries are normalized at parse time (§4), so both branches compare consistently. Every existing guard stays: `excludeBaseUrl(s)`, mint acceptance, disabled set, Tor/clearnet invariant, cooldown, `findModelForId`, `getNodeModelPathsForModel` (with mappings and the catalog model's native/alias spellings), `resolveModelPathSelectors(nodePaths, modelId, policy.routes, mappings)`. Keep the existing `withBudget(..., MODEL_PATH_RANKING_BUDGET_MS)` wrapper: a slow node is skipped for this ranking while its fetch can fill the cache for later requests. Never substitute the full-catalog fetch.
3. `available[0]` still anchors the node's cost; the request-local `excludeModelPaths` filter still runs *after* ranking, so node-major failover ordering is preserved (the comment block explaining this must survive the edit).
4. `sort((a, b) => a.cost - b.cost)` is stable, so equal-cost nodes keep candidate order — i.e. the snapshot's `nodes` order is the tiebreak when present, and the store's key order otherwise. Worth a one-line comment.
5. When `nodes` is absent/empty, the candidate fan-out is the whole enabled set. Preserve and test the existing per-model negative caching/backoff, empty-result caching, in-flight dedupe, stale-while-revalidate, and ranking budget (§2.1). Log candidate/probed node counts at debug so widening is observable; candidate count is not necessarily HTTP fetch count because lookups may be cached or deduplicated.

Add a small `getModelPathWhitelist()` helper on `ProviderManager` mirroring
`getModelIdMappings()` (`this.discoveryAdapter.getModelPathWhitelist?.() ?? MODEL_PATH_BOOTSTRAP`).
Also update `warmModelPathCaches(options)`; leaving it hardcoded would warm removed
policies and miss newly enabled models/nodes:

- Default `modelIds` to the runtime whitelist's model keys, canonicalized/deduplicated
  using the same captured mappings. An empty whitelist returns `[]` without HTTP calls.
  Explicit `modelIds` restrict warming to requested models that have a policy; they must
  not re-enable bootstrap policies absent from the runtime snapshot.
- For each model, derive candidate nodes from its policy, using the same optional-`nodes`
  semantics and discovered/enabled intersection as ranking. Share policy lookup and
  candidate-selection logic where practical, preserving allowlist order and disabled,
  transport, and catalog checks. Keep warming-specific behavior distinct from ranking's
  request-local cooldown, exclusion, and mint filters.
- Resolve coverage with `resolveModelPathSelectors(nodePaths, modelId, policy.routes,
  mappings)`, not the bootstrap/DeepSeek resolver. Capture policy and mappings once for
  the warm pass so a mid-pass refresh does not mix policies.
- Preserve per-model spellings, `force: true`, warm budget, per-lookup reporting, and the
  never-throw contract. Forced warming intentionally bypasses freshness/backoff, unlike
  ordinary ranking; retain in-flight deduplication.

The rest of `ProviderManager` is untouched.

### 5.6 `client/resolveRequestContext.ts`

- `isAutoModelPathModel(id, whitelist, mappings)` → `modelPathPolicyFor(id, whitelist, mappings) !== undefined`. Keeps the current "any spelling of the model counts" behaviour and generalizes it to N models.
- Auto branch: identical flow — `getModelPathProviderRanking`, `pickAcceptableProvider`, pin `best.selectors[0]`, else fall back to `getProviderPriceRankingForModel` unpinned.
- Forced-provider branch: resolve the model's policy first. When it exists, use
  `const nodeAllowed = !policy.nodes?.length || policy.nodes.some(node => normalizeProviderUrl(new URL(node).href) === normalizeProviderUrl(new URL(normalizedProvider).href))`.
  Preserve provider path/query case; do not use `sameNode`, which lowercases the whole URL.
  Absent/empty `nodes` permits any otherwise eligible forced provider; a non-empty list
  requires membership. Only auto-pin when `nodeAllowed` is true and the node advertises
  a route matching `policy.routes`, using the existing per-model lookup. Preserve existing
  forced-provider eligibility checks, including disabled-provider rejection and model
  availability. A missing policy, excluded node, or unresolved route leaves the request
  unpinned **on the forced provider**. Keep `pinnedProvider: true`: no cross-provider
  failover, while existing same-provider retries remain allowed.

### 5.7 Untouched but verify

`client/RoutstrClient.ts` (failover hops call `getModelPathProviderRanking`, so a refreshed
snapshot takes effect on the next hop without a restart — confirm no constant imports),
`client/fetchAIResponse.ts`, `routeRequests.ts` (both only pass `autoModelPath` /
`MODEL_PATH_HEADER` through). `utils/index.ts` exports extended.

---

## 6. Tests

New `tests/unit/nostrModelPathWhitelist.test.ts`, modelled on
`tests/unit/nostrModelIdMappings.test.ts` (same `RelayPool` mock, same `finalizeEvent`
helpers, same `createMemoryDriver` / `createDiscoveryAdapterFromStore` /
`createShardedDiscoveryAdapter` harness):

```
fetch
  - queries exactly { kinds:[38427], "#d":["model-path-whitelist"], authors:[pubkey] }
  - accepts only the configured author and d tag; replaces the bootstrap fallback
  - forged signature → ignored; created_at beyond the future-drift window → ignored
  - valid newer event replaces; equal created_at chooses the lexicographically lowest id
    regardless of arrival order; assert the exact winner after restart and pruning too

validation (each case leaves the previous good snapshot in place and the saved event id unchanged)
  - not JSON / not an object / missing models / models null / models array
  - model key __proto__ | constructor | prototype | empty
  - two keys canonicalizing to the same id using the explicitly supplied mappings
  - route with empty url / non-http url / empty endpoint / routes empty / routes absent
  - nodes absent | [] | containing a non-http string | containing an empty string
  - >100 models / >200 routes / >50 nodes
  - unknown extra fields are ignored, not fatal
  - duplicate normalized (url, endpoint) keeps the first occurrence and does not reorder
  - URL normalization is idempotent; scheme/host case, empty root vs /, default ports,
    and dot segments follow the documented WHATWG equivalences
  - non-root trailing slash, path case, non-default port, query values/order, and endpoint
    presence/case remain distinct; credentials/fragments reject policy URLs and cannot
    match advertised selectors; matching always returns the original selector verbatim
  - unknown `version` invalidates

semantics
  - {"models":{}} → getModelPathWhitelist() is empty AND survives a restart (kill switch)
  - offline on a fresh install → MODEL_PATH_BOOTSTRAP
  - offline after a successful fetch → last good snapshot (not the fallback)
  - author change discards the stored projection
  - bootstrap (warm cache, Nostr, and HTTP), refresh, and direct whitelist fetch all await
    mappings before whitelist validation; delay the mapping response to prove the order
  - mappings fetched in the same pass introduce an alias collision → candidate rejected
    consistently, independent of relay response timing
  - changed mappings bypass a fresh whitelist TTL and trigger collision revalidation
  - a mapping refresh that makes a saved whitelist collide retains the last-good
    projection and signed event, not bootstrap; the same holds after restart
  - mapping fetch failure uses last-good mappings (bundled mappings on a fresh install)
  - restart without a persistent event DB cannot roll back to an older relay event
  - pruneSupersededDiscoveryEvents keeps the newest 38427 and drops superseded versions
  - sharded adapter persists projection + lastUpdate + signed event
  - missing adapter method → ModelManager constructor throws

routing (ProviderManager / resolveRequestContext level)
  - snapshot with two models: each pins its own routes; a requested model absent from the
    snapshot gets no auto-pin and routes unpinned
  - requested variant spelling resolves to the snapshot's canonical key
  - node list is honoured (node not in `nodes` is never a candidate) and is intersected
    with the disabled/review set
  - route ordering: routes[0] is the pin; removing routes[0] in the next snapshot changes
    the pin without touching routes[1..] order
  - forced provider with nodes omitted or [] → pins an advertised whitelisted route
  - forced provider in a non-empty allowlist → pins an advertised whitelisted route
  - forced provider outside a non-empty allowlist, without a policy, or without a matching
    route → remains on that provider, unpinned
  - disabled forced provider or unavailable model → existing rejection preserved
  - forced requests never cross-provider fail over; existing same-provider retries remain
  - nodes absent → every non-disabled discovered provider is a candidate; nodes that cannot
    resolve a route are skipped without failing the ranking
  - nodes present → a node outside the allowlist is never a candidate even when it
    advertises the route
  - widened candidates still use only per-model HTTP lookups, not the full catalog;
    repeated failed lookups honor negative backoff, successful empty/404 results are cached,
    concurrent rankings dedupe in-flight fetches, and stale entries refresh in background
  - cold/hung widened candidates respect MODEL_PATH_RANKING_BUDGET_MS; timed-out ranking
    candidates can fill the cache for subsequent calls without stalling this ranking
  - a metadata-less node (route advertised, sats_pricing null) is ranked on the model-level
    fallback and the deposit gate receives no route envelope (§2.1)
  - getModelPathProviderRanking returns [] for a model with an empty/absent policy
    → resolveRequestContext falls back to the unpinned price ranking

warming (ProviderManager.warmModelPathCaches)
  - two runtime models with distinct routes/node policies warm exactly their eligible pairs
  - omitted/[] nodes uses the discovered eligible set; non-empty nodes restricts candidates;
    disabled, transport-mismatched, and catalog-missing nodes are skipped
  - explicit modelIds restricts warming to active policies, never reinstating bootstrap
  - refreshed policy warms newly added models/nodes/routes and stops warming removed ones
  - empty runtime snapshot returns [] and makes no path requests, including after restart
  - forced per-model warming retains spelling keys, warm budget, reporting, in-flight
    dedupe, and never-throw behavior; its results are consumed by subsequent ranking
```

Updates to existing suites: `modelPaths.test.ts` (constructor params, normalized matching,
bootstrap-derived constants), `modelPathAliasResolution.test.ts`,
`autoModelPath.test.ts`, `fetchAIResponseModelPath.test.ts`, `pinnedModelPathFailover.test.ts`,
`providerManagerPricing.test.ts` (all currently import `DEEPSEEK_AUTO_NODE_URLS` /
`DEEPSEEK_MODEL_PATH_WHITELIST` — they can keep importing the aliases, or inject a snapshot
through the adapter, which is the better long-term form), plus the two hand-rolled adapters.

---

## 7. Publisher + rollout

Order matters: publish the event **before** the client change ships, so both code paths
agree and drift is detectable.

1. **Publisher** (outside this repo — the 38426 publisher tooling). Publish kind 38427,
   `d=model-path-whitelist`, content = §2 example *with today's exact values*: one model
   `deepseek-v4.1-flash`, the 7 routes in current order, the 3 current nodes. Verify the
   signature and that the event lands on all three default relays.
2. **Grader**: the `model-paths` skill script (`scripts/fetch-model-paths.mjs`) already
   enumerates every route per model per node and reports coverage as `distinct routes` vs
   `whitelisted routes`. Extend it (or use `--json`) to diff the *published snapshot*
   against the routes the enabled nodes actually advertise — a route the publisher lists
   that no node advertises is dead weight, and a route nodes advertise that the publisher
   omits is a coverage gap. It must also report, per model, **which enabled nodes are
   capable** (advertise the model with ≥1 whitelisted route) and whether the snapshot's
   `nodes` matches that set — that report is the evidence for the later `nodes`-absent step
   (§2.1), and it already produces exactly this table from the 2026-10-09 artifact. Record
   the artifact under `plans/` as the existing `deepseek-model-path-verification.md` does.
3. **Client**: land §5 with the fallback still equal to the published snapshot. Behaviour is
   identical either way, so the change is safe to release and observable: log the accepted
   snapshot's `created_at` (debug) and the model count.
4. **Verify** with the probe at both depths: `--node <one of the 3> --no-discovery` and the
   full discovery run; confirm the pinned route for `deepseek-v4.1-flash` on
   `ai.redsh1ft.com` is unchanged, i.e. still the OpenRouter `deepseek` subprovider.
5. **Then** the policy becomes remotely mutable: append routes, add a second model, add or
   drop nodes, and publish `{"models":{}}` as the off switch — each verified the same way.
6. **Follow-up decision** (separate change, not this plan): after one or two releases,
   shrink `MODEL_PATH_BOOTSTRAP` to empty so a fresh install with no relay access does *not*
   auto-pin. Keeping the fallback forever means a relay outage silently reinstates a policy
   the publisher may have deliberately turned off.
7. **Independent follow-up**: publish a snapshot with `nodes` omitted/`[]` (probe-driven
   candidates) after verifying the existing per-model cache/backoff, dedupe, stale refresh,
   ranking budget, and runtime-driven warming with the widened set (§6), and resolving the
   metadata-less-node decision (§2.1). Re-probe the per-model endpoint and compare the
   resulting pin per model against the allowlisted variant using §7 step 2's report.
   No new negative memo or additional release waiting period is required. Because the
   two live in the same event, this is a publish, not a release.

Note the 21-minute `cacheTTL` cadence: a policy change reaches a long-running client on its
next `refreshNostrEvents` / bootstrap, or immediately at process start. There is no
per-request fetch, by design (§3).

---

## 8. Compatibility

- **Public API**: `DEEPSEEK_*` exports keep working as fallback-derived values; the
  `resolve...`/`is...` functions keep `DeepSeek`-named aliases for one minor. Removing them
  is a separate breaking change.
- **DiscoveryAdapter**: 6 new required methods — a breaking change for out-of-tree adapters,
  same as 38426 was. Document it in README with the same wording style.
- **Storage**: 3 new keys; absent keys are `null`/default and self-heal on first fetch. No
  migration needed. The sharded adapter's one-time non-model hydration block just grows by
  3 `getItem`s.
- **Node side**: nothing. 38427 is a client-policy event; nodes never read it, and the SDK
  keeps sending the node's own advertised selector.
- **Protocol docs**: `protocol/` has RIP-02 (38421) and no RIP for 38426 either. Adding a RIP
  for 38427 is out of scope for this repo change but should be filed so the kind is
  documented; until then the kind is routstr-internal, consistent with 38423/38425/38426.

---

## 9. Risks

| Risk | Analysis | Mitigation |
| --- | --- | --- |
| Compromised publisher pins traffic somewhere bad | The SDK can only send a selector the target node **advertises verbatim**, and the target node must be in `nodes` ∩ the 38421+38425 enabled set. So the blast radius is "route to an upstream that a reviewed node already serves", plus per-route price/reserve effects. | Keep matching verbatim; validate `http(s)` urls; keep the nodes∩enabled intersection; make the event author the same key that already controls 38423/38426 |
| Snapshot reorders routes by accident (insert at index 0) | Silently changes the default pin, the node ranking metric, and the deposit envelope — the highest-consequence footgun in this area | Order-preserving parser (no sort), dedupe-keeps-first, publisher checklist in §7, and a test asserting a prepended route changes the pin |
| Reserve/402 regressions from a route's `max_cost` | The gate reads the **pinned route's own** `max_cost`/`max_prompt_cost`/`max_completion_cost`; new routes bring new envelopes | Unchanged by this plan (schema already carries them). Probe step 2 records per-route pricing so a bad envelope is visible before it ships |
| Empty snapshot mistaken for "relays down" | Would silently keep pinning after an operator tried to stop | Distinct code paths and distinct tests: empty *parsed* snapshot → empty policy; *no valid event* → last good/fallback |
| A stale relay rolling back the policy | Relays can re-serve older replaceable versions | Saved signed event merged into candidates + `created_at`/`id` ordering + persisted projection (the 38426 rollback test generalizes directly) |
| Extra latency | Widened candidates increase cold per-model lookups and background refresh work. Current ranking already caches failures/empty results, deduplicates in-flight fetches, serves bounded stale entries, and budgets waiting per candidate | Preserve `getNodeModelPathsForModel` and ranking budgets, test widened candidates, make warming runtime-policy-driven, and log candidate/probed counts (§2.1, §5.5) |
| Widening eligibility moves the pin | With `nodes` absent, a newly path-capable node (`llm.satsandsports.cash` in the 2026-10-09 probe) enters the ranking and can take the default pin, changing the deposit envelope with it | Expected, but validate a widened snapshot with the probe (§7 step 2) before publishing it; keep `nodes` as the override when a pin must stay fixed |
| Metadata-less node prices the reserve off the model aggregate | `getRequiredSatsForModel` falls back to `model.sats_pricing` when the resolved route carries no metadata — the mixing its own comment warns about | Decide explicitly (§2.1); reject or accept candidates without per-route pricing |
| Second model auto-pinned without intent | Generalizing to N models means a typo'd key silently enables pinning for another model | Validate key collisions, log accepted model keys, ship with exactly one key |

---

## 10. Open questions

1. **`nodes` required or optional?** *Resolved:* optional. Present = allowlist + priority/tiebreak; absent or `[]` = "any enabled node that advertises the route", which is exactly the probe-driven behaviour and matches the existing comment on `DEEPSEEK_AUTO_NODE_URLS`. The wider probe fan-out must retain the existing per-model cache/backoff and budget protections (§2.1); publishing the first snapshot with `nodes` present keeps today's behaviour byte-for-byte, so the field can be dropped later as its own validated step. Metadata-less candidates retain the existing fallback (§2.1).
2. **Empty snapshot: kill switch (recommended) or fall back to bootstrap?** The
   recommendation is the whole point of the feature, but it is a deliberate divergence from
   38426's "empty clears mappings" plus fallback-on-fresh-install, so it should be an
   explicit sign-off.
3. **Snapshot-in-one-event vs per-model `#d` events** — §2 recommends one; the trade is
   independent per-model refresh vs one fetch/cache/persist path.
4. **Snapshot key spelling** — accept any mapped variant key and resolve via
   `modelIdVariants` (recommended), or require canonical keys and reject the rest?
5. **Rename `*DeepSeek*` to generic names now or later?** Later, with aliases, to keep this
   change reviewable.
6. **Does anything need per-model caps** (e.g. a maximum auto-pinned model count) so a bad
   snapshot cannot make *every* model take the pinned path? A cap of, say, 8 is cheap
   insurance and matches the "one model today" baseline.
7. **Who publishes, and can the publisher tooling read `plans/` artifacts?** Step 1 assumes a
   publisher exists for 38426 that can be pointed at a new kind + d tag; confirm.

---

## 11. Follow-ups (not in this change)

- Publish a snapshot with `nodes` omitted (or `[]`) so candidate selection is fully
  probe-driven after the widened-candidate checks and metadata-less-node decision in
  §7 step 7. Existing per-model negative caching needs verification, not a new memo or
  release waiting period. The comment on `utils/modelPaths.ts`'s `DEEPSEEK_AUTO_NODE_URLS`
  already describes capability discovery as the intent; retain the optional allowlist
  as an override when explicit restriction/priority is needed.
- Shrink `MODEL_PATH_BOOTSTRAP` to empty (§7 step 6).
- Remove the `DeepSeek`-named aliases in the next major.
- File the RIP for kind 38427 alongside whatever documents 38423/38425/38426.


## 12. Implementation notes / operational limits

- The SDK keeps the signed event as a version high-water mark even if changed mappings
  invalidate its content; an older otherwise-valid candidate cannot roll back the policy.
  Whitelist passes are serialized and all validators use one captured mappings snapshot.
- Timestamp ties choose the lowest event ID in both application and stored-event
  reads/pruning. Applesauce EventStore otherwise keeps first arrival at equal timestamps;
  the SDK handles this specifically for kind 38427 without changing other kinds.
- The four policy/event adapter accessors are required. Timestamp accessors remain
  optional, matching 38426. Warming keeps existing reports for skipped candidates
  (`reason: "disabled"`, etc.) without performing HTTP for them.
- No publisher or live probe is run by this implementation. The referenced
  `scripts/fetch-model-paths.mjs` is not present in this checkout; publisher/grader tooling
  and live rollout verification in §7 remain operational follow-ups, not SDK changes.

- Exact kind-38426 mapping keys/values remain case-sensitive during policy collision
  checks and lookup (for example `variant` → `Canonical`). Only unmapped request
  spellings use lowercase compatibility for historical DeepSeek casing. Provider
  allowlist comparison normalizes scheme/host but preserves path/query case.
