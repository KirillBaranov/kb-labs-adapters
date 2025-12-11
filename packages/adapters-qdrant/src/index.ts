/**
 * @module @kb-labs/adapters-qdrant
 * Qdrant adapter implementing IVectorStore interface.
 *
 * @example
 * ```typescript
 * import { createAdapter } from '@kb-labs/adapters-qdrant';
 *
 * const vectorStore = createAdapter({
 *   url: 'http://localhost:6333',
 *   apiKey: process.env.QDRANT_API_KEY,
 *   collectionName: 'my-collection',
 *   dimension: 1536,
 * });
 *
 * await vectorStore.upsert([
 *   { id: '1', vector: [...], metadata: { text: 'hello' } },
 * ]);
 *
 * const results = await vectorStore.search([...], 10);
 * ```
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import type {
  IVectorStore,
  VectorRecord,
  VectorSearchResult,
  VectorFilter,
} from '@kb-labs/core-platform';
import { createHash } from 'node:crypto';

/**
 * Configuration for Qdrant vector store adapter.
 */
export interface QdrantVectorStoreConfig {
  /** Qdrant server URL (e.g., 'http://localhost:6333') */
  url: string;
  /** API key for authentication (optional) */
  apiKey?: string;
  /** Collection name (default: 'kb-vectors') */
  collectionName?: string;
  /** Vector dimension (default: 1536, for OpenAI text-embedding-3-small) */
  dimension?: number;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
}

/**
 * Convert a string to a deterministic UUID v4-like format.
 * Qdrant requires point IDs to be either unsigned integers or UUIDs.
 */
function stringToUUID(str: string): string {
  const hash = createHash('sha256').update(str).digest();
  // Format as UUID v4 (8-4-4-4-12 hex digits)
  const uuid = [
    hash.slice(0, 4).toString('hex'),
    hash.slice(4, 6).toString('hex'),
    hash.slice(6, 8).toString('hex'),
    hash.slice(8, 10).toString('hex'),
    hash.slice(10, 16).toString('hex'),
  ].join('-');
  return uuid;
}

/**
 * Qdrant implementation of IVectorStore interface.
 */
export class QdrantVectorStore implements IVectorStore {
  private client: QdrantClient;
  private collectionName: string;
  private dimension: number;
  private initialized = false;
  private url: string;

  // Adaptive concurrency state
  private concurrency = 3; // Start with 3 parallel batches
  private consecutiveErrors = 0;
  private consecutiveSuccesses = 0;

  constructor(config: QdrantVectorStoreConfig) {
    this.url = config.url;
    this.client = new QdrantClient({
      url: config.url,
      apiKey: config.apiKey,
      timeout: config.timeout ?? 30000,
    });
    this.collectionName = config.collectionName ?? 'kb-vectors';
    this.dimension = config.dimension ?? 1536;
  }

