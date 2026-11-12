import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { extractUsageDisclosure, usageEventFromDisclosure, usageEventProblem } from "../../client/confidential/suffix";

const vectors = JSON.parse(readFileSync(new URL("./fixtures/usage-event-vectors.json", import.meta.url), "utf8")) as {
  vectors: { name: string; ok: boolean; event: unknown }[];
};

/**
 * The usage event rule of PROTOCOL-V3.md §5.4: the shared vectors (the
 * sidecar's usage_rule.rs runs the same file), and the HTTP/1.1 disclosure
 * locator with usage on every chunk (Cloudflare): R starts at the last event.
 */
describe("usage event rule", () => {
  for (const t of vectors.vectors) {
    it(`${t.ok ? "accepts" : "refuses"}: ${t.name}`, () => {
      expect(usageEventProblem(t.event) === null).toBe(t.ok);
    });
  }

  const enc = (s: string) => new TextEncoder().encode(s);
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);
  const response = (sse: string) =>
    enc(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${enc(sse).length.toString(16)}\r\n${sse}\r\n0\r\n\r\n`);
  const content = '{"choices":[{"index":0,"delta":{"content":"Hello"}}],"usage":{"prompt_tokens":0,"completion_tokens":1}}';
  const cloudflare = '{"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":14,"completion_tokens":3}}';
  const openrouter =
    '{"model":"m","choices":[{"index":0,"delta":{"content":"","role":"assistant"},"finish_reason":"length","native_finish_reason":"length"}],"usage":{"prompt_tokens":13,"completion_tokens":4}}';

  it("discloses only the last event when every chunk carries usage", () => {
    const r = extractUsageDisclosure(response(`data: ${content}\n\ndata: ${cloudflare}\n\ndata: [DONE]\n\n`));
    expect(r).not.toBeNull();
    expect(dec(r!).startsWith(`\ndata: ${cloudflare}`)).toBe(true);
    expect(dec(r!)).not.toContain("Hello");
    expect(usageEventFromDisclosure(r!)?.usage).toMatchObject({ completion_tokens: 3 });
  });

  it("finds the OpenRouter usage event", () => {
    const r = extractUsageDisclosure(response(`data: ${content}\n\ndata: ${openrouter}\n\ndata: [DONE]\n\n`));
    expect(r).not.toBeNull();
    expect(dec(r!)).not.toContain("Hello");
  });

  it("refuses usage merged into the last content chunk", () => {
    expect(extractUsageDisclosure(response(`data: ${cloudflare}\n\ndata: ${content}\n\ndata: [DONE]\n\n`))).toBeNull();
    const reasoning = '{"choices":[{"index":0,"delta":{"reasoning":"hm"}}],"usage":{"prompt_tokens":1,"completion_tokens":2}}';
    expect(extractUsageDisclosure(response(`data: ${reasoning}\n\ndata: [DONE]\n\n`))).toBeNull();
  });
});
