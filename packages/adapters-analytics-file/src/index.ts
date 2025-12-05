import fs from 'fs-extra';
import { join } from 'node:path';
import { format } from 'date-fns';
import type { IAnalytics } from '@kb-labs/core-platform';

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

interface AnalyticsEvent {
  type: 'event' | 'metric';
  timestamp: string;
  name: string;
  properties?: Record<string, unknown>;
  value?: number;
}

class FileAnalytics implements IAnalytics {
  private readonly baseDir: string;
  private readonly filenamePattern: string;

  constructor(options: FileAnalyticsOptions = {}) {
    this.baseDir = options.baseDir ?? join(process.cwd(), '.kb/analytics/buffer');
    this.filenamePattern = options.filenamePattern ?? 'events-YYYYMMDD';
  }

  async track(event: string, properties?: Record<string, unknown>): Promise<void> {
    const payload: AnalyticsEvent = {
      type: 'event',
      timestamp: new Date().toISOString(),
      name: event,
      properties,
    };
    await this.write(payload);
  }

  async metric(name: string, value: number, tags?: Record<string, string>): Promise<void> {
    const payload: AnalyticsEvent = {
      type: 'metric',
      timestamp: new Date().toISOString(),
      name,
      value,
      properties: tags,
    };
    await this.write(payload);
  }

  async identify(userId: string, traits?: Record<string, unknown>): Promise<void> {
    const payload: AnalyticsEvent = {
      type: 'event',
      timestamp: new Date().toISOString(),
      name: 'identify',
      properties: { userId, ...traits },
    };
    await this.write(payload);
  }

  async flush(): Promise<void> {
    // No buffering, so nothing to flush
  }

  private async write(payload: AnalyticsEvent): Promise<void> {
    const dateStr = format(new Date(), 'yyyyMMdd');
    const filename = this.filenamePattern.replace('YYYYMMDD', dateStr) + '.jsonl';
    const fullPath = join(this.baseDir, filename);
    await fs.ensureDir(this.baseDir);
    await fs.appendFile(fullPath, JSON.stringify(payload) + '\n', { encoding: 'utf8' });
  }
}

export function createAdapter(options?: FileAnalyticsOptions): IAnalytics {
  return new FileAnalytics(options);
}

export default createAdapter;

