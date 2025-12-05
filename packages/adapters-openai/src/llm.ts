/**
 * @module @kb-labs/adapters-openai/llm
 * OpenAI implementation of ILLM interface.
 */

import OpenAI from 'openai';
import type { ILLM, LLMOptions, LLMResponse } from '@kb-labs/core-platform';

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
    this.defaultModel = config.defaultModel ?? 'gpt-4o-mini';
  }

  async complete(prompt: string, options?: LLMOptions): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;
    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    // Add system prompt if provided
    if (options?.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }

    // Add user prompt
    messages.push({ role: 'user', content: prompt });

    const response = await this.client.chat.completions.create({
      model,
      messages,
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      stop: options?.stop,
    });

    const choice = response.choices[0];
    const content = choice?.message?.content ?? '';

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
      messages.push({ role: 'system', content: options.systemPrompt });
    }

    // Add user prompt
    messages.push({ role: 'user', content: prompt });

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
}
