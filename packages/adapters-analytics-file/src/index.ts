import fs from 'fs-extra';
import { join } from 'node:path';
import { format, parseISO } from 'date-fns';
import type {
  IAnalytics,
  AnalyticsContext,
  EventsQuery,
  EventsResponse,
  EventsStats,
  DailyStats,
  BufferStatus,
  DlqStatus,
  AnalyticsEvent as PlatformAnalyticsEvent,
} from '@kb-labs/core-platform/adapters';
import { randomUUID } from 'node:crypto';

export interface FileAnalyticsOptions {
  /**
   * Base directory for analytics logs.
   * Defaults to ".kb/analytics/buffer" relative to process.cwd().
   */
  baseDir?: string;
  /**
   * Filename pattern (without extension), default: "events-YYYYMMDD"
   */
  filenamePattern?: string;
}

/**
 * Legacy stored event format (for backward compatibility)
 */
interface StoredEventLegacy {
  type: 'event' | 'metric';
  timestamp: string;
  name: string;
  properties?: Record<string, unknown>;
  value?: number;
}

class FileAnalytics implements IAnalytics {
  private readonly baseDir: string;
  private readonly filenamePattern: string;
  private context: AnalyticsContext; // Removed readonly to allow setSource()

  constructor(options: FileAnalyticsOptions = {}, context?: AnalyticsContext) {
    // Resolve baseDir: if relative, use cwd from context or process.cwd()
    const cwd = (context?.ctx?.workspace as string) || process.cwd();
    const defaultBaseDir = join(cwd, '.kb/analytics/buffer');
    const configuredBaseDir = options.baseDir ?? defaultBaseDir;

    // If baseDir is relative, resolve from cwd; otherwise use as-is
    this.baseDir = configuredBaseDir.startsWith('/')
      ? configuredBaseDir
      : join(cwd, configuredBaseDir);

    this.filenamePattern = options.filenamePattern ?? 'events-YYYYMMDD';

    // Use provided context or create default
    this.context = context ?? {
      source: { product: 'unknown', version: '0.0.0' },
      runId: randomUUID(),
    };
  }

  async track(event: string, payload?: unknown): Promise<void> {
    // Create V1 event with automatic context enrichment
    const v1Event: PlatformAnalyticsEvent = {
      id: randomUUID(),
      schema: 'kb.v1',
      type: event,
      ts: new Date().toISOString(),
      ingestTs: new Date().toISOString(),
      source: this.context.source,
      runId: this.context.runId,
      actor: this.context.actor,
      ctx: this.context.ctx,
      payload,
    };
    await this.writeV1(v1Event);
  }

  async metric(name: string, value: number, tags?: Record<string, string>): Promise<void> {
    // Metrics are tracked as events with value in payload
    const v1Event: PlatformAnalyticsEvent = {
      id: randomUUID(),
      schema: 'kb.v1',
      type: name,
      ts: new Date().toISOString(),
      ingestTs: new Date().toISOString(),
      source: this.context.source,
      runId: this.context.runId,
      actor: this.context.actor,
      ctx: { ...this.context.ctx, ...tags },
      payload: { value },
    };
    await this.writeV1(v1Event);
  }

  async identify(userId: string, traits?: Record<string, unknown>): Promise<void> {
    const v1Event: PlatformAnalyticsEvent = {
      id: randomUUID(),
      schema: 'kb.v1',
      type: 'user.identify',
      ts: new Date().toISOString(),
      ingestTs: new Date().toISOString(),
      source: this.context.source,
      runId: this.context.runId,
      actor: {
        type: 'user',
        id: userId,
        name: (traits?.name as string) || undefined,
      },
      ctx: this.context.ctx,
      payload: traits,
    };
    await this.writeV1(v1Event);
  }

  async flush(): Promise<void> {
    // No buffering, so nothing to flush
  }

  /**
   * Get current source attribution
   *
   * Returns the current source used for tracking events.
   * Useful for saving and restoring source in nested plugin execution.
   *
   * @returns Current source (product + version)
   */
  getSource(): { product: string; version: string } {
    return this.context.source;
  }

