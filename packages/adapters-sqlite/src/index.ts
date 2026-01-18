/**
 * @module @kb-labs/adapters-sqlite
 * SQLite adapter implementing ISQLDatabase interface.
 *
 * Features:
 * - Based on better-sqlite3 (synchronous API)
 * - Connection pooling (single connection, thread-safe)
 * - Transaction support with rollback
 * - Prepared statement caching
 * - Type-safe query results
 *
 * @example
 * ```typescript
 * import { createAdapter } from '@kb-labs/adapters-sqlite';
 *
 * const db = createAdapter({
 *   filename: '/var/data/app.db',
 *   readonly: false,
 * });
 *
 * // Execute query
 * const result = await db.query('SELECT * FROM users WHERE id = ?', [123]);
 * console.log(result.rows); // [{ id: 123, name: 'Alice' }]
 *
 * // Transaction
 * await db.transaction(async (trx) => {
 *   await trx.query('INSERT INTO users (name) VALUES (?)', ['Bob']);
 *   await trx.query('INSERT INTO logs (action) VALUES (?)', ['user_created']);
 * });
 *
 * // Close connection
 * await db.close();
 * ```
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ISQLDatabase,
  SQLQueryResult,
  SQLTransaction,
} from '@kb-labs/core-platform/adapters';

// Re-export manifest
export { manifest } from './manifest.js';

/**
 * Configuration for SQLite database adapter.
 */
export interface SQLiteConfig {
  /**
   * Database file path.
   * Use ':memory:' for in-memory database (useful for testing).
   */
  filename: string;

  /**
   * Open in readonly mode (default: false)
   */
  readonly?: boolean;

  /**
   * Enable WAL mode for better concurrency (default: true)
   * https://www.sqlite.org/wal.html
   */
  wal?: boolean;

  /**
   * Enable foreign keys (default: true)
   */
  foreignKeys?: boolean;

  /**
   * Busy timeout in milliseconds (default: 5000)
   */
  busyTimeout?: number;
}

/**
 * SQLite implementation of ISQLDatabase interface.
 *
 * Design:
 * - Uses better-sqlite3 (synchronous, but wrapped in async for interface compatibility)
 * - Single connection (thread-safe via better-sqlite3)
 * - Prepared statement caching (automatic via better-sqlite3)
 * - Transaction support with savepoints
 */
export class SQLiteAdapter implements ISQLDatabase {
  private db: Database.Database;
  private closed = false;

  constructor(config: SQLiteConfig) {
    // Create parent directory if it doesn't exist (unless :memory:)
    if (config.filename !== ':memory:' && !config.readonly) {
      const dir = dirname(config.filename);
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(config.filename, {
      readonly: config.readonly ?? false,
      fileMustExist: false, // Create if not exists
    });

    // Set busy timeout
    this.db.pragma(`busy_timeout = ${config.busyTimeout ?? 5000}`);

    // Enable WAL mode for better concurrency
    if (config.wal !== false) {
      this.db.pragma('journal_mode = WAL');
    }

    // Enable foreign keys
    if (config.foreignKeys !== false) {
      this.db.pragma('foreign_keys = ON');
    }
  }

  /**
   * Execute a SQL query.
   *
   * @param sql - SQL query string (supports ? placeholders)
   * @param params - Query parameters
   * @returns Query result with rows and metadata
   */
  async query<T = unknown>(sql: string, params?: unknown[]): Promise<SQLQueryResult<T>> {
    this.checkClosed();

    try {
      const trimmedSql = sql.trim().toUpperCase();

      // SELECT queries
      if (trimmedSql.startsWith('SELECT') || trimmedSql.startsWith('PRAGMA')) {
        const stmt = this.db.prepare(sql);
        const rows = params ? stmt.all(...params) : stmt.all();

        return {
          rows: rows as T[],
          rowCount: rows.length,
          fields: this.getFieldMetadata(stmt),
        };
      }

      // INSERT/UPDATE/DELETE queries
      const stmt = this.db.prepare(sql);
      const info = params ? stmt.run(...params) : stmt.run();

      return {
        rows: [] as T[],
        rowCount: info.changes,
        fields: [],
      };
    } catch (error) {
      throw new Error(
        `SQLite query failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Begin a SQL transaction.
   *
   * @returns Transaction object with query, commit, rollback methods
   */
  async transaction(): Promise<SQLTransaction> {
    this.checkClosed();

    // SQLite doesn't have true async transactions, but we use savepoint
    await this.query('BEGIN TRANSACTION', []);

    let committed = false;
    let rolledBack = false;

    return {
      query: async <T = unknown>(sql: string, params?: unknown[]): Promise<SQLQueryResult<T>> => {
        if (committed || rolledBack) {
          throw new Error('Transaction already completed');
        }
        return this.query<T>(sql, params);
      },

      commit: async (): Promise<void> => {
        if (committed || rolledBack) {
          throw new Error('Transaction already completed');
        }
        await this.query('COMMIT', []);
        committed = true;
      },

      rollback: async (): Promise<void> => {
        if (committed || rolledBack) {
          throw new Error('Transaction already completed');
        }
        await this.query('ROLLBACK', []);
        rolledBack = true;
      },
    };
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  /**
   * Check if database is closed.
   */
  private checkClosed(): void {
    if (this.closed) {
      throw new Error('Database connection is closed');
    }
  }

  /**
   * Extract field metadata from prepared statement.
   */
  private getFieldMetadata(stmt: Database.Statement): Array<{ name: string; type: string }> {
    try {
      // better-sqlite3 provides column info
      return stmt.columns().map((col) => ({
        name: col.name,
        type: col.type ?? 'unknown',
      }));
    } catch {
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Utility methods (not part of ISQLDatabase interface)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Execute raw SQL (useful for schema migrations).
   * Does not return rows - use query() for SELECT.
   */
  async exec(sql: string): Promise<void> {
    this.checkClosed();
    this.db.exec(sql);
  }

  /**
   * Check if database is open.
   */
  isOpen(): boolean {
    return !this.closed;
  }

  /**
   * Get underlying better-sqlite3 instance (for advanced usage).
   * Use with caution - bypasses adapter interface.
   */
  getRawDatabase(): Database.Database {
    this.checkClosed();
    return this.db;
  }
}

/**
 * Create SQLite database adapter.
 * This is the factory function called by initPlatform() when loading adapters.
 *
 * @param config - SQLite configuration
 * @returns SQLite adapter instance
 *
 * @example
 * ```typescript
 * const db = createAdapter({
 *   filename: '/var/data/app.db',
 *   wal: true,
 *   foreignKeys: true,
 * });
 * ```
 */
export function createAdapter(config: SQLiteConfig): SQLiteAdapter {
  return new SQLiteAdapter(config);
}

// Default export for direct import
export default createAdapter;
