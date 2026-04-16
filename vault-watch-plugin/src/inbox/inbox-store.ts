import { Vault, TFile, TFolder, Notice } from 'obsidian';
import type {
  InboxItem,
  InboxItemStatus,
  InboxFilter,
  ActivitySubFilter,
  NotificationEvent,
  VaultWatchSettings,
} from '../types';
import { INBOX_DIR } from '../types';
import type { NotificationSound } from '../notifications/sound';
import { getEventVerb } from '../utils/event-verbs';
import { matchesGlob } from '../utils/glob-matcher';

export class InboxStore {
  private items: InboxItem[] = [];
  private onChangeCallbacks: (() => void)[] = [];
  private sound: NotificationSound | null = null;

  constructor(
    private vault: Vault,
    private settings: VaultWatchSettings
  ) {}

  setSound(sound: NotificationSound): void {
    this.sound = sound;
  }

  private matchesActivitySub(event: NotificationEvent, sub: ActivitySubFilter): boolean {
    if (sub === 'all') return true;
    if (sub === 'to-me') {
      return event.type === 'share' || event.type === 'mention' ||
             event.type === 'reaction' || event.type === 'task_assigned' ||
             event.mentionedMembers.includes(this.settings.memberId);
    }
    if (sub === 'additions') return event.type === 'file_created';
    if (sub === 'edits') return event.type === 'file_changed';
    if (sub === 'deletions') return event.type === 'file_deleted' || event.type === 'file_renamed';
    return true;
  }

  private isHiddenByRouting(event: NotificationEvent): boolean {
    const r = this.settings.inboxRouting;
    if (r.mutedTypes.includes(event.type)) return true;
    if (r.activityIgnoreTrivial) {
      const ct = event.change?.changeType;
      if (ct === 'trivial' || ct === 'sync_artifact') return true;
    }
    const delta = Math.abs(event.change?.charDelta ?? 0);
    const isEdit = event.type === 'file_changed';
    if (isEdit && delta > 0 && delta < r.activityMinCharDelta) return true;
    if (r.activityIgnorePaths.length > 0) {
      const p = event.filePath;
      for (const pattern of r.activityIgnorePaths) {
        if (matchesGlob(p, pattern)) return true;
      }
    }
    return false;
  }

  getItems(_filter: InboxFilter = 'activity', activitySub: ActivitySubFilter = 'all'): InboxItem[] {
    const now = Date.now();
    const visible = this.items.filter(i => {
      if (i.status === 'archived') return false;
      if (i.snoozedUntil && i.snoozedUntil > now) return false;
      if (this.isHiddenByRouting(i.event)) return false;
      if (!this.matchesActivitySub(i.event, activitySub)) return false;
      return true;
    });
    return visible.sort((a, b) => b.receivedAt - a.receivedAt);
  }

  getActivityUnreadCount(): number {
    const now = Date.now();
    let count = 0;
    for (const i of this.items) {
      if (i.status !== 'unread') continue;
      if (i.snoozedUntil && i.snoozedUntil > now) continue;
      if (this.isHiddenByRouting(i.event)) continue;
      count++;
    }
    return count;
  }

  getUnreadCount(): number {
    return this.getActivityUnreadCount();
  }

  hasRecentActivityForPath(path: string, withinMs: number): boolean {
    const cutoff = Date.now() - withinMs;
    return this.items.some(i =>
      i.event.filePath === path && i.receivedAt >= cutoff && i.status !== 'archived'
    );
  }

  getItem(id: string): InboxItem | undefined {
    return this.items.find(i => i.id === id);
  }

  async addItem(event: NotificationEvent): Promise<void> {
    if (this.items.some(i => i.id === event.id)) return;

    // Handle reaction events — attach to existing item
    if (event.type === 'reaction' && event.change.addedExcerpt) {
      const targetId = event.change.addedExcerpt; // We store target event ID here
      const target = this.items.find(i => i.id === targetId);
      if (target) {
        if (!target.reactions) target.reactions = [];
        target.reactions.push({
          emoji: event.change.summary,
          from: event.sender.name,
          ts: event.ts,
        });
        await this.persistItem(target);
        if (!this.settings.doNotDisturb) {
          new Notice(`${event.sender.name} reacted ${event.change.summary} to "${target.event.fileTitle}"`);
          this.sound?.play('normal');
        }
        this.notifyChange();
        return;
      }
    }

    const item: InboxItem = {
      id: event.id,
      event,
      status: 'unread',
      receivedAt: Date.now(),
    };

    this.items.push(item);
    await this.persistItem(item);

    if (!this.settings.doNotDisturb) {
      this.showToast(event);
      this.sound?.play(event.priority);
    }

    this.notifyChange();
  }

  async markRead(id: string): Promise<void> {
    const item = this.items.find(i => i.id === id);
    if (item && item.status === 'unread') {
      item.status = 'read';
      item.readAt = Date.now();
      await this.persistItem(item);
      this.notifyChange();
    }
  }

  async markAllRead(): Promise<void> {
    let changed = false;
    for (const item of this.items) {
      if (item.status === 'unread') {
        item.status = 'read';
        item.readAt = Date.now();
        await this.persistItem(item);
        changed = true;
      }
    }
    if (changed) this.notifyChange();
  }

  async archive(id: string): Promise<void> {
    const item = this.items.find(i => i.id === id);
    if (item) {
      item.status = 'archived';
      await this.persistItem(item);
      this.notifyChange();
    }
  }

  async star(id: string): Promise<void> {
    const item = this.items.find(i => i.id === id);
    if (item) {
      item.status = item.status === 'starred' ? 'read' : 'starred';
      await this.persistItem(item);
      this.notifyChange();
    }
  }

  async snooze(id: string, durationMs: number): Promise<void> {
    const item = this.items.find(i => i.id === id);
    if (item) {
      item.snoozedUntil = Date.now() + durationMs;
      item.status = 'read';
      await this.persistItem(item);
      this.notifyChange();
    }
  }

  onChange(callback: () => void): void {
    this.onChangeCallbacks.push(callback);
  }

  offChange(callback: () => void): void {
    this.onChangeCallbacks = this.onChangeCallbacks.filter(cb => cb !== callback);
  }

  async loadFromDisk(): Promise<void> {
    const inboxPath = `${INBOX_DIR}/${this.settings.memberId}`;
    const folder = this.vault.getAbstractFileByPath(inboxPath);
    if (!(folder instanceof TFolder)) return;

    this.items = [];
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === 'json') {
        try {
          const content = await this.vault.read(child);
          const item = JSON.parse(content) as InboxItem;
          this.items.push(item);
        } catch {
          // Skip corrupted files
        }
      }
    }

    this.notifyChange();
  }

  private async persistItem(item: InboxItem): Promise<void> {
    const path = `${INBOX_DIR}/${this.settings.memberId}/${item.id}.json`;
    const content = JSON.stringify(item, null, 2);

    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.vault.modify(file, content);
    } else {
      await this.vault.create(path, content);
    }
  }

  private showToast(event: NotificationEvent): void {
    const msg = `${event.sender.name} ${getEventVerb(event.type)} "${event.fileTitle}"`;
    const detail = event.change.summary;
    const duration = event.priority === 'high' ? 8000 : 5000;

    new Notice(`${msg}\n${detail}`, duration);
  }

  private notifyChange(): void {
    for (const cb of this.onChangeCallbacks) {
      cb();
    }
  }
}
