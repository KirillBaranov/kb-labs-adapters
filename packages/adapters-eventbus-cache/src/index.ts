/**
 * @module @kb-labs/adapters-eventbus-cache
 * EventBus adapter using ICache for persistent event storage.
 *
 * @example
 * ```typescript
 * import { createAdapter } from '@kb-labs/adapters-eventbus-cache';
 * import { MemoryCache } from '@kb-labs/core-platform/noop';
 *
 * // When loaded by platform, deps are injected automatically.
 * // For manual usage:
 * const cache = new MemoryCache();
 * const eventBus = createAdapter(
 *   { pollIntervalMs: 500, eventTtlMs: 3600000 },
 *   { cache }
 * );
 *
 * // Subscribe to events
 * const unsubscribe = eventBus.subscribe('user.created', async (event) => {
 *   console.log('User created:', event);
 * });
 *
 * // Publish event
 * await eventBus.publish('user.created', { id: '123', name: 'Alice' });
 *
 * // Cleanup
 * unsubscribe();
 * eventBus.disconnect();
 * ```
 */

import { randomUUID } from 'node:crypto';
import type { IEventBus, ICache, EventHandler, Unsubscribe } from '@kb-labs/core-platform';
import type { CacheEventBusConfig, StoredEvent, Subscription, CacheEventBusDeps } from './types.js';

// Re-export manifest and types
export { manifest } from './manifest.js';
export type { CacheEventBusConfig, StoredEvent, CacheEventBusDeps } from './types.js';

/**
 * EventBus implementation using ICache for persistent storage.
 *
 * Features:
 * - Persistent events survive restarts (if cache is persistent)
 * - Distributed across processes (if cache is Redis)
 * - Automatic cleanup of old events via TTL
 * - Polling-based subscription mechanism
 */
export class CacheEventBusAdapter implements IEventBus {
  private readonly cache: ICache;
  private readonly config: Required<CacheEventBusConfig>;
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(cache: ICache, config: CacheEventBusConfig = {}) {
    this.cache = cache;
    this.config = {
      pollIntervalMs: config.pollIntervalMs ?? 1000,
      eventTtlMs: config.eventTtlMs ?? 86400000, // 24 hours
      keyPrefix: config.keyPrefix ?? 'eventbus:',
    };
  }

  /**
   * Publish an event to a topic.
   * Events are stored in a sorted set with timestamp as score.
   */
  async publish<T>(topic: string, event: T): Promise<void> {
    const storedEvent: StoredEvent<T> = {
      id: randomUUID(),
      topic,
      data: event,
      timestamp: Date.now(),
    };

    const key = `${this.config.keyPrefix}${topic}`;

    // Add to sorted set with timestamp as score
    await this.cache.zadd(key, storedEvent.timestamp, JSON.stringify(storedEvent));
  }

  /**
   * Subscribe to events on a topic.
   * Uses polling to check for new events at configurable intervals.
   */
  subscribe<T>(topic: string, handler: EventHandler<T>): Unsubscribe {
    const subscriberId = randomUUID();
    const key = `${this.config.keyPrefix}${topic}`;

    const subscription: Subscription = {
      topic,
      handler: handler as (event: unknown) => Promise<void>,
      timer: null,
      subscriberId,
      lastTimestamp: Date.now(),
    };

    // Polling function
    const poll = async (): Promise<void> => {
      try {
        const now = Date.now();

        // Get events newer than last processed
        const events = await this.cache.zrangebyscore(
          key,
          subscription.lastTimestamp + 1,
          now
        );

        // Process events sequentially to preserve order and track lastTimestamp correctly.
        // Parallel execution would break ordering guarantees and cursor tracking.
        for (const eventJson of events) {
          try {
            const storedEvent = JSON.parse(eventJson) as StoredEvent<T>;
            // eslint-disable-next-line no-await-in-loop -- Sequential processing required for event ordering
            await handler(storedEvent.data);
            subscription.lastTimestamp = storedEvent.timestamp;
          } catch (err) {
            console.error(`[CacheEventBus] Handler error for topic "${topic}":`, err);
          }
        }

        // Cleanup old events (older than TTL)
        await this.cleanupOldEvents(key);
      } catch (err) {
        console.error(`[CacheEventBus] Poll error for topic "${topic}":`, err);
      }
    };

    // Start polling timer
    subscription.timer = setInterval(() => void poll(), this.config.pollIntervalMs);
    this.subscriptions.set(subscriberId, subscription);

    // Return unsubscribe function
    return () => {
      const sub = this.subscriptions.get(subscriberId);
      if (sub?.timer) {
        clearInterval(sub.timer);
      }
      this.subscriptions.delete(subscriberId);
    };
  }

  /**
   * Remove events older than TTL from a topic.
   */
  private async cleanupOldEvents(key: string): Promise<void> {
    const cutoff = Date.now() - this.config.eventTtlMs;
    const oldEvents = await this.cache.zrangebyscore(key, 0, cutoff);

    // Cleanup old events
    await Promise.all(oldEvents.map(oldEvent => this.cache.zrem(key, oldEvent)));
  }

  /**
   * Stop all subscriptions and cleanup.
   * Call this on shutdown to prevent memory leaks.
   */
  disconnect(): void {
    for (const sub of this.subscriptions.values()) {
      if (sub.timer) {
        clearInterval(sub.timer);
      }
    }
    this.subscriptions.clear();
  }

  /**
   * Get the number of active subscriptions (for testing/debugging).
   */
  get subscriptionCount(): number {
    return this.subscriptions.size;
  }
}

/**
 * Factory function for adapter loading.
 * Called by initPlatform() when loading adapters from config.
 *
 * @param config - EventBus configuration
 * @param deps - Required dependencies (cache)
 * @returns CacheEventBusAdapter instance
 */
export function createAdapter(
  config: CacheEventBusConfig = {},
  deps: CacheEventBusDeps,
): CacheEventBusAdapter {
  return new CacheEventBusAdapter(deps.cache, config);
}

// Default export for direct import
export default createAdapter;