  /**
   * Override source attribution for scoped execution
   *
   * This allows plugins to track events with their own source (product + version)
   * instead of using the root package.json source.
   *
   * @param source - New source to use for future events
   */
  setSource(source: { product: string; version: string }): void {
    this.context = {
      ...this.context,
      source,
    };
  }

  // ========================================
  // Read Methods (NEW)
  // ========================================

  async getEvents(query?: EventsQuery): Promise<EventsResponse> {
    const allEvents = await this.readAllEvents();

    // Apply filters
    let filtered = allEvents;

    if (query?.type) {
      const types = Array.isArray(query.type) ? query.type : [query.type];
      filtered = filtered.filter((e) => types.includes(e.type));
    }

    if (query?.source) {
      filtered = filtered.filter((e) => e.source.product === query.source);
    }

    if (query?.actor) {
      filtered = filtered.filter((e) => e.actor?.type === query.actor);
    }

    if (query?.from) {
      const fromTs = parseISO(query.from).getTime();
      filtered = filtered.filter((e) => parseISO(e.ts).getTime() >= fromTs);
    }

    if (query?.to) {
      const toTs = parseISO(query.to).getTime();
      filtered = filtered.filter((e) => parseISO(e.ts).getTime() <= toTs);
    }

    // Sort by timestamp descending (newest first)
    filtered.sort((a, b) => parseISO(b.ts).getTime() - parseISO(a.ts).getTime());

    // Apply pagination
    const limit = query?.limit ?? 100;
    const offset = query?.offset ?? 0;
    const paginated = filtered.slice(offset, offset + limit);

    return {
      events: paginated,
      total: filtered.length,
      hasMore: offset + limit < filtered.length,
    };
  }

  async getStats(): Promise<EventsStats> {
    const allEvents = await this.readAllEvents();

    const byType: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    const byActor: Record<string, number> = {};

    for (const event of allEvents) {
      byType[event.type] = (byType[event.type] || 0) + 1;
      bySource[event.source.product] = (bySource[event.source.product] || 0) + 1;
      if (event.actor) {
        byActor[event.actor.type] = (byActor[event.actor.type] || 0) + 1;
      }
    }

    const timestamps = allEvents.map((e) => parseISO(e.ts).getTime());
    const oldestTs = timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
    const newestTs = timestamps.length > 0 ? Math.max(...timestamps) : Date.now();

    return {
      totalEvents: allEvents.length,
      byType,
      bySource,
      byActor,
      timeRange: {
        from: new Date(oldestTs).toISOString(),
        to: new Date(newestTs).toISOString(),
      },
    };
  }

