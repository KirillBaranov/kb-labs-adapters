/**
 * @module @kb-labs/adapters-pino
 * Pino adapter implementing ILogger interface.
 *
 * @example
 * ```typescript
 * import { createAdapter } from '@kb-labs/adapters-pino';
 *
 * const logger = createAdapter({
 *   level: 'info',
 *   pretty: true,
 * });
 *
 * logger.info('Server started', { port: 3000 });
 * logger.error('Failed to connect', new Error('Connection timeout'));
 *
 * const childLogger = logger.child({ service: 'api' });
 * childLogger.debug('Request received');
 * ```
 */

import pino, { type Logger as PinoLoggerInstance } from 'pino';
import { Writable } from 'node:stream';
import type { ILogger, ILogBuffer, LogLevel, LogRecord } from '@kb-labs/core-platform';
import { LogRingBuffer } from './log-ring-buffer';

/**
 * Configuration for log streaming/buffering
 */
export interface StreamingConfig {
  /** Enable log buffering for streaming (default: false) */
  enabled: boolean;
  /** Maximum buffer size (number of log records, default: 1000) */
  bufferSize?: number;
  /** Maximum age of logs in buffer (milliseconds, default: 3600000 = 1 hour) */
  bufferMaxAge?: number;
}

/**
 * Configuration for Pino logger adapter.
 */
export interface PinoLoggerConfig {
  /** Log level (default: 'info') */
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  /** Enable pretty printing for development (default: false) */
  pretty?: boolean;
  /** Streaming configuration (optional) */
  streaming?: StreamingConfig;
  /** Additional pino options */
  options?: pino.LoggerOptions;
}

/**
 * Pino implementation of ILogger interface.
 */
export class PinoLoggerAdapter implements ILogger {
  private pino: PinoLoggerInstance;
  private logBuffer?: LogRingBuffer;

  constructor(config: PinoLoggerConfig = {}) {
    // Resolve log level with priority: ENV var > config.level > 'info'
    // This allows overriding via KB_LOG_LEVEL or LOG_LEVEL environment variables
    const resolvedLevel =
      process.env.KB_LOG_LEVEL as PinoLoggerConfig['level'] ??
      process.env.LOG_LEVEL as PinoLoggerConfig['level'] ??
      config.level ??
      'info';

    // Initialize log buffer if streaming is enabled
    if (config.streaming?.enabled) {
      this.logBuffer = new LogRingBuffer(
        config.streaming.bufferSize ?? 1000,
        config.streaming.bufferMaxAge ?? 3600000
      );
    }

    const transport = config.pretty
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined;

    // Merge options, but transport from config.options takes precedence
    const finalTransport = config.options?.transport ?? transport;

    // Create multi-stream if buffer is enabled
    if (this.logBuffer) {
      const streams: pino.StreamEntry[] = [
        { level: resolvedLevel, stream: process.stdout },
        { level: resolvedLevel, stream: this.createBufferStream() },
      ];

      this.pino = pino(
        {
          level: resolvedLevel,
          ...config.options,
        },
        pino.multistream(streams)
      );
    } else {
      this.pino = pino({
        level: resolvedLevel,
        ...config.options,
        transport: finalTransport,
      });
    }
  }

  /**
   * Create writable stream that feeds into log buffer
   */
  private createBufferStream(): Writable {
    return new Writable({
      write: (chunk, encoding, callback) => {
        try {
          const logLine = chunk.toString();
          const parsed = JSON.parse(logLine);

          // Convert Pino log to LogRecord
          const record: LogRecord = {
            timestamp: parsed.time ?? Date.now(),
            level: this.mapPinoLevel(parsed.level),
            message: parsed.msg ?? '',
            fields: parsed,
            source: parsed.layer ?? 'unknown',
          };

          this.logBuffer?.append(record);
          callback();
        } catch (error) {
          callback(error as Error);
        }
      },
    });
  }

  /**
   * Map Pino numeric level to LogLevel
   */
  private mapPinoLevel(level: number): LogLevel {
    if (level <= 10) return 'trace';
    if (level <= 20) return 'debug';
    if (level <= 30) return 'info';
    if (level <= 40) return 'warn';
    if (level <= 50) return 'error';
    return 'fatal';
  }

  /**
   * Internal constructor for child loggers.
   */
  private constructor_child(pinoInstance: PinoLoggerInstance) {
    const instance = Object.create(PinoLoggerAdapter.prototype);
    instance.pino = pinoInstance;
    return instance;
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.pino.info(meta ?? {}, message);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.pino.warn(meta ?? {}, message);
  }

  error(message: string, error?: Error, meta?: Record<string, unknown>): void {
    const enrichedMeta = {
      ...meta,
      ...(error && {
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
      }),
    };
    this.pino.error(enrichedMeta, message);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.pino.debug(meta ?? {}, message);
  }

  trace(message: string, meta?: Record<string, unknown>): void {
    this.pino.trace(meta ?? {}, message);
  }

  child(bindings: Record<string, unknown>): ILogger {
    const childPino = this.pino.child(bindings);
    return this.constructor_child(childPino);
  }

  /**
   * Get log buffer for streaming/querying (ILogger optional method)
   */
  getLogBuffer(): ILogBuffer | undefined {
    return this.logBuffer;
  }
}

/**
 * Create Pino logger adapter.
 * This is the factory function called by initPlatform() when loading adapters.
 */
export function createAdapter(config?: PinoLoggerConfig): PinoLoggerAdapter {
  return new PinoLoggerAdapter(config);
}

// Default export for direct import
export default createAdapter;

// Export buffer class
export { LogRingBuffer } from './log-ring-buffer';
