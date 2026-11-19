/**
 * `fetchAIResponse` must forward the caller's `system` messages.
 *
 * The old filter in `convertMessages` came from the pre-extraction chat, which
 * kept its own error notes ("Generation stopped.", "Uncaught Error: ...") in the
 * history it passed in. Those notes are no longer passed, and a real system
 * message is how a caller sends the instructions every answer must follow, so
 * dropping the role silently disabled that feature.
 *
 * These tests drive the real `fetchAIResponse` body builder: only the transport
 * (`client.routeRequest`) is stubbed, so what they assert is the body that would
 * have gone upstream.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAIResponse } from "../../client/fetchAIResponse";
import type { Message } from "../../core/types";
import type { StreamingCallbacks } from "../../wallet/interfaces";

const MODEL = {
  id: "deepseek-v4.1-flash",
  name: "DeepSeek V4.1 Flash",
  sats_pricing: { prompt: 0.001, completion: 0.002, max_cost: 700 },
} as const;

// The pre-resolved path: the caller supplies model/baseUrl/mintUrl and the
// client, so nothing here touches discovery, the wallet, or the network.
const fetchOptions = (messageHistory: Message[]) => ({
  messageHistory,
  selectedModel: MODEL as never,
  baseUrl: "https://node.example/",
  mintUrl: "https://mint.example/",
});

const makeCallbacks = () =>
  ({
    onStreamingUpdate: vi.fn(),
    onThinkingUpdate: vi.fn(),
    onMessageAppend: vi.fn(),
    onBalanceUpdate: vi.fn(),
    onTransactionUpdate: vi.fn(),
  }) as unknown as StreamingCallbacks;

// An SSE body with no content: the request ends as soon as it is made.
const emptyStream = () => new Response("data: [DONE]\n\n");

const makeDeps = (routeRequest: ReturnType<typeof vi.fn>) =>
  ({
    client: { routeRequest, getMode: () => "apikeys" },
    alertLevel: "min",
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    },
  }) as never;

/** The body `fetchAIResponse` handed to the transport. */
const sentBody = async (messageHistory: Message[]) => {
  const routeRequest = vi.fn(async () => emptyStream());
  await fetchAIResponse(
    fetchOptions(messageHistory),
    makeCallbacks(),
    makeDeps(routeRequest)
  );
  expect(routeRequest).toHaveBeenCalledOnce();
  return routeRequest.mock.calls[0][0].body as {
    model: string;
    messages: Message[];
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchAIResponse system messages", () => {
  it("sends the caller's system message ahead of the conversation", async () => {
    const body = await sentBody([
      { role: "system", content: "Answer in one sentence." },
      { role: "user", content: "What is Cashu?" },
    ]);

    expect(body.messages).toEqual([
      { role: "system", content: "Answer in one sentence." },
      { role: "user", content: "What is Cashu?" },
    ]);
  });

  it("keeps array-valued system content intact", async () => {
    const content = [{ type: "text" as const, text: "Be terse." }];
    const body = await sentBody([
      { role: "system", content },
      { role: "user", content: "Hi" },
    ]);

    expect(body.messages[0]).toEqual({ role: "system", content });
  });

  it("leaves every other role's position and content alone", async () => {
    const history: Message[] = [
      { role: "system", content: "You are a routing assistant." },
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ];

    const body = await sentBody(history);

    expect(body.messages).toEqual(history);
  });

  it("does not invent a system message when the caller sends none", async () => {
    const body = await sentBody([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);

    expect(body.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });
});