  /**
   * Ensure collection exists with correct configuration.
   */
  private async ensureCollection(): Promise<void> {
    if (this.initialized) return;

    try {
      // Check if collection exists
      const collections = await this.client.getCollections();
      const exists = collections.collections.some(
        (c) => c.name === this.collectionName,
      );

      if (!exists) {
        // Create collection with cosine similarity
        await this.client.createCollection(this.collectionName, {
          vectors: {
            size: this.dimension,
            distance: 'Cosine',
          },
        });
      }

      this.initialized = true;
    } catch (error) {
      throw new Error(
        `Failed to initialize Qdrant collection: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async search(
    query: number[],
    limit: number,
    filter?: VectorFilter,
  ): Promise<VectorSearchResult[]> {
    await this.ensureCollection();

    // Build Qdrant filter if provided
    const qdrantFilter = filter
      ? {
          must: [
            {
              key: filter.field,
              match:
                filter.operator === 'eq'
                  ? { value: filter.value }
                  : undefined,
              range:
                filter.operator === 'gt' || filter.operator === 'gte'
                  ? { gt: filter.value }
                  : filter.operator === 'lt' || filter.operator === 'lte'
                    ? { lt: filter.value }
                    : undefined,
            },
          ],
        }
      : undefined;

    const response = await this.client.search(this.collectionName, {
      vector: query,
      limit,
      filter: qdrantFilter,
      with_payload: true,
    });

    return response.map((point) => ({
      id: String(point.id),
      score: point.score,
      metadata: point.payload as Record<string, unknown> | undefined,
    }));
  }

  async upsert(vectors: VectorRecord[]): Promise<void> {
    await this.ensureCollection();

    if (vectors.length === 0) return;

    const points = vectors.map((record) => ({
      id: stringToUUID(record.id),
      vector: record.vector,
      payload: record.metadata ?? {},
    }));

    // Batch upsert with adaptive parallel processing (Qdrant supports up to 100 points per request)
    const batchSize = 100;
    const totalBatches = Math.ceil(points.length / batchSize);

    // Create all batches
    type QdrantPoint = { id: string; vector: number[]; payload: Record<string, unknown> };
    const batches: QdrantPoint[][] = [];
    for (let i = 0; i < points.length; i += batchSize) {
      batches.push(points.slice(i, i + batchSize) as QdrantPoint[]);
    }

    // Process batches with adaptive concurrency
    let batchIndex = 0;
    while (batchIndex < batches.length) {
      const currentConcurrency = Math.min(this.concurrency, batches.length - batchIndex);
      const batchGroup = batches.slice(batchIndex, batchIndex + currentConcurrency);

      const batchPromises = batchGroup.map(async (batch) => {
        try {
          await this.client.upsert(this.collectionName, {
            wait: false, // ⚡ Don't wait for indexing - let Qdrant index asynchronously
            points: batch,
          });

          // Success: increase concurrency gradually
          this.consecutiveErrors = 0;
          this.consecutiveSuccesses++;
          if (this.consecutiveSuccesses >= 5 && this.concurrency < 10) {
            this.concurrency++;
            this.consecutiveSuccesses = 0;
          }
        } catch (error) {
          // Error: decrease concurrency for graceful degradation
          this.consecutiveSuccesses = 0;
          this.consecutiveErrors++;
          if (this.consecutiveErrors >= 2 && this.concurrency > 1) {
            this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
            this.consecutiveErrors = 0;
          }

          throw error;
        }
      });

      // Wait for this group of concurrent batches to complete
      try {
        await Promise.all(batchPromises);
        batchIndex += batchGroup.length;
      } catch (error) {
        // If group fails, retry with reduced concurrency (already adjusted above)
        // Don't increment batchIndex - retry same batches
      }
    }
  }

  async delete(ids: string[]): Promise<void> {
    await this.ensureCollection();

    if (ids.length === 0) return;

    const uuids = ids.map(stringToUUID);

    await this.client.delete(this.collectionName, {
      wait: false, // ⚡ Don't wait for indexing - let Qdrant process asynchronously
      points: uuids,
    });
  }

  async count(): Promise<number> {
    await this.ensureCollection();

    const info = await this.client.getCollection(this.collectionName);
    return info.points_count ?? 0;
  }

  /**
   * Get vectors by IDs (implements optional IVectorStore method).
   * @param ids - Array of vector IDs to retrieve
   * @returns Array of vector records
   */
  async get(ids: string[]): Promise<VectorRecord[]> {
    await this.ensureCollection();

    if (ids.length === 0) return [];

    const response = await this.client.retrieve(this.collectionName, {
      ids: ids.map((id) => stringToUUID(id)),
      with_vector: true,
      with_payload: true,
    });

    return response.map((point) => ({
      id: String(point.id),
      vector: point.vector as number[],
      metadata: point.payload as Record<string, unknown> | undefined,
    }));
  }

  /**
   * Query vectors by metadata filter (implements optional IVectorStore method).
   * @param filter - Metadata filter to apply
   * @returns Array of matching vector records
   */
  async query(filter: VectorFilter): Promise<VectorRecord[]> {
    await this.ensureCollection();

    // Qdrant scroll API for querying by metadata
    const response = await this.client.scroll(this.collectionName, {
      filter: this.convertFilter(filter),
      with_vector: true,
      with_payload: true,
      limit: 10000, // Max limit for bulk retrieval
    });

    return response.points.map((point) => ({
      id: String(point.id),
      vector: point.vector as number[],
      metadata: point.payload as Record<string, unknown> | undefined,
    }));
  }

  /**
   * Convert platform VectorFilter to Qdrant filter format.
   */
  private convertFilter(filter: VectorFilter): any {
    const fieldParts = filter.field.split('.');
    const fieldName = fieldParts[fieldParts.length - 1]; // Get last part after dots

    switch (filter.operator) {
      case 'eq':
        return { must: [{ key: fieldName, match: { value: filter.value } }] };
      case 'ne':
        return { must_not: [{ key: fieldName, match: { value: filter.value } }] };
      case 'in':
        return { must: [{ key: fieldName, match: { any: filter.value as any[] } }] };
      case 'nin':
        return { must_not: [{ key: fieldName, match: { any: filter.value as any[] } }] };
      default:
        // For gt/gte/lt/lte - use range filter
        return { must: [{ key: fieldName, range: { [filter.operator]: filter.value } }] };
    }
  }
}

/**
 * Create Qdrant vector store adapter.
 * This is the factory function called by initPlatform() when loading adapters.
 */
export function createAdapter(config?: QdrantVectorStoreConfig): QdrantVectorStore {
  const fallbackUrl = process.env.QDRANT_URL ?? 'http://localhost:6333';
  const finalConfig: QdrantVectorStoreConfig = {
    url: config?.url ?? fallbackUrl,
    apiKey: config?.apiKey ?? process.env.QDRANT_API_KEY,
    collectionName: config?.collectionName,
    dimension: config?.dimension,
    timeout: config?.timeout,
  };
  return new QdrantVectorStore(finalConfig);
}

// Default export for direct import
export default createAdapter;
