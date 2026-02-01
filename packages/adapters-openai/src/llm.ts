/**
 * @module @kb-labs/adapters-openai/llm
 * OpenAI implementation of ILLM interface.
 */

import OpenAI from "openai";
import type {
  ILLM,
  LLMOptions,
  LLMResponse,
  LLMMessage,
  LLMToolCallOptions,
  LLMToolCallResponse,
  LLMTool,
  LLMToolCall,
} from "@kb-labs/core-platform";

/**
 * Configuration for OpenAI LLM adapter.
 */
export interface OpenAILLMConfig {
  /** OpenAI API key (defaults to OPENAI_API_KEY env var) */
  apiKey?: string;
  /** Base URL for API (optional, for proxies or Azure) */
  baseURL?: string;
  /** Default model to use */
  defaultModel?: string;
  /** Organization ID (optional) */
  organization?: string;
}

/**
 * OpenAI implementation of ILLM interface.
 */
export class OpenAILLM implements ILLM {
  private client: OpenAI;
  private defaultModel: string;

  constructor(config: OpenAILLMConfig = {}) {
    this.client = new OpenAI({
      apiKey: config.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: config.baseURL,
      organization: config.organization,
    });
    this.defaultModel = config.defaultModel ?? "gpt-4o-mini";
  }

  async complete(prompt: string, options?: LLMOptions): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;
    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    // Add system prompt if provided
    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }

    // Add user prompt
    messages.push({ role: "user", content: prompt });

    const response = await this.client.chat.completions.create({
      model,
      messages,
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      stop: options?.stop,
    });

    const choice = response.choices[0];
    const content = choice?.message?.content ?? "";

    return {
      content,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
      },
      model: response.model,
    };
  }

  async *stream(prompt: string, options?: LLMOptions): AsyncIterable<string> {
    const model = options?.model ?? this.defaultModel;
    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    // Add system prompt if provided
    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }

    // Add user prompt
    messages.push({ role: "user", content: prompt });

    const stream = await this.client.chat.completions.create({
      model,
      messages,
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      stop: options?.stop,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }

  /**
   * Chat with native tool calling support.
   * Uses OpenAI's native function calling API.
   */
  async chatWithTools(
    messages: LLMMessage[],
    options: LLMToolCallOptions,
  ): Promise<LLMToolCallResponse> {
    const model = options?.model ?? this.defaultModel;

    // Convert LLMMessage[] to OpenAI format
    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = messages.map(
      (msg) => {
        if (msg.role === "tool") {
          return {
            role: "tool" as const,
            content: msg.content,
            tool_call_id: msg.toolCallId || "",
          };
        }
        if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
          // Assistant message with tool calls
          return {
            role: "assistant" as const,
            content: msg.content || null,
            tool_calls: msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input),
              },
            })),
          };
        }
        return {
          role: msg.role as "system" | "user" | "assistant",
          content: msg.content,
        };
      },
    );

    // Convert LLMTool[] to OpenAI tools format
    const tools: OpenAI.ChatCompletionTool[] = options.tools.map(
      (tool: LLMTool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }),
    );

    // Convert tool choice
    let tool_choice: OpenAI.ChatCompletionToolChoiceOption | undefined;
    if (options.toolChoice === "auto") {
      tool_choice = "auto";
    } else if (options.toolChoice === "required") {
      tool_choice = "required";
    } else if (options.toolChoice === "none") {
      tool_choice = "none";
    } else if (options.toolChoice && typeof options.toolChoice === "object") {
      tool_choice = {
        type: "function",
        function: { name: options.toolChoice.function.name },
      };
    }

    // Call OpenAI API
    const response = await this.client.chat.completions.create({
      model,
      messages: openaiMessages,
      tools,
      tool_choice,
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      stop: options?.stop,
    });

    const choice = response.choices[0];
    const content = choice?.message?.content ?? "";

    // Extract tool calls if any
    const toolCalls: LLMToolCall[] = [];
    if (choice?.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        try {
          const input = JSON.parse(tc.function.arguments);
          toolCalls.push({
            id: tc.id,
            name: tc.function.name,
            input,
          });
        } catch (error) {
          // Failed to parse tool arguments - skip this tool call
          console.warn("Failed to parse tool arguments", {
            toolName: tc.function.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return {
      content,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
      },
      model: response.model,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }
}

/**
 * Create OpenAI LLM adapter.
 * This is the factory function called by initPlatform() when loading adapters.
 */
export function createAdapter(config?: OpenAILLMConfig): OpenAILLM {
  return new OpenAILLM(config);
}

// Default export for direct import
export default createAdapter;
