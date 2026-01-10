/**
 * @module @kb-labs/adapters-log-sqlite
 * SQLite persistence adapter for KB Labs logs.
 *
 * Features:
 * - Automatic schema initialization
 * - Batch writes with auto-flush
 * - Full-text search support (FTS5)
 * - Retention policy support
 * - Cross-process log aggregation
 *
 * @example
 * ```typescript
 * import { createAdapter } from '@kb-labs/adapters-log-sqlite';
 * import { createAdapter as createDB } from '@kb-labs/adapters-sqlite';
 *
 * const db = createDB({ filename: '.kb/data/kb.db' });
 * const persistence = await createAdapter({
 *   database: db,
 *   batchSize: 100,
 *   flushInterval: 5000,
 * });
 *
 * // Write logs
 * await persistence.write({
 *   timestamp: Date.now(),
 *   level: 'info',
 *   message: 'Server started',
 *   fields: { port: 3000 },
 *   source: 'rest-api',
 * });
 *
 * // Query logs
 * const result = await persistence.query(
 *   { level: 'error', from: Date.now() - 3600000 },
 *   { limit: 50, offset: 0 }
 * );
 *
 * // Search logs
 * const searchResults = await persistence.search('authentication failed');
 *
 * // Clean up
 * await persistence.close();
 * ```
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  ILogPersistence,
  LogPersistenceConfig,
  LogRecord,
  LogQuery,
  ISQLDatabase,
} from '@kb-labs/core-platform/adapters';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * SQLite persistence adapter for logs.
 *
 * Design:
 * - Batched writes for performance (default 100 logs per batch)
 * - Auto-flush on interval (default 5 seconds)
 * - FTS5 full-text search on message field
 * - Composite indexes for common query patterns
 * - Shared database for cross-process aggregation
 */
export class LogSQLitePersistence implements ILogPersistence {
  private db: ISQLDatabase;
  private tableName: string;
  private batchSize: number;
  private flushInterval: number;
  private writeQueue: LogRecord[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(config: LogPersistenceConfig) {
    this.db = config.database;
    this.tableName = config.tableName ?? 'logs';
    this.batchSize = config.batchSize ?? 100;
    this.flushInterval = config.flushInterval ?? 5000; // 5 seconds
  }

  /**
   * Initialize database schema and start auto-flush timer.
   * Must be called before using the adapter.
   */
  async initialize(): Promise<void> {
    // Load and execute schema
    const schemaPath = join(__dirname, '../src/schema.sql');
    const schemaSQL = readFileSync(schemaPath, 'utf-8');

    // Execute schema statements
    const statements = schemaSQL
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('--'));

    for (const statement of statements) {
      await this.db.query(statement);
    }

    // Start auto-flush timer
    this.startFlushTimer();
  }

  /**
   * Write log record to persistent storage.
   * Logs are queued and flushed in batches.
   */
  async write(record: LogRecord): Promise<void> {
    this.writeQueue.push(record);

    // Flush if batch is full
    if (this.writeQueue.length >= this.batchSize) {
      await this.flush();
    }
  }

  /**
   * Write multiple log records in batch.
   * More efficient than multiple write() calls.
   */
  async writeBatch(records: LogRecord[]): Promise<void> {
    this.writeQueue.push(...records);

    // Flush if batch is full
    if (this.writeQueue.length >= this.batchSize) {
      await this.flush();
    }
  }

  /**
   * Query logs from persistent storage.
   */
  async query(
    query: LogQuery,
    options: {
      limit?: number;
      offset?: number;
      sortBy?: 'timestamp' | 'level';
      sortOrder?: 'asc' | 'desc';
    } = {}
  ): Promise<{
    logs: LogRecord[];
    total: number;
    hasMore: boolean;
  }> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const sortBy = options.sortBy ?? 'timestamp';
    const sortOrder = options.sortOrder ?? 'desc';

