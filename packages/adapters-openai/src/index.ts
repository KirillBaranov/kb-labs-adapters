/**
 * @module @kb-labs/adapters-openai
 * OpenAI adapters for KB Labs platform.
 *
 * Implements ILLM and IEmbeddings interfaces from @kb-labs/core-platform.
 *
 * @example
 * ```typescript
 * // In kb.config.json
 * {
 *   "platform": {
 *     "adapters": {
 *       "llm": "@kb-labs/adapters-openai",
 *       "embeddings": "@kb-labs/adapters-openai"
 *     }
 *   }
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Direct usage
 * import { createLLMAdapter, createEmbeddingsAdapter } from '@kb-labs/adapters-openai';
 *
 * const llm = createLLMAdapter({ model: 'gpt-4o' });
 * const embeddings = createEmbeddingsAdapter({ model: 'text-embedding-3-small' });
 * ```
 */

export { OpenAILLM, type OpenAILLMConfig } from './llm.js';
export {
  OpenAIEmbeddings,
  type OpenAIEmbeddingsConfig,
  EMBEDDING_MODELS,
  type EmbeddingModel,
} from './embeddings.js';

import { OpenAILLM, type OpenAILLMConfig } from './llm.js';
import { OpenAIEmbeddings, type OpenAIEmbeddingsConfig } from './embeddings.js';

/**
 * Combined configuration for both LLM and Embeddings.
 */
export interface OpenAIAdapterConfig {
  /** OpenAI API key (defaults to OPENAI_API_KEY env var) */
  apiKey?: string;
  /** Base URL for API (optional) */
  baseURL?: string;
  /** Organization ID (optional) */
  organization?: string;
  /** LLM-specific config */
  llm?: Omit<OpenAILLMConfig, 'apiKey' | 'baseURL' | 'organization'>;
  /** Embeddings-specific config */
  embeddings?: Omit<OpenAIEmbeddingsConfig, 'apiKey' | 'baseURL' | 'organization'>;
}

/**
 * Create OpenAI LLM adapter.
 * This is the factory function called by initPlatform() when loading adapters.
 */
export function createLLMAdapter(config?: OpenAILLMConfig): OpenAILLM {
  return new OpenAILLM(config);
}

/**
 * Create OpenAI embeddings adapter.
 * This is the factory function called by initPlatform() when loading adapters.
 */
export function createEmbeddingsAdapter(config?: OpenAIEmbeddingsConfig): OpenAIEmbeddings {
  return new OpenAIEmbeddings(config);
}

/**
 * Default adapter factory for platform loader.
 * Creates LLM adapter by default.
 *
 * For embeddings, use the subpath import:
 * ```json
 * {
 *   "embeddings": "@kb-labs/adapters-openai/embeddings"
 * }
 * ```
 */
export function createAdapter(config?: OpenAILLMConfig): OpenAILLM {
  return createLLMAdapter(config);
}

// Default export for direct import
export default createAdapter;
