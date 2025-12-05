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
import type { ILogger } from '@kb-labs/core-platform';

/**
 * Configuration for Pino logger adapter.
 */
export interface PinoLoggerConfig {
  /** Log level (default: 'info') */
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  /** Enable pretty printing for development (default: false) */
  pretty?: boolean;
  /** Additional pino options */
  options?: pino.LoggerOptions;
}

/**
 * Pino implementation of ILogger interface.
 */
export class PinoLoggerAdapter implements ILogger {
  private pino: PinoLoggerInstance;

  constructor(config: PinoLoggerConfig = {}) {
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

    this.pino = pino({
      level: config.level ?? 'info',
      transport,
      ...config.options,
    });
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

  child(bindings: Record<string, unknown>): ILogger {
    const childPino = this.pino.child(bindings);
    return this.constructor_child(childPino);
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
