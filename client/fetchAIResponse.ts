import type { Message, StreamingResult, SdkLogger } from "../core/types";
import type { ProviderRegistry, StreamingCallbacks } from "../wallet/interfaces";
import { StreamProcessor } from "./StreamProcessor";
import type { AlertLevel, FetchOptions, RoutstrClientMode } from "./RoutstrClient";

interface FetchAIResponseClient {
  routeRequest(params: {
    path: string;
    method: string;
    body?: unknown;
    headers?: Record<string, string>;
    baseUrl: string;
    mintUrl: string;
    modelId?: string;
  }): Promise<Response>;
  getProviderManager(): {
    getModelForProvider(baseUrl: string, modelId: string): Promise<{ id: string } | null>;
  };
  getMode(): RoutstrClientMode;
}

export interface FetchAIResponseDeps {
  client: FetchAIResponseClient;
  providerRegistry: ProviderRegistry;
  alertLevel: AlertLevel;
  logger: SdkLogger;
  getPendingCashuTokenAmount?: () => number;
}

/**
 * Fetch an AI chat/completions response using RoutstrClient.routeRequest for
 * payment/auth/failover/accounting, then consume the returned SSE stream and
 * drive the legacy streaming callbacks.
 */
export async function fetchAIResponse(
  options: FetchOptions,
  callbacks: StreamingCallbacks,
  deps: FetchAIResponseDeps
): Promise<void> {
  const {
    messageHistory,
    selectedModel,
    baseUrl,
    mintUrl,
    maxTokens,
    headers,
  } = options;

  try {
    const apiMessages = await convertMessages(messageHistory);

    callbacks.onPaymentProcessing?.(true);

    callbacks.onTokenCreated?.(deps.getPendingCashuTokenAmount?.() ?? 0);

    const providerInfo = await deps.providerRegistry.getProviderInfo(baseUrl);
    const providerVersion = providerInfo?.version ?? "";

    let modelIdForRequest = selectedModel.id;
    if (/^0\.1\./.test(providerVersion)) {
      const newModel = await deps.client
        .getProviderManager()
        .getModelForProvider(baseUrl, selectedModel.id);
      modelIdForRequest = newModel?.id ?? selectedModel.id;
    }

    const body: any = {
      model: modelIdForRequest,
      messages: apiMessages,
      stream: true,
    };

    if (maxTokens !== undefined) {
      body.max_tokens = maxTokens;
    }

    if (selectedModel?.name?.startsWith("OpenAI:")) {
      body.tools = [{ type: "web_search" }];
    }

    const response = await deps.client.routeRequest({
      path: "/v1/chat/completions",
      method: "POST",
      body,
      headers,
      baseUrl,
      mintUrl,
      modelId: selectedModel.id,
    });

    if (!response.body) {
      throw new Error("Response body is not available");
    }

    if (response.status !== 200) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const streamProcessor = new StreamProcessor();
    const streamingResult = await streamProcessor.process(
      response,
      {
        onContent: callbacks.onStreamingUpdate,
        onThinking: callbacks.onThinkingUpdate,
      },
      selectedModel.id
    );

    if (streamingResult.finish_reason === "content_filter") {
      callbacks.onMessageAppend({
        role: "assistant",
        content: "Your request was denied due to content filtering.",
      });
    } else if (
      streamingResult.content ||
      (streamingResult.images && streamingResult.images.length > 0)
    ) {
      const message = await createAssistantMessage(streamingResult);
      callbacks.onMessageAppend(message);
    } else {
      callbacks.onMessageAppend({
        role: "system",
        content: "The provider did not respond to this request.",
      });
    }

    callbacks.onStreamingUpdate("");
    callbacks.onThinkingUpdate("");

    // routeRequest owns usage extraction + balance finalization. For streaming
    // responses it runs finalization in the background while this function
    // consumes the client-facing stream. Consumers that need exact cost can read
    // the persisted usage entry later.
  } catch (error) {
    handleError(error, callbacks, deps.alertLevel, deps.logger);
  } finally {
    callbacks.onPaymentProcessing?.(false);
  }
}

async function convertMessages(messages: Message[]): Promise<any[]> {
  return Promise.all(
    messages
      .filter((m) => m.role !== "system")
      .map(async (m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : m.content,
      }))
  );
}

async function createAssistantMessage(result: StreamingResult): Promise<Message> {
  if (result.images && result.images.length > 0) {
    const content: any[] = [];

    if (result.content) {
      content.push({
        type: "text",
        text: result.content,
        thinking: result.thinking,
        citations: result.citations,
        annotations: result.annotations,
      });
    }

    for (const img of result.images) {
      content.push({
        type: "image_url",
        image_url: {
          url: img.image_url.url,
        },
      });
    }

    return {
      role: "assistant",
      content,
    };
  }

  return {
    role: "assistant",
    content: result.content || "",
  };
}

function handleError(
  error: unknown,
  callbacks: StreamingCallbacks,
  alertLevel: AlertLevel,
  logger: SdkLogger
): void {
  logger.error("[fetchAIResponse] Error occurred", error);

  if (error instanceof Error) {
    const isStreamError =
      error.message.includes("Error in input stream") ||
      error.message.includes("Load failed");
    const modifiedErrorMsg = isStreamError
      ? "AI stream was cut off, turn on Keep Active or please try again"
      : error.message;

    logger.error(
      `[fetchAIResponse] Error type=${error.constructor.name}, message=${modifiedErrorMsg}, isStreamError=${isStreamError}`
    );

    callbacks.onMessageAppend({
      role: "system",
      content:
        "Uncaught Error: " +
        modifiedErrorMsg +
        (alertLevel === "max" ? " | " + error.stack : ""),
    });
  } else {
    callbacks.onMessageAppend({
      role: "system",
      content: "Unknown Error: Please tag Routstr on Nostr and/or retry.",
    });
  }
}
