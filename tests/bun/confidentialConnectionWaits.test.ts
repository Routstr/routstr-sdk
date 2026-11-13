/**
 * A kept confidential connection must not hold what it waited for (review
 * finding 25). Under Bun (JavaScriptCore), every `Promise.race` against the
 * connection's long-lived failure promise left a reaction on it that kept the
 * race's result (the awaited control frame, proof result or record) reachable
 * for the connection's life. routstrd runs on Bun.
 */
import { test, expect } from "bun:test";
import { ConfidentialConnection } from "../../client/confidential/connection";
import { chatSuffixKeys } from "../../client/confidential/suffix";
import { VENICE_CHAT } from "../unit/fixtures/chat";

test("a control frame awaited on a live connection is released after the wait", async () => {
  const conn = new ConfidentialConnection({
    baseUrl: "http://127.0.0.1:1",
    offer: { v: 3, notary_pubkey: "00".repeat(32), chat: VENICE_CHAT, suffix_keys: chatSuffixKeys(VENICE_CHAT) },
    auth: "sk-x",
    prover: {},
  } as never) as any;
  const refs: WeakRef<object>[] = [];
  for (let i = 0; i < 30; i++) {
    await (async () => {
      const msg = { type: "x", pad: "y".repeat(1 << 16) + i };
      const p = conn.wait(["x"], 1000);
      setTimeout(() => conn.inbox.push("x", msg), 0);
      refs.push(new WeakRef(msg));
      await p;
    })();
  }
  for (let i = 0; i < 10 && refs.some((r) => r.deref()); i++) {
    await new Promise((r) => setTimeout(r, 0));
    Bun.gc(true);
  }
  expect(refs.filter((r) => r.deref()).length).toBe(0);
  conn.close();
});
