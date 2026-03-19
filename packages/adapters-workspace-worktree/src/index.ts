import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  IWorkspaceProvider,
  MaterializeWorkspaceRequest,
  WorkspaceDescriptor,
  AttachWorkspaceRequest,
  WorkspaceAttachment,
  WorkspaceStatusResult,
  WorkspaceProviderCapabilities,
  WorkspaceStatus,
} from '@kb-labs/core-platform';

export { manifest } from './manifest.js';

interface WorkspaceContext {
  cwd?: string;
}

export interface WorktreeWorkspaceAdapterConfig {
  worktreeDir?: string;
  branch?: string;
  initSubmodules?: boolean;
  workspace?: WorkspaceContext;
}

interface WorktreeRecord {
  workspaceId: string;
  worktreePath: string;
  branch: string;
  status: WorkspaceStatus;
  createdAt: string;
  runId?: string;
}

export class WorktreeWorkspaceAdapter implements IWorkspaceProvider {
  private readonly repoRoot: string;
  private readonly worktreeBaseDir: string;
  private readonly defaultBranch: string;
  private readonly initSubmodules: boolean;
  private readonly records = new Map<string, WorktreeRecord>();

  constructor(config: WorktreeWorkspaceAdapterConfig = {}) {
    this.repoRoot = path.resolve(config.workspace?.cwd ?? process.cwd());
    this.worktreeBaseDir = path.resolve(this.repoRoot, config.worktreeDir ?? '.worktrees');
    this.defaultBranch = config.branch ?? 'main';
    this.initSubmodules = config.initSubmodules ?? true;
  }

  async materialize(request: MaterializeWorkspaceRequest): Promise<WorkspaceDescriptor> {
    const workspaceId = request.workspaceId ?? `wt_${randomUUID().slice(0, 8)}`;
    const branch = request.sourceRef ?? this.defaultBranch;
    const runId = (request.metadata as Record<string, unknown>)?.runId as string | undefined;

    // Create worktree directory
    if (!existsSync(this.worktreeBaseDir)) {
      mkdirSync(this.worktreeBaseDir, { recursive: true });
    }

    const worktreePath = path.join(this.worktreeBaseDir, workspaceId);

    // Sanitize branch name — only allow safe git ref characters
    const safeBranch = branch.replace(/[^a-zA-Z0-9_\-./]/g, '');
    if (!safeBranch || safeBranch !== branch) {
      throw new Error(`Invalid branch name: ${branch}`);
    }

    try {
      // Pull latest on source branch first
      this.exec(`git fetch origin ${safeBranch} --quiet`, this.repoRoot);

      // Create worktree from detached HEAD at branch tip
      // --detach avoids "branch already checked out" error
      this.exec(`git worktree add --detach "${worktreePath}" origin/${safeBranch}`, this.repoRoot);

      // Initialize submodules if enabled
      if (this.initSubmodules) {
        this.exec('git submodule update --init --recursive', worktreePath);
      }

      const record: WorktreeRecord = {
        workspaceId,
        worktreePath,
        branch,
        status: 'ready',
        createdAt: new Date().toISOString(),
        runId,
      };
      this.records.set(workspaceId, record);

      return {
        workspaceId,
        provider: 'worktree',
        status: 'ready',
        rootPath: worktreePath,
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
        metadata: { branch, runId, repoRoot: this.repoRoot },
      };
    } catch (error) {
      // Cleanup on failure
      try {
        this.exec(`git worktree remove "${worktreePath}" --force`, this.repoRoot);
      } catch { /* ignore cleanup errors */ }

      throw new Error(
        `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async attach(_request: AttachWorkspaceRequest): Promise<WorkspaceAttachment> {
    return {
      workspaceId: _request.workspaceId,
      environmentId: _request.environmentId,
      mountPath: this.records.get(_request.workspaceId)?.worktreePath,
      attachedAt: new Date().toISOString(),
    };
  }

  async release(workspaceId: string): Promise<void> {
    const record = this.records.get(workspaceId);
    if (!record) {
      return;
    }

    try {
      // Remove worktree
      this.exec(`git worktree remove "${record.worktreePath}" --force`, this.repoRoot);
    } catch {
      // Force cleanup if git worktree remove fails
      if (existsSync(record.worktreePath)) {
        rmSync(record.worktreePath, { recursive: true, force: true });
      }
      // Prune stale worktree references
      try {
        this.exec('git worktree prune', this.repoRoot);
      } catch { /* ignore */ }
    }

    record.status = 'released';
    this.records.delete(workspaceId);
  }

  async getStatus(workspaceId: string): Promise<WorkspaceStatusResult> {
    const record = this.records.get(workspaceId);
    if (!record) {
      return { workspaceId, status: 'released', updatedAt: new Date().toISOString() };
    }

    const exists = existsSync(record.worktreePath);
    return {
      workspaceId,
      status: exists ? record.status : 'failed',
      updatedAt: record.createdAt,
    };
  }

  getCapabilities(): WorkspaceProviderCapabilities {
    return {
      supportsAttach: true,
      supportsRelease: true,
    };
  }

  private exec(command: string, cwd: string): string {
    return execSync(command, {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
}

/**
 * Adapter factory — called by platform adapter loader.
 */
export function createAdapter(config: WorktreeWorkspaceAdapterConfig = {}): WorktreeWorkspaceAdapter {
  return new WorktreeWorkspaceAdapter(config);
}