    // Build WHERE clause
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.level) {
      conditions.push('level = ?');
      params.push(query.level);
    }

    if (query.from !== undefined) {
      conditions.push('timestamp >= ?');
      params.push(query.from);
    }

    if (query.to !== undefined) {
      conditions.push('timestamp <= ?');
      params.push(query.to);
    }

    if (query.source) {
      conditions.push('source = ?');
      params.push(query.source);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countQuery = `SELECT COUNT(*) as count FROM ${this.tableName} ${whereClause}`;
    const countResult = await this.db.query<{ count: number }>(countQuery, params);
    const total = countResult.rows[0]?.count ?? 0;

    // Get logs
    const logsQuery = `
      SELECT id, timestamp, level, message, source, fields
      FROM ${this.tableName}
      ${whereClause}
      ORDER BY ${sortBy} ${sortOrder}
      LIMIT ? OFFSET ?
    `;

    const logsResult = await this.db.query<{
      id: string;
      timestamp: number;
      level: string;
      message: string;
      source: string;
      fields: string | null;
    }>(logsQuery, [...params, limit, offset]);

    const logs: LogRecord[] = logsResult.rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      level: row.level as LogRecord['level'],
      message: row.message,
      source: row.source,
      fields: row.fields ? JSON.parse(row.fields) : {},
    }));

    return {
      logs,
      total,
      hasMore: offset + logs.length < total,
    };
  }

  /**
   * Get single log record by ID.
   */
  async getById(id: string): Promise<LogRecord | null> {
    const query = `
      SELECT id, timestamp, level, message, source, fields
      FROM ${this.tableName}
      WHERE id = ?
    `;

    const result = await this.db.query<{
      id: string;
      timestamp: number;
      level: string;
      message: string;
      source: string;
      fields: string | null;
    }>(query, [id]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      timestamp: row.timestamp,
      level: row.level as LogRecord['level'],
      message: row.message,
      source: row.source,
      fields: row.fields ? JSON.parse(row.fields) : {},
    };
  }

  /**
   * Search logs by text query (full-text search).
   */
  async search(
    searchText: string,
    options: {
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{
    logs: LogRecord[];
    total: number;
    hasMore: boolean;
  }> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    // Count total matches
    const countQuery = `
      SELECT COUNT(*) as count
      FROM logs_fts
      WHERE logs_fts MATCH ?
    `;
    const countResult = await this.db.query<{ count: number }>(countQuery, [searchText]);
    const total = countResult.rows[0]?.count ?? 0;

    // Get matching logs
    const searchQuery = `
      SELECT logs.id, logs.timestamp, logs.level, logs.message, logs.source, logs.fields
      FROM logs_fts
      INNER JOIN logs ON logs.rowid = logs_fts.rowid
      WHERE logs_fts MATCH ?
      ORDER BY logs.timestamp DESC
      LIMIT ? OFFSET ?
    `;

    const searchResult = await this.db.query<{
      id: string;
      timestamp: number;
      level: string;
      message: string;
      source: string;
      fields: string | null;
    }>(searchQuery, [searchText, limit, offset]);

    const logs: LogRecord[] = searchResult.rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      level: row.level as LogRecord['level'],
      message: row.message,
      source: row.source,
      fields: row.fields ? JSON.parse(row.fields) : {},
    }));

    return {
      logs,
      total,
      hasMore: offset + logs.length < total,
    };
  }

  /**
   * Delete logs older than specified timestamp.
   */
  async deleteOlderThan(beforeTimestamp: number): Promise<number> {
    const query = `DELETE FROM ${this.tableName} WHERE timestamp < ?`;
    const result = await this.db.query(query, [beforeTimestamp]);
    return result.rowCount ?? 0;
  }

  /**
   * Get statistics about stored logs.
   */
  async getStats(): Promise<{
    totalLogs: number;
    oldestTimestamp: number;
    newestTimestamp: number;
    sizeBytes: number;
  }> {
    const statsQuery = `
      SELECT
        COUNT(*) as total,
        COALESCE(MIN(timestamp), 0) as oldest,
        COALESCE(MAX(timestamp), 0) as newest
      FROM ${this.tableName}
    `;

    const statsResult = await this.db.query<{
      total: number;
      oldest: number;
      newest: number;
    }>(statsQuery);

    const row = statsResult.rows[0];

    // Get database file size (SQLite specific)
    let sizeBytes = 0;
    try {
      const sizeQuery = `SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()`;
      const sizeResult = await this.db.query<{ size: number }>(sizeQuery);
      sizeBytes = sizeResult.rows[0]?.size ?? 0;
    } catch {
      // Ignore if pragma not supported
    }

    return {
      totalLogs: row?.total ?? 0,
      oldestTimestamp: row?.oldest ?? 0,
      newestTimestamp: row?.newest ?? 0,
      sizeBytes,
    };
  }

  /**
   * Close persistence adapter and flush pending writes.
   */
  async close(): Promise<void> {
    // Stop flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Flush remaining logs
    await this.flush();
  }

  /**
   * Flush pending logs to database.
   * @private
   */
  private async flush(): Promise<void> {
    if (this.writeQueue.length === 0 || this.flushing) {
      return;
    }

    this.flushing = true;

    try {
      const batch = this.writeQueue.splice(0, this.writeQueue.length);

      // Insert logs in batch using transaction
      const trx = await this.db.transaction();

      try {
        const insertQuery = `
          INSERT INTO ${this.tableName} (id, timestamp, level, message, source, fields)
          VALUES (?, ?, ?, ?, ?, ?)
        `;

        for (const record of batch) {
          await trx.query(insertQuery, [
            record.id ?? this.generateId(),
            record.timestamp,
            record.level,
            record.message,
            record.source,
            record.fields ? JSON.stringify(record.fields) : null,
          ]);
        }

        await trx.commit();
      } catch (error) {
        await trx.rollback();
        throw error;
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Start auto-flush timer.
   * @private
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush().catch((error) => {
        console.error('[LogSQLitePersistence] Failed to flush log queue:', error);
      });
    }, this.flushInterval);

    // Don't keep process alive for flush timer
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  /**
   * Generate unique log ID.
   * @private
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }
}

/**
 * Factory function for creating SQLite log persistence adapter.
 * This is the function called by platform initialization.
 *
 * @param config - Persistence configuration
 * @returns Initialized persistence adapter
 */
export async function createAdapter(config: LogPersistenceConfig): Promise<LogSQLitePersistence> {
  const adapter = new LogSQLitePersistence(config);
  await adapter.initialize();
  return adapter;
}

// Default export for convenience
export default createAdapter;
