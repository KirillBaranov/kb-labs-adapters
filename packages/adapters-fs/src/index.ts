/**
 * @module @kb-labs/adapters-fs
 * Filesystem adapter implementing IStorage interface.
 *
 * @example
 * ```typescript
 * import { createAdapter } from '@kb-labs/adapters-fs';
 *
 * const storage = createAdapter({
 *   baseDir: '/var/data',
 * });
 *
 * await storage.write('docs/readme.md', Buffer.from('# Hello'));
 * const content = await storage.read('docs/readme.md');
 * const files = await storage.list('docs/');
 * await storage.delete('docs/readme.md');
 * ```
 */

import fs from 'fs-extra';
import path from 'node:path';
import fg from 'fast-glob';
import type { IStorage } from '@kb-labs/core-platform';

/**
 * Configuration for filesystem storage adapter.
 */
export interface FilesystemStorageConfig {
  /** Base directory for all file operations (default: process.cwd()) */
  baseDir?: string;
}

/**
 * Filesystem implementation of IStorage interface.
 */
export class FilesystemStorageAdapter implements IStorage {
  private baseDir: string;

  constructor(config: FilesystemStorageConfig = {}) {
    this.baseDir = config.baseDir ?? process.cwd();
  }

  /**
   * Resolve relative path to absolute path within baseDir.
   */
  private resolvePath(relativePath: string): string {
    // Normalize path and ensure it's within baseDir (security)
    const normalized = path.normalize(relativePath);
    const absolute = path.isAbsolute(normalized)
      ? normalized
      : path.join(this.baseDir, normalized);

    // Ensure path is within baseDir (prevent directory traversal)
    if (!absolute.startsWith(this.baseDir)) {
      throw new Error(`Path traversal detected: ${relativePath}`);
    }

    return absolute;
  }

  async read(filepath: string): Promise<Buffer | null> {
    const absolutePath = this.resolvePath(filepath);

    try {
      return await fs.readFile(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async write(filepath: string, data: Buffer): Promise<void> {
    const absolutePath = this.resolvePath(filepath);

    // Ensure directory exists
    await fs.ensureDir(path.dirname(absolutePath));

    await fs.writeFile(absolutePath, data);
  }

  async delete(filepath: string): Promise<void> {
    const absolutePath = this.resolvePath(filepath);

    try {
      await fs.unlink(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist - that's okay
        return;
      }
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const absolutePrefix = this.resolvePath(prefix);

    // Use fast-glob for efficient file listing
    const pattern = path.join(absolutePrefix, '**/*');
    const files = await fg(pattern, {
      onlyFiles: true,
      absolute: false,
      cwd: this.baseDir,
    });

    return files;
  }

  async exists(filepath: string): Promise<boolean> {
    const absolutePath = this.resolvePath(filepath);

    try {
      await fs.access(absolutePath);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Create filesystem storage adapter.
 * This is the factory function called by initPlatform() when loading adapters.
 */
export function createAdapter(config?: FilesystemStorageConfig): FilesystemStorageAdapter {
  return new FilesystemStorageAdapter(config);
}

// Default export for direct import
export default createAdapter;
