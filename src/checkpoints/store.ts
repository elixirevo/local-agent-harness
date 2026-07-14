import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;

export interface Checkpoint {
  sha: string;
  label: string;
  /** Unix millis. */
  when: number;
}

/**
 * File-state checkpoints in a shadow git repository (.harness/checkpoints).
 * The project's own git repo is never touched: the shadow repo has its own
 * git-dir and treats the project root as its work tree. A snapshot is taken
 * before every mutating tool call, so /rewind can restore the tree to the
 * state before any mutation — and restoring snapshots first, so a rewind is
 * itself rewindable.
 */
export class CheckpointStore {
  private readonly gitDir: string;
  private initialized = false;

  constructor(private readonly cwd: string) {
    this.gitDir = path.join(cwd, '.harness', 'checkpoints');
  }

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await exec('git', ['--git-dir', this.gitDir, '--work-tree', this.cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    if (!fs.existsSync(path.join(this.gitDir, 'HEAD'))) {
      fs.mkdirSync(this.gitDir, { recursive: true });
      await this.git('init', '--quiet');
      await this.git('config', 'user.email', 'checkpoints@harness.local');
      await this.git('config', 'user.name', 'harness-checkpoints');
      await this.git('config', 'commit.gpgsign', 'false');
      // Never snapshot harness state or dependency trees; the project's own
      // .gitignore is honored on top of this (shadow repo reads the work tree).
      fs.writeFileSync(path.join(this.gitDir, 'info', 'exclude'), '.harness/\nnode_modules/\n.git/\n');
    }
    this.initialized = true;
  }

  /** Snapshot the working tree; false when nothing changed since the last one. */
  async snapshot(label: string): Promise<boolean> {
    await this.ensureInit();
    await this.git('add', '-A');
    const status = await this.git('status', '--porcelain');
    if (!status) return false;
    await this.git('commit', '--quiet', '--no-verify', '-m', label || 'checkpoint');
    return true;
  }

  /** Checkpoints, newest first. Empty when none were taken yet. */
  async list(limit = 20): Promise<Checkpoint[]> {
    await this.ensureInit();
    try {
      const out = await this.git('log', `-${limit}`, '--format=%h%x09%ct%x09%s');
      return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, ct, ...rest] = line.split('\t');
          return { sha, when: Number(ct) * 1000, label: rest.join('\t') };
        });
    } catch {
      return []; // no commits yet
    }
  }

  /**
   * Restore the work tree to a checkpoint. The current state is snapshotted
   * first ("before /rewind"), then plumbing does an exact rollback: index :=
   * snapshot, files written from the index, files that did not exist at the
   * snapshot removed (excluded/ignored paths are untouched by clean).
   */
  async restore(sha: string): Promise<void> {
    await this.ensureInit();
    await this.snapshot('before /rewind');
    await this.git('read-tree', sha);
    await this.git('checkout-index', '-f', '-a');
    await this.git('clean', '-fd');
  }
}
