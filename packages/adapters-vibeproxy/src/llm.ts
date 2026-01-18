/**
 * @module @kb-labs/adapters-vibeproxy/llm
 * VibeProxy implementation of ILLM interface.
 * Connects to local VibeProxy server (supports Claude, GPT, and other models).
 */

import type {
  ILLM,
  LLMOptions,
  LLMResponse,
  LLMMessage,
  LLMToolCallOptions,
  LLMToolCallResponse,
  LLMTool,
  LLMToolCall,
} from '@kb-labs/core-platform';

/**
 * Configuration for VibeProxy LLM adapter.
 */
export interface VibeProxyLLMConfig {
  /** Base URL for VibeProxy (defaults to http://localhost:8317) */
  baseURL?: string;
  /** API key (can be any string for VibeProxy) */
  apiKey?: string;
  /** Default model to use */
  defaultModel?: string;
  /** Request timeout in ms (defaults to 120000) */
  timeout?: number;
}

/**
 * VibeProxy Messages API request format.
 */
interface VibeProxyMessagesRequest {
  model: string;
  max_tokens: number;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string | Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown } | { type: 'tool_result'; tool_use_id: string; content: string }>;
  }>;
  system?: string;
  temperature?: number;
  stop_sequences?: string[];
  tools?: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice?: { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string };
}

/**
 * VibeProxy Messages API response format.
 */
interface VibeProxyMessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }>;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * VibeProxy implementation of ILLM interface.
 * Supports multiple model providers through local VibeProxy server.
 */
export class VibeProxyLLM implements ILLM {
  private baseURL: string;
  private apiKey: string;
  private defaultModel: string;
  private timeout: number;

  constructor(config: VibeProxyLLMConfig = {}) {
    this.baseURL = config.baseURL ?? process.env.VIBEPROXY_URL ?? 'http://localhost:8317';
    this.apiKey = config.apiKey ?? process.env.VIBEPROXY_API_KEY ?? 'any-string';
    this.defaultModel = config.defaultModel ?? process.env.VIBEPROXY_MODEL ?? 'claude-sonnet-4-20250514';
    this.timeout = config.timeout ?? 120000;
  }

  /**
   * Make a request to VibeProxy.
   */
  private async request<T>(endpoint: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseURL}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ error: { message: response.statusText } })) as { error?: { message?: string } };
        throw new Error(`VibeProxy error: ${errorBody.error?.message ?? response.statusText}`);
      }

      return response.json() as Promise<T>;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async complete(prompt: string, options?: LLMOptions): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;

    const requestBody: VibeProxyMessagesRequest = {
      model,
      max_tokens: options?.maxTokens ?? 4096,
      messages: [{ role: 'user', content: prompt }],
    };

    if (options?.systemPrompt) {
      requestBody.system = options.systemPrompt;
    }
    if (options?.temperature !== undefined) {
      requestBody.temperature = options.temperature;
    }
    if (options?.stop) {
      requestBody.stop_sequences = options.stop;
    }

    const response = await this.request<VibeProxyMessagesResponse>('/v1/messages', requestBody);

    const textContent = response.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');

    return {
      content: textContent,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
      },
      model: response.model,
    };
  }

  async *stream(prompt: string, options?: LLMOptions): AsyncIterable<string> {
    // VibeProxy supports streaming via SSE, but for simplicity we'll use non-streaming
    // and yield the full response. Can be enhanced later with proper SSE support.
    const response = await this.complete(prompt, options);
    yield response.content;
  }

  /**
   * Chat with native tool calling support.
   */
  async chatWithTools(
    messages: LLMMessage[],
    options: LLMToolCallOptions
  ): Promise<LLMToolCallResponse> {
    const model = options?.model ?? this.defaultModel;

    // Convert LLMMessage[] to VibeProxy format
    const vibeProxyMessages: VibeProxyMessagesRequest['messages'] = [];
    let systemPrompt: string | undefined;

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt = msg.content;
        continue;
      }

      if (msg.role === 'tool') {
        // Tool results go in user message
        vibeProxyMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.toolCallId || '',
            content: msg.content,
          }],
        });
        continue;
      }

      vibeProxyMessages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      });
    }

    // Convert LLMTool[] to VibeProxy tools format
    const tools: VibeProxyMessagesRequest['tools'] = options.tools.map((tool: LLMTool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));

    // Convert tool choice
    let tool_choice: VibeProxyMessagesRequest['tool_choice'];
    if (options.toolChoice === 'auto') {
      tool_choice = { type: 'auto' };
    } else if (options.toolChoice === 'required') {
      tool_choice = { type: 'any' };
    } else if (options.toolChoice && typeof options.toolChoice === 'object') {
      tool_choice = { type: 'tool', name: options.toolChoice.function.name };
    }
    // 'none' - don't send tools at all

    const requestBody: VibeProxyMessagesRequest = {
      model,
      max_tokens: options?.maxTokens ?? 4096,
      messages: vibeProxyMessages,
      tools: options.toolChoice !== 'none' ? tools : undefined,
      tool_choice: options.toolChoice !== 'none' ? tool_choice : undefined,
    };

    if (systemPrompt || options?.systemPrompt) {
      requestBody.system = systemPrompt ?? options.systemPrompt;
    }
    if (options?.temperature !== undefined) {
      requestBody.temperature = options.temperature;
    }
    if (options?.stop) {
      requestBody.stop_sequences = options.stop;
    }

    const response = await this.request<VibeProxyMessagesResponse>('/v1/messages', requestBody);

    // Extract text content
    const textContent = response.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');

    // Extract tool calls
    const toolCalls: LLMToolCall[] = response.content
      .filter((c): c is { type: 'tool_use'; id: string; name: string; input: unknown } => c.type === 'tool_use')
      .map((tc) => ({
        id: tc.id,
        name: tc.name,
        input: tc.input,
      }));

    return {
      content: textContent,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
      },
      model: response.model,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }
}

/**
 * Create VibeProxy LLM adapter.
 * This is the factory function called by initPlatform() when loading adapters.
 */
export function createAdapter(config?: VibeProxyLLMConfig): VibeProxyLLM {
  return new VibeProxyLLM(config);
}

// Default export for direct import
export default createAdapter;
