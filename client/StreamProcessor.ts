/**
 * StreamProcessor - Handles SSE streaming response parsing
 *
 * Handles:
 * - Line buffering for large payloads
 * - Content extraction from delta chunks
 * - Thinking/reasoning block extraction
 * - Image data merging and deduplication
 * - Usage statistics extraction
 * - Citations and annotations
 *
 * Extracted from utils/apiUtils.ts processStreamingResponse
 */

import type { StreamingResult, ImageData, AnnotationData } from "../core/types";
import { extractUsageFromSSEJson, toUsageStats } from "./usage";

const INLINE_THINKING_OPEN_TAGS = ["<think>", "<thinking>"] as const;
const INLINE_THINKING_CLOSE_TAGS = ["</think>", "</thinking>"] as const;

type InlineStreamState = "leading" | "thinking" | "content";

interface ParsedStreamEvent {
  content?: string;
  reasoning?: string;
  usage?: StreamingResult["usage"];
  model?: string;
  finish_reason?: string;
  citations?: string[];
  annotations?: AnnotationData[];
  images?: ImageData[];
  responseId?: string;
}

function extractReasoningDetails(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;

  const text: string[] = [];
  const summaries: string[] = [];
  for (const detail of value) {
    if (!detail || typeof detail !== "object") continue;

    const entry = detail as Record<string, unknown>;
    if (entry.type === "reasoning.text" && typeof entry.text === "string") {
      text.push(entry.text);
    } else if (
      entry.type === "reasoning.summary" &&
      typeof entry.summary === "string"
    ) {
      summaries.push(entry.summary);
    }
  }

  return text.join("") || summaries.join("") || undefined;
}

/**
 * Callbacks for streaming updates
 */
export interface StreamCallbacks {
  /** Called when new content arrives */
  onContent: (content: string) => void;
  /** Called when thinking content arrives */
  onThinking: (thinking: string) => void;
}

/**
 * StreamProcessor parses SSE streaming responses
 */
export class StreamProcessor {
  private accumulatedContent = "";
  private accumulatedThinking = "";
  private accumulatedImages: ImageData[] = [];
  private inlineBuffer = "";
  private inlineState: InlineStreamState = "leading";

