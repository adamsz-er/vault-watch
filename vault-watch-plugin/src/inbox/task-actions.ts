import { App, TFile, TFolder, Notice } from 'obsidian';
import type { InboxTask, InboxTaskLane, Member, VaultWatchSettings } from '../types';
import type { TaskScanner } from './task-scanner';

/**
 * CRDT-safe task mutations. All moves go through app.vault.rename so Relay
 * can replicate them correctly (raw fs writes would break sync).
 */
export class TaskActions {
  constructor(
    private app: App,
    private settings: VaultWatchSettings,
    private scanner: TaskScanner,
    private getMembers: () => Member[]
  ) {}

  /** Open the task's file in the workspace. */
  async open(task: InboxTask): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.path);
    if (!file) {
      new Notice(`File not found: ${task.path}`);
      return;
    }
    await this.app.workspace.openLinkText(task.path, '', false);
  }

  /** Move the task to the lane at `statusRank + 1` within its root+personFolder. */
  async advance(task: InboxTask): Promise<void> {
    if (!task.lane) {
      new Notice('No lane detected on this task');
      return;
    }
    const allLanes = this.scanner.getLanes();
    const next = allLanes.find(l => l.rank > task.lane!.rank);
    if (!next) {
      new Notice('Already at the last lane');
      return;
    }
    await this.moveToLane(task, next);
  }

  /** Move the task to a specific lane (by name). */
  async moveToLane(task: InboxTask, lane: InboxTaskLane): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.path);
    if (!(file instanceof TFile)) {
      new Notice('File not found');
      return;
    }
    const newFolder = this.scanner.buildLanePath(task.root, task.personFolder, lane.name);
    await this.ensureFolder(newFolder);
    const newPath = `${newFolder}/${file.name}`;
    if (newPath === task.path) return;
    try {
      await this.app.fileManager.renameFile(file, newPath);
      new Notice(`Moved to ${lane.name}`);
    } catch (err) {
      console.error('[vault-watch] Advance failed:', err);
      new Notice(`Move failed: ${(err as Error).message}`);
    }
  }

  /** Reassign a task to a different member folder under the same root/lane. */
  async reassign(task: InboxTask, memberId: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.path);
    if (!(file instanceof TFile)) return;

    const member = this.getMembers().find(m => m.id === memberId);
    if (!member) {
      new Notice(`Unknown member: ${memberId}`);
      return;
    }

    const mapped = this.settings.inboxTasks.personFolderMap[memberId];
    const folderName = mapped || member.displayName;
    const laneSegment = task.lane?.name;
    const parts = [task.root, folderName];
    if (laneSegment) parts.push(laneSegment);
    const newFolder = parts.join('/');
    await this.ensureFolder(newFolder);
    const newPath = `${newFolder}/${file.name}`;
    if (newPath === task.path) return;
    try {
      await this.app.fileManager.renameFile(file, newPath);
      new Notice(`Reassigned to ${member.displayName}`);
    } catch (err) {
      console.error('[vault-watch] Reassign failed:', err);
      new Notice(`Reassign failed: ${(err as Error).message}`);
    }
  }

  /** Hide from the Tasks view until the task moves or edits (plugin-local). */
  async dismiss(task: InboxTask, save: () => Promise<void>): Promise<void> {
    const list = this.settings.inboxTasks.dismissedPaths;
    if (!list.includes(task.path)) {
      list.push(task.path);
      await save();
    }
  }

  async undismiss(task: InboxTask, save: () => Promise<void>): Promise<void> {
    const before = this.settings.inboxTasks.dismissedPaths.length;
    this.settings.inboxTasks.dismissedPaths =
      this.settings.inboxTasks.dismissedPaths.filter(p => p !== task.path);
    if (this.settings.inboxTasks.dismissedPaths.length !== before) await save();
  }

  // ─── Helpers ───

  private async ensureFolder(path: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) return;
    try {
      await this.app.vault.createFolder(path);
    } catch (err) {
      // Race: another event may have just created it. Treat "already exists" as success.
      const existing2 = this.app.vault.getAbstractFileByPath(path);
      if (!(existing2 instanceof TFolder)) throw err;
    }
  }
}
