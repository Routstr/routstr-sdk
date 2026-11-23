import { describe, expect, it } from "vitest";
import { applyAttemptReasoningReplay } from "../../client/ReasoningReplay";
import { deepSeekModelPath } from "../../utils/modelPaths";

const model = "deepseek-v4.1-flash-1017";
const url = "https://opencode.ai/inference/openai/v1";
const chat = "/v1/chat/completions";
const selector = deepSeekModelPath(model, { url });
const detail = (text: string) => ({ type: "reasoning.text", text, format: "unknown", index: 0 });
const details = [detail("first "), detail("second")];

function adapt(messages: unknown[]) {
  return applyAttemptReasoningReplay({ messages }, chat, selector);
}

describe("OpenCode DeepSeek reasoning replay", () => {
  it("converts unsigned details in order without modifying input", () => {
    const assistant = Object.freeze({ role: "assistant", content: null, tool_calls: [{ id: "call" }],
      reasoning_details: Object.freeze(details) });
    const user = { role: "user", content: "next" };
    const messages = [assistant, user];
    expect(adapt(messages)).toEqual({ messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "call" }], reasoning_content: "first second" },
      user,
    ] });
    expect(assistant.reasoning_details).toEqual(details);
    expect(assistant).not.toHaveProperty("reasoning_content");
  });

  it("restores plain text over an empty Pi backfill and deduplicates matching content", () => {
    for (const reasoning_content of ["", "first second"]) {
      expect(adapt([{ role: "assistant", reasoning_content, reasoning_details: details }])).toEqual({
        messages: [{ role: "assistant", reasoning_content: "first second" }],
      });
    }
  });

  it("does not fabricate reasoning or touch native reasoning", () => {
    const tool = { role: "assistant", content: null, tool_calls: [{ id: "call" }] };
    const ordinary = { role: "assistant", content: "plain answer" };
    const native = { ...tool, reasoning_content: "native" };
    expect(adapt([tool, ordinary, native])).toEqual({
      messages: [tool, ordinary, native],
    });
  });

  it("preserves signed, encrypted, opaque, unknown and conflicting replay", () => {
    const messages = [
      { reasoning_details: [{ ...detail("signed"), signature: "sig" }] },
      { reasoning_details: [detail("plain"), { type: "reasoning.encrypted", data: "opaque" }] },
      { reasoning_details: [{ ...detail("foreign"), format: "anthropic-claude-v1" }] },
      { reasoning_details: [{ ...detail("extra"), data: "unknown" }] },
      { reasoning_details: details, reasoning_opaque: "opaque" },
      { reasoning_details: details, reasoning_content: "different" },
    ].map((fields) => ({ role: "assistant", tool_calls: [{ id: "call" }], ...fields }));
    const body = { messages };
    expect(applyAttemptReasoningReplay(body, chat, selector)).toBe(body);
  });

  it("does not infer capabilities from the model name or change other endpoints", () => {
    const body = { messages: [{ role: "assistant", reasoning_details: details }] };
    for (const pin of [undefined, "malformed", deepSeekModelPath(model, { url: "http://localhost" }),
      deepSeekModelPath(model, { url: "https://openrouter.ai/api/v1", endpoint: "deepseek" }),
      deepSeekModelPath(model, { url: "https://api.deepseek.com" }),
      deepSeekModelPath(model, { url: "https://opencode.ai.example/inference/openai/v1" }),
      deepSeekModelPath("some-other-model", { url })]) {
      expect(applyAttemptReasoningReplay(body, chat, pin)).toBe(body);
    }
    expect(applyAttemptReasoningReplay(body, "/v1/responses", selector)).toBe(body);
  });
});
