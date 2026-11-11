/**
 * The request routes a confidential session implements (no Node imports:
 * `RoutstrClient`, part of the browser-safe bundle, refuses any other route
 * before a credential or a deposit is involved, and the transport refuses it
 * again). One definition, so the two cannot drift.
 */

/** `chat` or `images` for a route a confidential session implements, else undefined. */
export function confidentialKind(path: string): "chat" | "images" | undefined {
  const p = path.split("?")[0] ?? "";
  if (/^(\/v1)?\/chat\/completions\/?$/.test(p)) return "chat";
  if (/^(\/v1)?\/(images\/generations|image\/generate)\/?$/.test(p)) return "images";
  return undefined;
}
