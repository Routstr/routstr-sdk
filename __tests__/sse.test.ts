import { Readable, Writable } from "stream";
import { promisify } from "util";
import { pipeline as pipelineCallback } from "stream";
import {
  createSSEParserTransform,
  inspectSSEWebStream,
} from "../client/sse";

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
      'data: {"id":"chatcmpl-123","choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"id":"chatcmpl-123","choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"id":"chatcmpl-123","choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"cost":0.001,"cost_sats":100}}\n\n',
      'data: [DONE]\n\n',
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
      'data: {"id":"test","choices":[{"delta":{"content":"Test"}}]}\n\n',
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

describe("inspectSSEWebStream", () => {
  function makeWebStream(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) {
          controller.enqueue(typeof c === "string" ? encoder.encode(c) : c);
        }
        controller.close();
      },
    });
  }

  it("extracts usage and response id from complete SSE events", async () => {
    let usage: any = null;
    let responseId: string | undefined;

    const stream = makeWebStream([
      'data: {"id":"chatcmpl-web","choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"id":"chatcmpl-web","choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10,"cost":0.002,"cost_sats":42}}\n\n',
      'data: [DONE]\n\n',
    ]);

    const result = await inspectSSEWebStream(
      stream,
      (u) => {
        usage = u;
      },
      (id) => {
        responseId = id;
      }
    );

    expect(responseId).toBe("chatcmpl-web");
    expect(usage).toEqual({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
      cost: 0.002,
      satsCost: 42,
    });
    expect(result.capturedResponseId).toBe("chatcmpl-web");
    expect(result.capturedUsage).toEqual(usage);
  });

  it("handles events split across chunk boundaries and multi-byte UTF-8", async () => {
    const encoder = new TextEncoder();
    // "你好" encodes to 6 bytes (3 per char). Split the stream mid-character
    // to verify streaming UTF-8 decoding.
    const firstEvent =
      'data: {"id":"chatcmpl-utf","choices":[{"delta":{"content":"你好"}}]}\n\n';
    const secondEvent =
      'data: {"id":"chatcmpl-utf","usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3,"cost":0,"cost_sats":5}}\n\n';
    const bytes = encoder.encode(firstEvent + secondEvent);
    // Split at an arbitrary byte offset that lands inside the multi-byte char.
    const cut = firstEvent.indexOf("你") + 1; // inside the UTF-8 sequence.
    const part1 = bytes.slice(0, cut);
    const part2 = bytes.slice(cut);

    let usage: any = null;
    let responseId: string | undefined;

    const result = await inspectSSEWebStream(
      makeWebStream([part1, part2]),
      (u) => {
        usage = u;
      },
      (id) => {
        responseId = id;
      }
    );

    expect(responseId).toBe("chatcmpl-utf");
    expect(usage.satsCost).toBe(5);
    expect(result.capturedUsage?.totalTokens).toBe(3);
  });
});
