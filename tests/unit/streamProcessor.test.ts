import { describe, expect, it, vi } from "vitest";
import { StreamProcessor } from "../../client/StreamProcessor";

const encoder = new TextEncoder();

function responseFromChunks(chunks: Array<string | Uint8Array>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(
            typeof chunk === "string" ? encoder.encode(chunk) : chunk
          );
        }
        controller.close();
      },
    })
  );
}

function event(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function delta(value: Record<string, unknown>): string {
  return event({ choices: [{ delta: value }] });
}

async function processChunks(chunks: Array<string | Uint8Array>) {
  const onContent = vi.fn();
  const onThinking = vi.fn();
  const result = await new StreamProcessor().process(
    responseFromChunks(chunks),
    { onContent, onThinking },
    "test-model"
  );

  return { result, onContent, onThinking };
}

describe("StreamProcessor reasoning normalization", () => {
  it("emits structured reasoning as plain text", async () => {
    const { result, onThinking } = await processChunks([
      delta({ reasoning: "secret" }),
      delta({ content: "answer" }),
      "data: [DONE]\n\n",
    ]);

    expect(result).toMatchObject({ content: "answer", thinking: "secret" });
    expect(onThinking).toHaveBeenLastCalledWith("secret");
  });

  it("accepts the reasoning_content compatibility field", async () => {
    const { result } = await processChunks([
      delta({ reasoning_content: "secret" }),
      delta({ content: "answer" }),
    ]);

    expect(result).toMatchObject({ content: "answer", thinking: "secret" });
  });

  it("handles reasoning before content in the same delta", async () => {
    const { result } = await processChunks([
      delta({ reasoning: "secret", content: "answer" }),
    ]);

    expect(result).toMatchObject({ content: "answer", thinking: "secret" });
  });

  it("does not duplicate reasoning when both compatibility fields exist", async () => {
    const { result } = await processChunks([
      delta({ reasoning_content: "preferred", reasoning: "fallback" }),
      delta({ content: "answer" }),
    ]);

    expect(result.thinking).toBe("preferred");
  });

  it("falls back from an empty compatibility alias to plain reasoning", async () => {
    const { result } = await processChunks([
      delta({ reasoning_content: "", reasoning: "fallback" }),
      delta({ content: "answer" }),
    ]);

    expect(result.thinking).toBe("fallback");
  });

  it("uses displayable reasoning details when no plain field exists", async () => {
    const { result } = await processChunks([
      delta({
        reasoning_details: [
          {
            type: "reasoning.text",
            text: "secret",
            signature: "signature",
          },
        ],
      }),
      delta({ content: "answer" }),
    ]);

    expect(result).toMatchObject({ content: "answer", thinking: "secret" });
  });

  it("uses a reasoning summary when no text detail exists", async () => {
    const { result } = await processChunks([
      delta({
        reasoning_details: [
          { type: "reasoning.summary", summary: "short summary" },
          { type: "reasoning.encrypted", data: "opaque" },
        ],
      }),
      delta({ content: "answer" }),
    ]);

    expect(result.thinking).toBe("short summary");
  });

  it("falls back from an empty text detail to a visible summary", async () => {
    const { result } = await processChunks([
      delta({
        reasoning_details: [
          { type: "reasoning.text", text: "" },
          { type: "reasoning.summary", summary: "visible summary" },
        ],
      }),
      delta({ content: "answer" }),
    ]);

    expect(result.thinking).toBe("visible summary");
  });

  it("prefers a plain reasoning field over duplicate reasoning details", async () => {
    const { result } = await processChunks([
      delta({
        reasoning: "plain",
        reasoning_details: [
          { type: "reasoning.text", text: "duplicate" },
          { type: "reasoning.summary", summary: "duplicate summary" },
        ],
      }),
      delta({ content: "answer" }),
    ]);

    expect(result.thinking).toBe("plain");
  });

  it.each([" ", "\n", "<thi"])(
    "keeps a pending %j prefix as answer text after structured reasoning",
    async (prefix) => {
      const { result } = await processChunks([
        delta({ content: prefix }),
        delta({ reasoning: "secret" }),
        delta({ content: "answer" }),
      ]);

      expect(result).toMatchObject({
        content: `${prefix}answer`,
        thinking: "secret",
      });
    },
  );

  it("keeps reasoning that arrives after content has started", async () => {
    const { result } = await processChunks([
      delta({ content: "Hello" }),
      delta({ reasoning: "late" }),
      delta({ content: " world" }),
    ]);

    expect(result).toMatchObject({ content: "Hello world", thinking: "late" });
  });

  it.each(["think", "thinking"])(
    "consumes an inline </%s> that arrives after structured reasoning",
    async (tag) => {
      const { result } = await processChunks([
        delta({ content: `<${tag}>inline</${tag.slice(0, -1)}` }),
        delta({ reasoning: "structured" }),
        delta({ content: `${tag.slice(-1)}>answer` }),
      ]);

      expect(result).toMatchObject({
        content: "answer",
        thinking: "inlinestructured",
      });
    },
  );

  it("never emits an inline tag fragment as answer text", async () => {
    const full = "<think>inline</think>answer";

    for (let split = 8; split < full.length; split += 1) {
      const { result, onContent } = await processChunks([
        delta({ content: full.slice(0, split) }),
        delta({ reasoning: "structured" }),
        delta({ content: full.slice(split) }),
      ]);

      expect(result.content).toBe("answer");
      for (const [emitted] of onContent.mock.calls) {
        expect(emitted).not.toMatch(/<\/?think(ing)?>|<\/thi|nk>/);
      }
    }
  });

  it.each(["think", "thinking"])(
    "extracts a leading <%s> block",
    async (tag) => {
      const { result } = await processChunks([
        delta({ content: `<${tag}>secret</${tag}>answer` }),
      ]);

      expect(result).toMatchObject({ content: "answer", thinking: "secret" });
    }
  );

  it("emits plain cumulative snapshots for inline reasoning", async () => {
    const { onThinking } = await processChunks([
      delta({ content: "<thi" }),
      delta({ content: "nk>one" }),
      delta({ content: " two</think>answer" }),
    ]);

    expect(onThinking.mock.calls).toEqual([["one"], ["one two"]]);
  });

  it.each(["think", "thinking"])(
    "extracts <%s> across every two-delta split point",
    async (tag) => {
      const value = `<${tag}>secret</${tag}>answer`;

      for (let split = 1; split < value.length; split += 1) {
        const { result } = await processChunks([
          delta({ content: value.slice(0, split) }),
          delta({ content: value.slice(split) }),
        ]);

        expect(result, `split ${split} of ${value}`).toMatchObject({
          content: "answer",
          thinking: "secret",
        });
      }
    }
  );

  it("preserves a literal thinking tag after answer text starts", async () => {
    const { result } = await processChunks([
      delta({ content: "Answer with " }),
      delta({ content: "<think>literal</think> markup" }),
    ]);

    expect(result).toEqual({
      content: "Answer with <think>literal</think> markup",
      thinking: undefined,
      images: undefined,
      usage: undefined,
      model: undefined,
      responseId: undefined,
      finish_reason: undefined,
      citations: undefined,
      annotations: undefined,
    });
  });

  it.each(["think", "thinking"])(
    "preserves a literal <%s> answer after a leading reasoning block",
    async (tag) => {
      const { result, onThinking } = await processChunks([
        delta({ content: `<${tag}>hidden</${tag}><${tag}>literal` }),
        delta({ content: `</${tag}> answer` }),
      ]);

      expect(result).toMatchObject({
        content: `<${tag}>literal</${tag}> answer`,
        thinking: "hidden",
      });
      expect(onThinking.mock.calls).toEqual([["hidden"]]);
    }
  );

  it("keeps an incomplete leading marker as answer text at EOF", async () => {
    const { result } = await processChunks([delta({ content: "<thi" })]);

    expect(result.content).toBe("<thi");
    expect(result.thinking).toBeUndefined();
  });

  it("keeps an unclosed leading block as reasoning at EOF", async () => {
    const { result } = await processChunks([
      delta({ content: "<think>unfinished" }),
    ]);

    expect(result.content).toBe("");
    expect(result.thinking).toBe("unfinished");
  });

  it("does not parse inline-looking answer text after structured reasoning", async () => {
    const { result } = await processChunks([
      delta({ reasoning: "secret" }),
      delta({ content: "Use <think>literally</think>." }),
    ]);

    expect(result).toMatchObject({
      content: "Use <think>literally</think>.",
      thinking: "secret",
    });
  });
});

describe("StreamProcessor response handling", () => {
  it("preserves response metadata alongside normalized reasoning", async () => {
    const annotation = {
      type: "url_citation",
      start_index: 0,
      end_index: 6,
      url: "https://example.com",
      title: "Example",
    };
    const image = {
      type: "image_url",
      image_url: { url: "data:image/png;base64,abc" },
      index: 0,
    };
    const { result } = await processChunks([
      event({
        id: "response-1",
        model: "test-model",
        citations: ["https://example.com"],
        annotations: [annotation],
        choices: [
          {
            delta: { content: "answer", images: [image] },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
        },
      }),
    ]);

    expect(result).toMatchObject({
      content: "answer",
      model: "test-model",
      responseId: "response-1",
      finish_reason: "stop",
      citations: ["https://example.com"],
      annotations: [annotation],
      images: [image],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
      },
    });
  });

  it("recovers reasoning and content across arbitrary byte fragmentation", async () => {
    const bytes = encoder.encode(
      delta({ reasoning_content: "秘密" }) +
        delta({ content: "回答" }) +
        "data: [DONE]\n\n"
    );
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
    const { result } = await processChunks(chunks);

    expect(result).toMatchObject({ content: "回答", thinking: "秘密" });
  });
});

describe("StreamProcessor cancellation", () => {
  it("cancels and rejects a pre-aborted stream", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({ cancel })
    );
    const controller = new AbortController();
    controller.abort();

    await expect(
      new StreamProcessor().process(
        response,
        { onContent: vi.fn(), onThinking: vi.fn() },
        "test-model",
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a pending read without flushing buffered tag text", async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    let pulls = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(streamController) {
          if (pulls === 0) {
            pulls += 1;
            streamController.enqueue(encoder.encode(delta({ content: "<thi" })));
            return;
          }
          controller.abort();
        },
        cancel,
      })
    );
    const onContent = vi.fn();
    const onThinking = vi.fn();

    await expect(
      new StreamProcessor().process(
        response,
        { onContent, onThinking },
        "test-model",
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(onContent).not.toHaveBeenCalled();
    expect(onThinking).not.toHaveBeenCalled();
  });
});
