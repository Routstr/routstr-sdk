# Request lifecycle tracking

The SDK creates one full UUID for each logical inference request, before discovery
in `routeRequests` / `fetchAIResponse`, or at `RoutstrClient.routeRequest` for direct
callers. Request-local context survives same-provider retries and failover. It is
never sent to nodes by default.

## Persistent daemon integration

```ts
import { beginRequestLifecycle, routeRequests } from '@routstr/sdk';
import { createBunSqliteRequestLifecycleDriver } from '@routstr/sdk/bun';

const driver = await createBunSqliteRequestLifecycleDriver({ dbPath: DB_PATH });
await driver.migrate();
// Only reconcile the previous instance you own, not other active SDK owners.
if (previousOwnerInstanceId) await driver.reconcileInterrupted(previousOwnerInstanceId);
const lifecycle = await beginRequestLifecycle({
  driver, ownerInstanceId, method: 'POST', path: '/v1/chat/completions',
  modelId: 'deepseek-v4.1-flash', clientId: 'alice',
});
const response = await routeRequests({ ...routingOptions, lifecycle, signal });
```

The SDK owns terminal finalization after routing handoff. An ingress rejecting
before handoff must call `await lifecycle.finish({ outcome: 'failed', httpStatus: 400 })`
and set `x-routstr-sdk-request-id` itself. `finish` is idempotent. On a client
disconnect, abort the supplied signal. Consume or cancel streaming responses;
headers alone are not a successful terminal outcome. `response.finalize?.()`
awaits accounting but does not turn an unfinished client stream into success.

## IDs and compatibility

- `response.requestId` / `x-routstr-sdk-request-id`: SDK logical UUID, immediately available.
- `response.nodeRequestId` / unchanged `x-routstr-request-id`: final node attempt ID.
- `response.upstreamResponseId`: provider JSON/SSE body ID, when inspected.
- Each actual HTTP attempt has a distinct `attemptId` and request-local ordinal.
- Optional raw sink `requestLogId` remains separate and is linked to its attempt.

New usage rows use the SDK UUID as `requestId`, with `nodeRequestId` and
`upstreamResponseId` separate. Historical rows are not rewritten. Consumers that
previously interpreted provider IDs in usage rows should use
`entry.upstreamResponseId ?? entry.requestId`.

For example, a 400 from A followed by a 200 from B is one request with two
attempts (distinct node IDs), `attemptCount: 2`, `retryCount: 0`,
`failoverCount: 1`, `providerCount: 2`. Its trace contains ordered events and its
terminal outcome is succeeded only after a non-streaming response is processed
or a client-facing stream closes cleanly.

## Drivers and queries

Types, `beginRequestLifecycle`, `shouldTrackRequestLifecycle`,
`getDefaultRequestLifecycleDriver`, `setDefaultRequestLifecycleDriver`,
`createMemoryRequestLifecycleDriver`, and `createIndexedDBRequestLifecycleDriver`
are browser-safe exports from `@routstr/sdk` / `@routstr/sdk/storage`.
Node exports `createSqliteRequestLifecycleDriver` from `@routstr/sdk/node` and
`@routstr/sdk/storage/node`. Bun exports the asynchronous factory above from
`@routstr/sdk/bun` and `@routstr/sdk/storage/bun`.

Drivers provide `migrate`, `list({ limit, before, after, outcome, modelId,
baseUrl, clientId })`, `getTrace(requestId)`, `deleteOlderThan(timestamp)`,
`clear`, and exact-owner `reconcileInterrupted(ownerInstanceId)`. Traces expose
`request`, ordinal-ascending `attempts`, and sequence-ascending `events`.
SQLite uses separate `requests`, `request_attempts`, and `request_events` tables
in the selected file. IndexedDB uses a separate lifecycle database, avoiding
usage database version conflicts. Non-browser defaults use bounded memory;
production servers should explicitly supply persistent drivers and schedule
`deleteOlderThan` retention.

`requestLifecycleDriver` can be supplied on client config or individual wrapper
calls. `trackLifecycle: false` opts custom metadata calls out; known metadata
routes and non-POST calls are excluded by the eligibility predicate.

## Privacy and persistence errors

Lifecycle records are diagnostics, not raw payload logs. They do not record
prompts, completions, auth/payment credentials, proofs, cookies, or provider
error envelopes. Error text is replaced by a generic diagnostic; structured
codes and whitelisted small event fields remain. Raw request/response logging
continues to require the separate opt-in sink.

Writes are serialized per request; initial creation and finalization are awaited.
Persistence errors are fail-open: they are logged and exposed through
`lifecycle.trackingErrors`, and must not change routing or payment results.
