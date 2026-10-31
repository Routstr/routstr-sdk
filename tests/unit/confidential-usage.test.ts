import { describe, expect, it } from "vitest";
import { extractUsageDisclosure, usageEventFromDisclosure } from "../../client/confidential/suffix";

const enc = new TextEncoder();
const chunk = (s: string) => `${enc.encode(s).length.toString(16)}\r\n${s}\r\n`;
const usageEvent =
  'data: {"id":"resp_1","object":"chat.completion.chunk","created":1,"model":"openai-gpt-6-luna","choices":[],' +
  '"usage":{"prompt_tokens":13,"completion_tokens":37,"total_tokens":50,"completion_tokens_details":{"reasoning_tokens":26}},' +
  '"cost":{"usd":0,"diem":0.00002475}}\n\n';
const head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n";
const content = 'data: {"model":"openai-gpt-6-luna","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n';

function response(splitAt?: number): Uint8Array {
  const usage = splitAt === undefined ? chunk(usageEvent) : chunk(usageEvent.slice(0, splitAt)) + chunk(usageEvent.slice(splitAt));
  return enc.encode(head + chunk(content) + usage + chunk("data: [DONE]\n\n") + "0\r\n\r\n");
}

describe("usage disclosure", () => {
  it("parses a usage event in one chunk", () => {
    const r = extractUsageDisclosure(response())!;
    expect(usageEventFromDisclosure(r)?.usage.completion_tokens).toBe(37);
  });

  it("parses a usage event split across HTTP chunks (anywhere)", () => {
    for (const at of [3, 10, 60, 150, usageEvent.length - 5]) {
      const r = extractUsageDisclosure(response(at));
      expect(r, `split at ${at}`).not.toBeNull();
      const u = usageEventFromDisclosure(r!);
      expect(u?.model, `split at ${at}`).toBe("openai-gpt-6-luna");
      expect(u?.usage.completion_tokens, `split at ${at}`).toBe(37);
    }
  });
});
