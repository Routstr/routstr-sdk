/**
 * OpenAI-compatible JSON-body endpoints.
 *
 * Only these endpoints define `stream`, `max_tokens` / `max_output_tokens`,
 * `messages`, and the rest of the OpenAI request vocabulary. Other POST
 * endpoints — `/v1/systemone` (TypeSafe System One), `/v1/embeddings`,
 * `/v1/audio/*`, `/v1/messages` — validate their bodies strictly and reject
 * unknown fields, so injecting chat-completions fields into them turns a valid
 * request into an upstream `400 Invalid request.`
 *
 * Matched by path suffix so `/v1/chat/completions`, `/chat/completions`, and
 * custom path-prefixed proxies all qualify.
 */
export const OPENAI_JSON_BODY_PATHS = [
  "/chat/completions",
  "/completions",
  "/responses",
] as const;

/**
 * True when `pathname` addresses an endpoint whose body carries the OpenAI
 * request vocabulary. Ignores a query string and a trailing slash.
 */
export function isOpenAiJsonBodyPath(pathname: string): boolean {
  const path = (pathname.split("?")[0] ?? "").replace(/\/+$/, "");
  return OPENAI_JSON_BODY_PATHS.some((suffix) => path.endsWith(suffix));
}
