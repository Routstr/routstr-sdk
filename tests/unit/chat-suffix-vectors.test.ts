import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canonicalSuffix, chatSuffixKeys, validateChatSuffix, type ChatSuffixSpec } from "../../client/confidential/suffix";
import { OfferMalformedError } from "../../client/confidential/errors";

/**
 * The shared chat-suffix vectors. The web library runs the same table (its
 * copy of this file), and the sidecar's tests pin the Venice rendering, so
 * every party renders the same bytes from the same offer.
 */
const doc = JSON.parse(readFileSync(new URL("./fixtures/chat-suffix-vectors.json", import.meta.url), "utf8")) as {
  accepted: { chat: ChatSuffixSpec; suffix_keys: string[]; model: string; max_tokens: number; suffix: string }[];
  refused: { why: string; chat: unknown }[];
};

describe("chat suffix vectors", () => {
  for (const v of doc.accepted) {
    it(`renders ${v.model}/${v.max_tokens} with ${v.suffix_keys.join(",")}`, () => {
      validateChatSuffix(v.chat, v.suffix_keys);
      expect(chatSuffixKeys(v.chat)).toEqual(v.suffix_keys);
      expect(canonicalSuffix(v.chat, v.model, v.max_tokens)).toBe(v.suffix);
    });
  }
  for (const v of doc.refused) {
    it(`refuses a chat block: ${v.why}`, () => {
      const c = v.chat as ChatSuffixSpec;
      const keys = Array.isArray(c.cap_keys) && Array.isArray(c.fixed_pins) ? chatSuffixKeys(c) : [];
      expect(() => validateChatSuffix(v.chat, keys)).toThrow(OfferMalformedError);
    });
  }
});