  async getDailyStats(query?: EventsQuery): Promise<DailyStats[]> {
    // First, get filtered events using existing getEvents method
    const { events } = await this.getEvents(query);

    // Group events by date (YYYY-MM-DD)
    const eventsByDate = new Map<string, PlatformAnalyticsEvent[]>();

    for (const event of events) {
      const date = format(parseISO(event.ts), 'yyyy-MM-dd');
      if (!eventsByDate.has(date)) {
        eventsByDate.set(date, []);
      }
      eventsByDate.get(date)!.push(event);
    }

    // Aggregate metrics for each day
    const dailyStats: DailyStats[] = [];

    for (const [date, dayEvents] of eventsByDate.entries()) {
      const metrics: Record<string, number> = {};

      // Calculate common metrics based on event type
      const firstEvent = dayEvents[0];
      const eventType = firstEvent?.type || '';

      if (eventType.startsWith('llm.')) {
        // LLM metrics: totalTokens, totalCost, avgDurationMs
        let totalTokens = 0;
        let totalCost = 0;
        let totalDuration = 0;

        for (const event of dayEvents) {
          const payload = event.payload as any;
          totalTokens += payload?.totalTokens || 0;
          totalCost += payload?.cost || 0;
          totalDuration += payload?.durationMs || 0;
        }

        metrics.totalTokens = totalTokens;
        metrics.totalCost = totalCost;
        metrics.avgDurationMs = dayEvents.length > 0 ? totalDuration / dayEvents.length : 0;
      } else if (eventType.startsWith('embeddings.')) {
        // Embeddings metrics: totalTokens, totalCost, avgDurationMs
        let totalTokens = 0;
        let totalCost = 0;
        let totalDuration = 0;

        for (const event of dayEvents) {
          const payload = event.payload as any;
          totalTokens += payload?.tokens || 0;
          totalCost += payload?.cost || 0;
          totalDuration += payload?.durationMs || 0;
        }

        metrics.totalTokens = totalTokens;
        metrics.totalCost = totalCost;
        metrics.avgDurationMs = dayEvents.length > 0 ? totalDuration / dayEvents.length : 0;
      } else if (eventType.startsWith('vectorstore.')) {
        // VectorStore metrics: operation counts, avgDurationMs
        let totalSearches = 0;
        let totalUpserts = 0;
        let totalDeletes = 0;
        let totalDuration = 0;

        for (const event of dayEvents) {
          const payload = event.payload as any;
          if (event.type.includes('search')) totalSearches++;
          if (event.type.includes('upsert')) totalUpserts++;
          if (event.type.includes('delete')) totalDeletes++;
          totalDuration += payload?.durationMs || 0;
        }

        metrics.totalSearches = totalSearches;
        metrics.totalUpserts = totalUpserts;
        metrics.totalDeletes = totalDeletes;
        metrics.avgDurationMs = dayEvents.length > 0 ? totalDuration / dayEvents.length : 0;
      } else if (eventType.startsWith('cache.')) {
        // Cache metrics: hits, misses, sets, hitRate
        let totalHits = 0;
        let totalMisses = 0;
        let totalSets = 0;

        for (const event of dayEvents) {
          if (event.type === 'cache.hit') totalHits++;
          if (event.type === 'cache.miss') totalMisses++;
          if (event.type === 'cache.set') totalSets++;
        }

        const totalGets = totalHits + totalMisses;
        metrics.totalHits = totalHits;
        metrics.totalMisses = totalMisses;
        metrics.totalSets = totalSets;
        metrics.hitRate = totalGets > 0 ? (totalHits / totalGets) * 100 : 0;
      } else if (eventType.startsWith('storage.')) {
        // Storage metrics: bytesRead, bytesWritten, avgDurationMs
        let totalBytesRead = 0;
        let totalBytesWritten = 0;
        let totalDuration = 0;

        for (const event of dayEvents) {
          const payload = event.payload as any;
          totalBytesRead += payload?.bytesRead || 0;
          totalBytesWritten += payload?.bytesWritten || 0;
          totalDuration += payload?.durationMs || 0;
        }

        metrics.totalBytesRead = totalBytesRead;
        metrics.totalBytesWritten = totalBytesWritten;
        metrics.avgDurationMs = dayEvents.length > 0 ? totalDuration / dayEvents.length : 0;
      }

      dailyStats.push({
        date,
        count: dayEvents.length,
        metrics: Object.keys(metrics).length > 0 ? metrics : undefined,
      });
    }

    // Sort by date ascending
    dailyStats.sort((a, b) => a.date.localeCompare(b.date));

    return dailyStats;
  }

  async getBufferStatus(): Promise<BufferStatus | null> {
    // File-based analytics doesn't have a WAL buffer
    // But we can return info about stored files
    try {
      await fs.ensureDir(this.baseDir);
      const files = await fs.readdir(this.baseDir);
      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));

      if (jsonlFiles.length === 0) {
        return null;
      }

      let totalSize = 0;
      const timestamps: number[] = [];

