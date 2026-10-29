import type {
  RequestLifecycleDriver,
  RequestLifecycleSummary,
  RequestLifecycleAttempt,
  RequestLifecycleEvent,
} from "./types";
import { matchesLifecycle } from "./memory";
import { sanitizeFields, safeEventData } from "./privacy";
export interface IndexedDBRequestLifecycleDriverOptions {
  dbName?: string;
}
/** Separate database: never bumps the version of the existing usage database. */
export function createIndexedDBRequestLifecycleDriver(
  options: IndexedDBRequestLifecycleDriverOptions = {},
): RequestLifecycleDriver {
  let opening: Promise<IDBDatabase> | undefined;
  const open = () =>
    (opening ??= new Promise((resolve, reject) => {
      const r = indexedDB.open(
        options.dbName ?? "routstr-request-lifecycle",
        1,
      );
      r.onupgradeneeded = () => {
        const db = r.result;
        const requests = db.createObjectStore("requests", {
          keyPath: "requestId",
        });
        requests.createIndex("startedAt", "startedAt");
        requests.createIndex("ownerInstanceId", "ownerInstanceId");
        const attempts = db.createObjectStore("request_attempts", {
          keyPath: "attemptId",
        });
        attempts.createIndex("requestId", "requestId");
        attempts.createIndex("ordinal", ["requestId", "ordinal"], {
          unique: true,
        });
        attempts.createIndex("baseUrlTime", ["baseUrl", "startedAt"]);
        attempts.createIndex("nodeRequestId", "nodeRequestId");
        const events = db.createObjectStore("request_events", {
          keyPath: "eventId",
        });
        events.createIndex("requestId", "requestId");
        events.createIndex("sequence", ["requestId", "sequence"], {
          unique: true,
        });
      };
      r.onerror = () => reject(r.error);
      r.onblocked = () =>
        reject(new Error("Lifecycle IndexedDB upgrade blocked"));
      r.onsuccess = () => {
        r.result.onversionchange = () => r.result.close();
        resolve(r.result);
      };
    }));
  const stores = ["requests", "request_attempts", "request_events"];
  const run = async <T>(
    mode: IDBTransactionMode,
    operation: (tx: IDBTransaction, result: (v: T) => void) => void,
  ): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(tx.error ?? new Error("Lifecycle transaction aborted"));
      try {
        operation(tx, (v) => {
          value = v;
        });
      } catch (e) {
        tx.abort();
        reject(e);
      }
    });
  };
  const modify = (store: string, id: string, fields: object) =>
    run<void>("readwrite", (tx) => {
      const s = tx.objectStore(store);
      const r = s.get(id);
      r.onsuccess = () => {
        if (r.result)
          s.put({
            ...r.result,
            ...sanitizeFields(fields),
            [s.keyPath as string]: id,
          });
      };
    });
  const all = <T>(
    tx: IDBTransaction,
    store: string,
    done: (rows: T[]) => void,
  ) => {
    const r = tx.objectStore(store).getAll();
    r.onsuccess = () => done(r.result);
  };
  const remove = (tx: IDBTransaction, id: string) => {
    tx.objectStore("requests").delete(id);
    for (const name of ["request_attempts", "request_events"]) {
      const r = tx
        .objectStore(name)
        .index("requestId")
        .openCursor(IDBKeyRange.only(id));
      r.onsuccess = () => {
        const c = r.result;
        if (c) {
          c.delete();
          c.continue();
        }
      };
    }
  };
  return {
    async migrate() {
      await open();
    },
    createRequest: (r) =>
      run<void>("readwrite", (tx) => {
        tx.objectStore("requests").add(sanitizeFields(r));
      }),
    updateRequest: (id, f) => modify("requests", id, f),
    createAttempt: (a) =>
      run<void>("readwrite", (tx) => {
        tx.objectStore("request_attempts").add(sanitizeFields(a));
      }),
    updateAttempt: (id, f) => modify("request_attempts", id, f),
    appendEvent: (e) =>
      run<void>("readwrite", (tx) => {
        tx.objectStore("request_events").add({
          ...sanitizeFields(e),
          data: safeEventData(e.data),
        });
      }),
    list: (o = {}) =>
      run<RequestLifecycleSummary[]>("readonly", (tx, done) => {
        all<RequestLifecycleSummary>(tx, "requests", (requests) =>
          all<RequestLifecycleAttempt>(tx, "request_attempts", (attempts) =>
            done(
              requests
                .filter((request) =>
                  matchesLifecycle(
                    {
                      request,
                      attempts: attempts.filter(
                        (a) => a.requestId === request.requestId,
                      ),
                      events: [],
                    },
                    o,
                  ),
                )
                .sort((a, b) => b.startedAt - a.startedAt)
                .slice(0, Math.max(0, o.limit ?? 100)),
            ),
          ),
        );
      }),
    getTrace: (id) =>
      run("readonly", (tx, done) => {
        const r = tx.objectStore("requests").get(id);
        r.onsuccess = () => {
          if (!r.result) {
            done(undefined);
            return;
          }
          const a = tx
            .objectStore("request_attempts")
            .index("requestId")
            .getAll(id);
          a.onsuccess = () => {
            const e = tx
              .objectStore("request_events")
              .index("requestId")
              .getAll(id);
            e.onsuccess = () =>
              done({
                request: r.result,
                attempts: a.result.sort(
                  (a: RequestLifecycleAttempt, b: RequestLifecycleAttempt) =>
                    a.ordinal - b.ordinal,
                ),
                events: e.result.sort(
                  (a: RequestLifecycleEvent, b: RequestLifecycleEvent) =>
                    a.sequence - b.sequence,
                ),
              });
          };
        };
      }),
    deleteOlderThan: (timestamp) =>
      run<number>("readwrite", (tx, done) =>
        all<RequestLifecycleSummary>(tx, "requests", (rows) => {
          const old = rows.filter((r) => r.startedAt < timestamp);
          for (const r of old) remove(tx, r.requestId);
          done(old.length);
        }),
      ),
    clear: () =>
      run<void>("readwrite", (tx) => {
        for (const s of stores) tx.objectStore(s).clear();
      }),
    reconcileInterrupted: (owner) =>
      run<number>("readwrite", (tx, done) =>
        all<RequestLifecycleSummary>(tx, "requests", (rows) => {
          const stale = rows.filter(
            (r) => r.ownerInstanceId === owner && r.outcome === "in_progress",
          );
          const now = Date.now();
          for (const r of stale) {
            tx.objectStore("requests").put({
              ...r,
              outcome: "interrupted",
              updatedAt: now,
              endedAt: now,
              durationMs: now - r.startedAt,
            });
            const a = tx
              .objectStore("request_attempts")
              .index("requestId")
              .getAll(r.requestId);
            a.onsuccess = () => {
              for (const row of a.result)
                if (row.outcome === "in_progress")
                  tx.objectStore("request_attempts").put({
                    ...row,
                    outcome: "failed",
                    endedAt: now,
                  });
            };
            const e = tx
              .objectStore("request_events")
              .index("requestId")
              .getAll(r.requestId);
            e.onsuccess = () =>
              tx
                .objectStore("request_events")
                .add({
                  eventId: globalThis.crypto.randomUUID(),
                  requestId: r.requestId,
                  sequence:
                    Math.max(
                      0,
                      ...e.result.map((e: RequestLifecycleEvent) => e.sequence),
                    ) + 1,
                  timestamp: now,
                  type: "request_interrupted",
                });
          }
          done(stale.length);
        }),
      ),
  };
}
