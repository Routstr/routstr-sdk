import { Readable, Writable } from "stream";
import { promisify } from "util";
import { pipeline as pipelineCallback } from "stream";
import { createSSEParserTransform } from "../client/sse";

const pipeline = promisify(pipelineCallback);

describe("createSSEParserTransform", () => {
  it("extracts usage and response id from SSE chunks", async () => {
    let capturedUsage: any = null;
    let capturedResponseId: string | undefined;

    const sseParser = createSSEParserTransform(
      (usage) => {
        capturedUsage = usage;
      },
      (responseId) => {
        capturedResponseId = responseId;
      }
    );

    const chunks = [
      'data: {"id":"chatcmpl-123","choices":[{"delta":{"content":"Hello"}}]}\n',
      'data: {"id":"chatcmpl-123","choices":[{"delta":{"content":" world"}}]}\n',
      'data: {"id":"chatcmpl-123","choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"cost":0.001,"cost_sats":100}}\n',
      'data: [DONE]\n',
    ];

    const readable = Readable.from(chunks);
    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    await pipeline(readable, sseParser, writable);

    expect(capturedResponseId).toBe("chatcmpl-123");
    expect(capturedUsage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cost: 0.001,
      satsCost: 100,
    });
  });

  it("forwards SSE data through the transform", async () => {
    const forwardedChunks: Buffer[] = [];

    const sseParser = createSSEParserTransform(() => {}, () => {});

    const readable = Readable.from([
      'data: {"id":"test","choices":[{"delta":{"content":"Test"}}]}\n',
    ]);
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        forwardedChunks.push(Buffer.from(chunk));
        callback();
      },
    });

    await pipeline(readable, sseParser, writable);

    expect(forwardedChunks.length).toBeGreaterThan(0);
    const forwarded = Buffer.concat(forwardedChunks).toString();
    expect(forwarded).toContain('"content":"Test"');
  });
});