      for (const file of jsonlFiles) {
        const filePath = join(this.baseDir, file);
        const stats = await fs.stat(filePath);
        totalSize += stats.size;

        // Read first and last line to get timestamps
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.trim().split('\n').filter((l) => l.length > 0);

        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            // Handle both V1 and legacy formats
            const ts = event.ts || event.timestamp;
            if (ts) {
              timestamps.push(parseISO(ts).getTime());
            }
          } catch {
            // Skip invalid lines
          }
        }
      }

      return {
        segments: jsonlFiles.length,
        totalSizeBytes: totalSize,
        oldestEventTs: timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : null,
        newestEventTs: timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null,
      };
    } catch (error) {
      return null;
    }
  }

  async getDlqStatus(): Promise<DlqStatus | null> {
    // File-based analytics doesn't have a DLQ
    return null;
  }

  // ========================================
  // Private Methods
  // ========================================

  /**
   * Write V1 event directly to file (new format)
   */
  private async writeV1(event: PlatformAnalyticsEvent): Promise<void> {
    const dateStr = format(new Date(), 'yyyyMMdd');
    const filename = this.filenamePattern.replace('YYYYMMDD', dateStr) + '.jsonl';
    const fullPath = join(this.baseDir, filename);
    await fs.ensureDir(this.baseDir);
    await fs.appendFile(fullPath, JSON.stringify(event) + '\n', { encoding: 'utf8' });
  }

  /**
   * Read all events from all .jsonl files.
   * Supports both V1 format (schema: "kb.v1") and legacy format (for backward compatibility).
   */
  private async readAllEvents(): Promise<PlatformAnalyticsEvent[]> {
    try {
      await fs.ensureDir(this.baseDir);
      const files = await fs.readdir(this.baseDir);
      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));

      const events: PlatformAnalyticsEvent[] = [];

      for (const file of jsonlFiles) {
        const filePath = join(this.baseDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.trim().split('\n').filter((l) => l.length > 0);

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);

            // Check if it's already V1 format
            if (parsed.schema === 'kb.v1') {
              events.push(parsed as PlatformAnalyticsEvent);
            } else {
              // Legacy format - convert to V1
              const legacy = parsed as StoredEventLegacy;
              const mapped = this.mapLegacyToPlatformEvent(legacy);
              events.push(mapped);
            }
          } catch (error) {
            // Skip invalid lines
            console.warn(`Failed to parse line in ${file}:`, error);
          }
        }
      }

      return events;
    } catch (error) {
      console.warn('Failed to read events:', error);
      return [];
    }
  }

  /**
   * Map legacy stored event format to platform AnalyticsEvent format (kb.v1 schema)
   * Used for backward compatibility with old events.
   */
  private mapLegacyToPlatformEvent(stored: StoredEventLegacy): PlatformAnalyticsEvent {
    // Extract actor info from properties if available
    const userId = stored.properties?.userId as string | undefined;
    const actorType = stored.properties?.actorType as 'user' | 'agent' | 'ci' | undefined;
    const actorName = stored.properties?.actorName as string | undefined;

    // Extract source info from properties if available
    const sourceProduct = (stored.properties?.source as string) || 'file-analytics';
    const sourceVersion = (stored.properties?.version as string) || '0.1.0';

    // Extract runId from properties if available
    const runId = (stored.properties?.runId as string) || randomUUID();

    // Build actor object
    const actor =
      userId || actorType
        ? {
            type: actorType || 'user',
            id: userId,
            name: actorName,
          }
        : undefined;

    // Build context from properties
    const ctx: Record<string, string | number | boolean | null> = {};
    if (stored.properties) {
      for (const [key, value] of Object.entries(stored.properties)) {
        // Skip internal fields
        if (
          ['userId', 'actorType', 'actorName', 'source', 'version', 'runId'].includes(key)
        ) {
          continue;
        }

        // Only include primitive values in ctx
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          value === null
        ) {
          ctx[key] = value;
        }
      }
    }

    return {
      id: randomUUID(),
      schema: 'kb.v1' as const,
      type: stored.name,
      ts: stored.timestamp,
      ingestTs: stored.timestamp,
      source: {
        product: sourceProduct,
        version: sourceVersion,
      },
      runId,
      actor,
      ctx: Object.keys(ctx).length > 0 ? ctx : undefined,
      payload: stored.type === 'metric' && stored.value !== undefined ? { value: stored.value } : stored.properties,
    };
  }
}

export function createAdapter(options?: FileAnalyticsOptions, context?: AnalyticsContext): IAnalytics {
  return new FileAnalytics(options, context);
}

export default createAdapter;
