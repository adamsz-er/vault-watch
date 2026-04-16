import { TFile, Vault, EventRef } from 'obsidian';
import type { VaultWatchSettings } from '../types';
import { IgnoreRules } from './ignore-rules';
import { Coalescer } from './coalescer';

export class VaultWatcher {
  private eventRefs: EventRef[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private fileSnapshots = new Map<string, string>();

  constructor(
    private vault: Vault,
    private settings: VaultWatchSettings,
    private ignoreRules: IgnoreRules,
    private coalescer: Coalescer
  ) {}

  start(): void {
    this.eventRefs.push(
      this.vault.on('modify', (file) => {
        if (file instanceof TFile) this.onFileModify(file);
      }),
      this.vault.on('create', (file) => {
        if (file instanceof TFile) this.onFileCreate(file);
      }),
      this.vault.on('delete', (file) => {
        if (file instanceof TFile) this.onFileDelete(file);
      }),
      this.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile) this.onFileRename(file, oldPath);
      })
    );
  }

  stop(): void {
    for (const ref of this.eventRefs) {
      this.vault.offref(ref);
    }
    this.eventRefs = [];

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.coalescer.destroy();
  }

  /** Capture initial snapshot for a file (call on plugin load) */
  async snapshotFile(file: TFile): Promise<void> {
    try {
      const content = await this.vault.cachedRead(file);
      this.fileSnapshots.set(file.path, content);
    } catch {
      // File may have been deleted
    }
  }

  /** Snapshot all existing markdown files */
  async snapshotAll(): Promise<void> {
    const files = this.vault.getMarkdownFiles();
    for (const file of files) {
      if (!this.ignoreRules.shouldIgnore(file.path)) {
        await this.snapshotFile(file);
      }
    }
  }

  getLastKnownContent(filePath: string): string {
    return this.fileSnapshots.get(filePath) ?? '';
  }

  private onFileModify(file: TFile): void {
    if (this.ignoreRules.shouldIgnore(file.path)) return;

    // Layer 1: Per-file debounce
    const existing = this.debounceTimers.get(file.path);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      file.path,
      setTimeout(async () => {
        this.debounceTimers.delete(file.path);
        try {
          const content = await this.vault.cachedRead(file);
          // Pass to Layer 2 (session coalescing)
          this.coalescer.onDebouncedChange(file.path, content, 'file_changed');
          // Update snapshot
          this.fileSnapshots.set(file.path, content);
        } catch {
          // File may have been deleted between debounce and read
        }
      }, this.settings.debounceMs)
    );
  }

  private async onFileCreate(file: TFile): Promise<void> {
    if (this.ignoreRules.shouldIgnore(file.path)) return;

    try {
      const content = await this.vault.cachedRead(file);
      this.fileSnapshots.set(file.path, content);
      // File creates skip debounce -- notify immediately via coalescer
      this.coalescer.onDebouncedChange(file.path, content, 'file_created');
    } catch {
      // Ignore
    }
  }

  private onFileDelete(file: TFile): void {
    if (this.ignoreRules.shouldIgnore(file.path)) return;

    const lastContent = this.fileSnapshots.get(file.path) ?? '';
    this.fileSnapshots.delete(file.path);

    // Cancel any pending debounce
    const timer = this.debounceTimers.get(file.path);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(file.path);
    }

    this.coalescer.onFileDeleted(file.path, lastContent);
  }

  private onFileRename(file: TFile, oldPath: string): void {
    if (this.ignoreRules.shouldIgnore(file.path) || this.ignoreRules.shouldIgnore(oldPath)) return;

    // Move snapshot to new path
    const content = this.fileSnapshots.get(oldPath) ?? '';
    this.fileSnapshots.delete(oldPath);
    this.fileSnapshots.set(file.path, content);

    this.coalescer.onFileRenamed(file.path, oldPath);
  }
}
