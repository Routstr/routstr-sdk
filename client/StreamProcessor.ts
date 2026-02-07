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
  private isInThinking = false;
  private isInContent = false;

  /**
   * Process a streaming response
   */
  async process(
    response: Response,
    callbacks: StreamCallbacks,
    modelId?: string
  ): Promise<StreamingResult> {
    if (!response.body) {
      throw new Error("Response body is not available");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    // Reset state
    this.accumulatedContent = "";
    this.accumulatedThinking = "";
    this.accumulatedImages = [];
    this.isInThinking = false;
    this.isInContent = false;

    // Result accumulators
    let usage: StreamingResult["usage"];
    let model: string | undefined;
    let finish_reason: string | undefined;
    let citations: string[] | undefined;
    let annotations: AnnotationData[] | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        // Process complete lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          const parsed = this._parseLine(line);
          if (!parsed) continue;

          // Handle content delta
          if (parsed.content) {
            this._handleContent(parsed.content, callbacks, modelId);
          }

          // Handle reasoning/thinking
          if (parsed.reasoning) {
            this._handleThinking(parsed.reasoning, callbacks);
          }

          // Extract metadata
          if (parsed.usage) {
            usage = parsed.usage;
          }
          if (parsed.model) {
            model = parsed.model;
          }
          if (parsed.finish_reason) {
            finish_reason = parsed.finish_reason;
          }
          if (parsed.citations) {
            citations = parsed.citations;
          }
          if (parsed.annotations) {
            annotations = parsed.annotations;
          }

          // Handle images
          if (parsed.images) {
            this._mergeImages(parsed.images);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      content: this.accumulatedContent,
      thinking: this.accumulatedThinking || undefined,
      images: this.accumulatedImages.length > 0 ? this.accumulatedImages : undefined,
      usage,
      model,
      finish_reason,
      citations,
      annotations,
    };
  }

  /**
   * Parse a single SSE line
   */
  private _parseLine(line: string): {
    content?: string;
    reasoning?: string;
    usage?: StreamingResult["usage"];
    model?: string;
    finish_reason?: string;
    citations?: string[];
    annotations?: AnnotationData[];
    images?: ImageData[];
  } | null {
    if (!line.trim()) return null;

    // SSE data lines start with "data: "
    if (!line.startsWith("data: ")) {
      // Show "Generating..." for non-data lines if no content yet
      return null;
    }

    const jsonData = line.slice(6);

    if (jsonData === "[DONE]") {
      return null;
    }

    try {
      const parsed = JSON.parse(jsonData);
      const result: ReturnType<typeof this._parseLine> = {};

      // Extract content delta
      if (parsed.choices?.[0]?.delta?.content) {
        result.content = parsed.choices[0].delta.content;
      }

      // Extract reasoning (OpenRouter style)
      if (parsed.choices?.[0]?.delta?.reasoning) {
        result.reasoning = parsed.choices[0].delta.reasoning;
      }

      // Extract usage (usually in final chunk)
      if (parsed.usage) {
        result.usage = {
          total_tokens: parsed.usage.total_tokens,
          prompt_tokens: parsed.usage.prompt_tokens,
          completion_tokens: parsed.usage.completion_tokens,
        };
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
  private _handleContent(
    content: string,
    callbacks: StreamCallbacks,
    modelId?: string
  ): void {
    // If we were in thinking mode and now got content, close thinking tag
    if (this.isInThinking && !this.isInContent) {
      this.accumulatedThinking += "</thinking>";
      callbacks.onThinking(this.accumulatedThinking);
      this.isInThinking = false;
      this.isInContent = true;
    }

    // For models that use <thinking> tags inline
    if (modelId) {
      this._extractThinkingFromContent(content, callbacks);
    } else {
      this.accumulatedContent += content;
    }

    callbacks.onContent(this.accumulatedContent);
  }

  /**
   * Handle thinking/reasoning content
   */
  private _handleThinking(reasoning: string, callbacks: StreamCallbacks): void {
    if (!this.isInThinking) {
      this.accumulatedThinking += "<thinking> ";
      this.isInThinking = true;
    }
    this.accumulatedThinking += reasoning;
    callbacks.onThinking(this.accumulatedThinking);
  }

  /**
   * Extract thinking blocks from content (for models with inline thinking)
   */
  private _extractThinkingFromContent(
    content: string,
    callbacks: StreamCallbacks
  ): void {
    // Simple extraction - models that wrap thinking in <thinking> tags
    const parts = content.split(/(<thinking>|<\/thinking>)/);

    for (const part of parts) {
      if (part === "<thinking>") {
        this.isInThinking = true;
        if (!this.accumulatedThinking.includes("<thinking>")) {
          this.accumulatedThinking += "<thinking> ";
        }
      } else if (part === "</thinking>") {
        this.isInThinking = false;
        this.accumulatedThinking += "</thinking>";
      } else if (this.isInThinking) {
        this.accumulatedThinking += part;
      } else {
        this.accumulatedContent += part;
      }
    }
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
