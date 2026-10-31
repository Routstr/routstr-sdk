import { readFileSync } from "node:fs";
import type { ChatSuffixSpec } from "../../../client/confidential/suffix";

/** The Venice chat block from the shared vectors (the shipped sidecar offer's). */
export const VENICE_CHAT: ChatSuffixSpec = JSON.parse(
  readFileSync(new URL("./chat-suffix-vectors.json", import.meta.url), "utf8"),
).venice;
