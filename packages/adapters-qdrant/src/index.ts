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

  constructor(config: QdrantVectorStoreConfig) {
    console.error(`\n========== QdrantVectorStore.constructor ==========`);
    console.error(`url=${config.url}`);
    console.error(`collectionName=${config.collectionName ?? 'kb-vectors'}`);
    console.error(`Stack trace:`);
    console.error(new Error().stack);
    console.error(`===================================================\n`);

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
      // DEBUG: Log full error
      console.error('[QdrantVectorStore.ensureCollection] ERROR:', error);
      console.error('[QdrantVectorStore.ensureCollection] Error type:', error?.constructor?.name);
      console.error('[QdrantVectorStore.ensureCollection] Error stack:', error instanceof Error ? error.stack : 'no stack');

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

    const fs = await import('node:fs/promises');
    const log = (msg: string) => fs.appendFile('/tmp/qdrant-search-debug.log', msg + '\n');

    await log(`[QdrantVectorStore.search] START`);
    await log(`[QdrantVectorStore.search] collection=${this.collectionName}`);
    await log(`[QdrantVectorStore.search] vectorLength=${query.length}`);
    await log(`[QdrantVectorStore.search] limit=${limit}`);
    await log(`[QdrantVectorStore.search] filter=${JSON.stringify(filter)}`);

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

    await log(`[QdrantVectorStore.search] qdrantFilter=${JSON.stringify(qdrantFilter)}`);
    await log(`[QdrantVectorStore.search] About to call client.search...`);

    try {
      const response = await this.client.search(this.collectionName, {
        vector: query,
        limit,
        filter: qdrantFilter,
        with_payload: true,
      });

      await log(`[QdrantVectorStore.search] SUCCESS: got ${response.length} results`);

      return response.map((point) => ({
        id: String(point.id),
        score: point.score,
        metadata: point.payload as Record<string, unknown> | undefined,
      }));
    } catch (error) {
      await log(`[QdrantVectorStore.search] ERROR: ${error instanceof Error ? error.message : String(error)}`);
      await log(`[QdrantVectorStore.search] ERROR stack: ${error instanceof Error ? error.stack : 'no stack'}`);
      throw error;
    }
  }

  async upsert(vectors: VectorRecord[]): Promise<void> {
    const fs = await import('node:fs/promises');
    const log = (msg: string) => fs.appendFile('/tmp/platform-vector-debug.log', msg + '\n');

    await log(`[QdrantVectorStore.upsert] START vectors.length=${vectors.length}`);
    await this.ensureCollection();
    await log(`[QdrantVectorStore.upsert] ensureCollection completed`);

    if (vectors.length === 0) return;

    const points = vectors.map((record) => ({
      id: stringToUUID(record.id),
      vector: record.vector,
      payload: record.metadata ?? {},
    }));
    await log(`[QdrantVectorStore.upsert] Converted to ${points.length} points, will batch upsert...`);

    // Batch upsert (Qdrant supports up to 100 points per request)
    const batchSize = 100;
    const totalBatches = Math.ceil(points.length / batchSize);
    await log(`[QdrantVectorStore.upsert] Starting batched upsert: ${totalBatches} batches of ${batchSize}`);

    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;

      await log(`[QdrantVectorStore.upsert] Batch ${batchNum}/${totalBatches}: upserting ${batch.length} points...`);

      if (i === 0 && batch.length > 0 && batch[0]) {
        await log(`[QdrantVectorStore.upsert] Sample point[0]: ${JSON.stringify({
          id: batch[0].id,
          vectorLength: batch[0].vector?.length,
          payloadKeys: Object.keys(batch[0].payload ?? {})
        })}`);
      }

      try {
        await this.client.upsert(this.collectionName, {
          wait: true,
          points: batch,
        });
        await log(`[QdrantVectorStore.upsert] Batch ${batchNum}/${totalBatches} completed`);
      } catch (error) {
        await log(`[QdrantVectorStore.upsert] ERROR in batch ${batchNum}: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    }

    await log(`[QdrantVectorStore.upsert] All ${totalBatches} batches completed successfully`);
  }

  async delete(ids: string[]): Promise<void> {
    await this.ensureCollection();

    if (ids.length === 0) return;

    const uuids = ids.map(stringToUUID);

    await this.client.delete(this.collectionName, {
      wait: true,
      points: uuids,
    });
  }

  async count(): Promise<number> {
    await this.ensureCollection();

    const info = await this.client.getCollection(this.collectionName);
    return info.points_count ?? 0;
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
