import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../core/types";
import { noopLogger } from "../../core/types";
import { fetchAIResponse } from "../../client/fetchAIResponse";

function streamResponse(
  deltas: Array<Record<string, unknown>>,
  root: Record<string, unknown> = {}
): Response {
  const body = deltas
    .map(
      (delta) => `data: ${JSON.stringify({ ...root, choices: [{ delta }] })}\n\n`
    )
    .join("");
  return new Response(body, { status: 200 });
}

async function run(options: {
  deltas: Array<Record<string, unknown>>;
  root?: Record<string, unknown>;
  messageHistory?: Message[];
  abortSignal?: AbortSignal;
}) {
  const appended: Message[] = [];
  const events: string[] = [];
  const onStreamingUpdate = vi.fn((value: string) =>
    events.push(value ? `content:${value}` : "content-clear")
  );
  const onThinkingUpdate = vi.fn((value: string) =>
    events.push(value ? `thinking:${value}` : "thinking-clear")
  );
  const client = {
    routeRequest: vi
      .fn()
      .mockResolvedValue(streamResponse(options.deltas, options.root)),
    getMode: () => "xcashu" as const,
  };

  await fetchAIResponse(
    {
      messageHistory: options.messageHistory ?? [],
      selectedModel: {
        id: "test-model",
        name: "Test Model",
        sats_pricing: {} as never,
      },
      baseUrl: "https://provider.example.com",
      mintUrl: "https://mint.example.com",
      abortSignal: options.abortSignal,
    },
    {
      onStreamingUpdate,
      onThinkingUpdate,
      onMessageAppend: (message) => {
        appended.push(message);
        events.push("append");
      },
      onBalanceUpdate: vi.fn(),
      onTransactionUpdate: vi.fn(),
    },
    { client, alertLevel: "min", logger: noopLogger }
  );

  return { appended, events, client, onStreamingUpdate, onThinkingUpdate };
}

const annotation = {
  type: "url_citation",
  start_index: 0,
  end_index: 6,
  url: "https://example.com",
  title: "Example",
};

describe("fetchAIResponse completed messages", () => {
  it.each([
    {
      name: "preserves reasoning on a normal text response",
      deltas: [{ reasoning: "secret" }, { content: "answer" }],
      expected: [
        {
          role: "assistant",
          content: [{ type: "text", text: "answer", thinking: "secret" }],
        },
      ],
    },
    {
      name: "appends a reasoning-only response as an assistant message",
      deltas: [{ reasoning: "secret" }],
      expected: [
        {
          role: "assistant",
          content: [{ type: "text", text: "", thinking: "secret" }],
        },
      ],
    },
    {
      name: "keeps a plain text-only response backward compatible",
      deltas: [{ content: "answer" }],
      expected: [{ role: "assistant", content: "answer" }],
    },
    {
      name: "preserves citations and annotations on text responses",
      deltas: [{ content: "answer" }],
      root: {
        citations: ["https://example.com"],
        annotations: [annotation],
      },
      expected: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "answer",
              citations: ["https://example.com"],
              annotations: [annotation],
            },
          ],
        },
      ],
    },
  ])("$name", async ({ deltas, root, expected }) => {
    const { appended } = await run({ deltas, root });

    expect(appended).toEqual(expected);
  });

  it("appends before clearing the transient streams", async () => {
    const { events } = await run({
      deltas: [{ reasoning: "secret" }, { content: "answer" }],
    });

    expect(events.slice(-3)).toEqual([
      "append",
      "content-clear",
      "thinking-clear",
    ]);
  });

  it("removes display-only metadata when replaying a completed message", async () => {
    const replay: Message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "answer",
          thinking: "secret",
          citations: ["https://example.com"],
          annotations: [annotation],
        },
      ],
    };
    const { client } = await run({
      deltas: [{ content: "next" }],
      messageHistory: [replay],
    });

    expect(client.routeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "answer" }],
            },
          ],
        }),
      })
    );
  });

  it("drops a reasoning-only turn instead of replaying an empty text block", async () => {
    const { client } = await run({
      deltas: [{ content: "next" }],
      messageHistory: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "text", text: "", thinking: "half a thought" }],
        },
      ],
    });

    expect(client.routeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          messages: [{ role: "user", content: "hi" }],
        }),
      })
    );
  });

  it("keeps the existing stopped-generation message on abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const { appended, onStreamingUpdate, onThinkingUpdate } = await run({
      deltas: [{ content: "answer" }],
      abortSignal: controller.signal,
    });

    expect(appended).toEqual([
      { role: "system", content: "Generation stopped." },
    ]);
    expect(onStreamingUpdate).toHaveBeenLastCalledWith("");
    expect(onThinkingUpdate).toHaveBeenLastCalledWith("");
  });
});
