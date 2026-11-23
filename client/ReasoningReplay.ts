import { selectorModelId, whitelistedModelPathRoute } from "../utils/modelPaths";

// OpenCode's catalog declares interleaved.field = reasoning_content for this
// model (models.dev, provider "opencode"). The proxy node's URL is not the
// upstream identity. Match only the explicit chat route, not localhost pins
// or OpenRouter's [deepseek] endpoint.
const OPENCODE_CHAT_ROUTES = [
  { url: "https://opencode.ai/inference/openai/v1" },
  { url: "https://opencode.ai/inference/openai/v1/" },
];
const OPENCODE_DEEPSEEK_FLASH_IDS = new Set([
  "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-1017",
]);

const PLAIN_DETAIL_KEYS = new Set(["type", "text", "signature", "format", "index", "id"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function plainReasoningText(details: unknown[]): string | undefined {
  let text = "";
  for (const detail of details) {
    if (!record(detail) || detail.type !== "reasoning.text" ||
        typeof detail.text !== "string" || detail.signature != null ||
        (detail.format != null && detail.format !== "unknown") ||
        // Only consume the known unsigned text shape. Unknown metadata may
        // be needed to replay this block on its originating provider.
        Object.keys(detail).some((key) => !PLAIN_DETAIL_KEYS.has(key))) {
      return undefined;
    }
    text += detail.text;
  }
  return text;
}

function adaptAssistant(message: unknown): unknown {
  if (!record(message) || message.role !== "assistant" || message.reasoning_opaque != null) return message;
  const { reasoning_details: details, reasoning_content: content } = message;
  if (content != null && typeof content !== "string") return message;

  if (!Array.isArray(details) || details.length === 0) return message;
  const text = plainReasoningText(details);
  // Don't discard opaque structures or collapse two conflicting copies.
  if (text === undefined || (content && content !== text)) return message;
  const { reasoning_details: _details, ...rest } = message;
  return { ...rest, reasoning_content: text };
}

/** Build the wire body for this attempt without modifying the retry input. */
export function applyAttemptReasoningReplay(body: unknown, path: string, selector?: string): unknown {
  if (!selector || !path.split("?", 1)[0]!.replace(/\/+$/, "").endsWith("/chat/completions") ||
      !OPENCODE_DEEPSEEK_FLASH_IDS.has(selectorModelId(selector) ?? "") ||
      !whitelistedModelPathRoute(selector, OPENCODE_CHAT_ROUTES) ||
      !record(body) || !Array.isArray(body.messages)) return body;

  const originalMessages = body.messages;
  const messages = originalMessages.map(adaptAssistant);
  return messages.some((message, index) => message !== originalMessages[index])
    ? { ...body, messages }
    : body;
}