  /**
   * Process a streaming response
   */
  async process(
    response: Response,
    callbacks: StreamCallbacks,
    // Retained for API compatibility: inline extraction no longer gates on the model.
    modelId?: string,
    signal?: AbortSignal
  ): Promise<StreamingResult> {
    if (!response.body) {
      throw new Error("Response body is not available");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    // If already aborted, cancel immediately.
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    const abortReader = () => {
      void reader.cancel().catch(() => {});
    };
    signal?.addEventListener("abort", abortReader, { once: true });

    // Reset state
    this.accumulatedContent = "";
    this.accumulatedThinking = "";
    this.accumulatedImages = [];
    this.inlineBuffer = "";
    this.inlineState = "leading";

    // Result accumulators
    let usage: StreamingResult["usage"];
    let model: string | undefined;
    let finish_reason: string | undefined;
    let citations: string[] | undefined;
    let annotations: AnnotationData[] | undefined;
    let responseId: string | undefined;

    const handleEvent = (parsed: ParsedStreamEvent): void => {
      // Reasoning first: it switches off inline tag scanning, so content in the same
      // delta is taken literally instead of re-parsed for tags already reported here.
      if (parsed.reasoning) {
        this._handleThinking(parsed.reasoning, callbacks);
      }

      if (parsed.content) {
        this._handleContent(parsed.content, callbacks);
      }

      if (parsed.usage) usage = parsed.usage;
      if (parsed.model) model = parsed.model;
      if (parsed.finish_reason) finish_reason = parsed.finish_reason;
      if (parsed.responseId) responseId = parsed.responseId;
      if (parsed.citations) citations = parsed.citations;
      if (parsed.annotations) annotations = parsed.annotations;
      if (parsed.images) this._mergeImages(parsed.images);
    };

    try {
      while (true) {
        // Check for cancellation before each read.
        if (signal?.aborted) {
          await reader.cancel().catch(() => {});
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        const { done, value } = await reader.read();

        if (signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }

        if (done) {
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        // Process complete lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const parsed = this._parseEvent(line.slice(6));
          if (parsed) handleEvent(parsed);
        }
      }

      this._flushInlineBuffer(callbacks);
    } finally {
      signal?.removeEventListener("abort", abortReader);
      reader.releaseLock();
    }

    return {
      content: this.accumulatedContent,
      thinking: this.accumulatedThinking || undefined,
      images: this.accumulatedImages.length > 0 ? this.accumulatedImages : undefined,
      usage,
      model,
      responseId,
      finish_reason,
      citations,
      annotations,
    };
  }

  /**
   * Parse a single SSE event
   */
  private _parseEvent(data: string): ParsedStreamEvent | null {
    if (data.trim() === "[DONE]") return null;

    try {
      const parsed = JSON.parse(data);
      const result: ParsedStreamEvent = {};

      // Extract content delta
      if (parsed.choices?.[0]?.delta?.content) {
        result.content = parsed.choices[0].delta.content;
      }

      const delta = parsed.choices?.[0]?.delta;
      const plainReasoning = [
        delta?.reasoning_content,
        delta?.reasoning,
      ].find((value) => typeof value === "string" && value.length > 0);
      const reasoning =
        plainReasoning || extractReasoningDetails(delta?.reasoning_details);
      if (reasoning) {
        result.reasoning = reasoning;
      }

      // Extract usage (usually in final chunk)
      // extractUsageFromSSEJson handles both usage chunks and standalone cost chunks
      const extractedUsage = extractUsageFromSSEJson(parsed);
      if (extractedUsage) {
        result.usage = toUsageStats(extractedUsage);
      } else if (parsed.usage) {
        // Fallback: raw usage without cost
        result.usage = {
          total_tokens: parsed.usage.total_tokens ?? parsed.usage.input_tokens + parsed.usage.output_tokens,
          prompt_tokens: parsed.usage.prompt_tokens ?? parsed.usage.input_tokens,
          completion_tokens: parsed.usage.completion_tokens ?? parsed.usage.output_tokens,
        };
      }

      if (parsed.id) {
        result.responseId = parsed.id;
      }

      // Extract model info
      if (parsed.model) {
        result.model = parsed.model;
      }

      // Extract citations
      if (parsed.citations) {
        result.citations = parsed.citations;
      }

      // Extract annotations
      if (parsed.annotations) {
        result.annotations = parsed.annotations;
      }

      // Extract finish reason
      if (parsed.choices?.[0]?.finish_reason) {
        result.finish_reason = parsed.choices[0].finish_reason;
      }

      // Extract images (from message or delta)
      const images =
        parsed.choices?.[0]?.message?.images ||
        parsed.choices?.[0]?.delta?.images;
      if (images && Array.isArray(images)) {
        result.images = images;
      }

      return result;
    } catch {
      // Swallow parse errors for streaming chunks
      return null;
    }
  }

  /**
   * Handle content delta with thinking support
   */
  private _handleContent(content: string, callbacks: StreamCallbacks): void {
    if (this.inlineState === "content") {
      this.accumulatedContent += content;
      callbacks.onContent(this.accumulatedContent);
      return;
    }

    this.inlineBuffer += content;
    this._drainInlineBuffer(callbacks);
  }

  /**
   * Handle thinking/reasoning content
   */
  private _handleThinking(reasoning: string, callbacks: StreamCallbacks): void {
    // An open inline block keeps its buffer: it may hold a partial closing tag.
    // Otherwise the buffer is answer text the tag lookahead held, so flush it.
    if (this.inlineState !== "thinking") {
      this._flushInlineBuffer(callbacks);
      this.inlineState = "content";
    }
    this.accumulatedThinking += reasoning;
    callbacks.onThinking(this.accumulatedThinking);
  }

  /**
   * Extract a leading inline thinking block without consuming literal tags in answers.
   */
  private _drainInlineBuffer(callbacks: StreamCallbacks): void {
    while (this.inlineBuffer) {
      if (this.inlineState === "leading") {
        const firstVisible = this.inlineBuffer.search(/\S/);
        if (firstVisible === -1) return;

        const candidate = this.inlineBuffer.slice(firstVisible);
        const opener = INLINE_THINKING_OPEN_TAGS.find((tag) =>
          candidate.startsWith(tag)
        );

        if (opener) {
          this.inlineBuffer = candidate.slice(opener.length);
          this.inlineState = "thinking";
          continue;
        }

        if (INLINE_THINKING_OPEN_TAGS.some((tag) => tag.startsWith(candidate))) {
          return;
        }

        this.inlineState = "content";
        continue;
      }

      if (this.inlineState === "thinking") {
        const { index, length } = this._closeTagSplit(this.inlineBuffer);
        this._appendThinking(this.inlineBuffer.slice(0, index), callbacks);
        this.inlineBuffer = this.inlineBuffer.slice(index + length);
        if (length === 0) return;
        this.inlineState = "content";
        continue;
      }

      this.accumulatedContent += this.inlineBuffer;
      this.inlineBuffer = "";
      callbacks.onContent(this.accumulatedContent);
      return;
    }
  }

  private _flushInlineBuffer(callbacks: StreamCallbacks): void {
    if (!this.inlineBuffer) return;

    if (this.inlineState === "thinking") {
      this._appendThinking(this.inlineBuffer, callbacks);
    } else {
      this.accumulatedContent += this.inlineBuffer;
      callbacks.onContent(this.accumulatedContent);
    }
    this.inlineBuffer = "";
  }

  private _appendThinking(value: string, callbacks: StreamCallbacks): void {
    if (!value) return;
    this.accumulatedThinking += value;
    callbacks.onThinking(this.accumulatedThinking);
  }

  /**
   * Locate the earliest complete closing tag. If none is present, `length` is 0 and
   * `index` is where a partial tag starts, so the caller can hold that back.
   */
  private _closeTagSplit(value: string): { index: number; length: number } {
    let found: { index: number; length: number } | null = null;
    for (const tag of INLINE_THINKING_CLOSE_TAGS) {
      const index = value.indexOf(tag);
      if (index !== -1 && (!found || index < found.index)) {
        found = { index, length: tag.length };
      }
    }
    if (found) return found;

    const maxPending = Math.min(
      value.length,
      Math.max(...INLINE_THINKING_CLOSE_TAGS.map((tag) => tag.length - 1))
    );
    for (let length = maxPending; length > 0; length -= 1) {
      const suffix = value.slice(-length);
      if (INLINE_THINKING_CLOSE_TAGS.some((tag) => tag.startsWith(suffix))) {
        return { index: value.length - length, length: 0 };
      }
    }

    return { index: value.length, length: 0 };
  }

  /**
   * Merge images into accumulated array, avoiding duplicates
   */
  private _mergeImages(newImages: ImageData[]): void {
    for (const img of newImages) {
      const newUrl = img.image_url?.url;
      const existingIndex = this.accumulatedImages.findIndex((existing) => {
        const existingUrl = existing.image_url?.url;
        if (newUrl && existingUrl) {
          return existingUrl === newUrl;
        }
        if (img.index !== undefined && existing.index !== undefined) {
          return existing.index === img.index;
        }
        return false;
      });

      if (existingIndex === -1) {
        this.accumulatedImages.push(img);
      } else {
        this.accumulatedImages[existingIndex] = img;
      }
    }
  }
}
