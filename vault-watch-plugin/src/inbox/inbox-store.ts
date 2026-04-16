import { Vault, TFile, TFolder } from 'obsidian';
import type {
  InboxItem,
  InboxItemStatus,
  InboxFilter,
  NotificationEvent,
  VaultWatchSettings,
} from '../types';
import { INBOX_DIR } from '../types';

export class InboxStore {
  private items: InboxItem[] = [];
  private onChangeCallbacks: (() => void)[] = [];

  constructor(
    private vault: Vault,
    private settings: VaultWatchSettings
  ) {}

  getItems(filter: InboxFilter = 'all'): InboxItem[] {
    let filtered = this.items;

    switch (filter) {
      case 'mentions':
        filtered = this.items.filter(
          i => i.event.type === 'mention' || i.event.mentionedMembers.includes(this.settings.memberId)
        );
        break;
      case 'changes':
        filtered = this.items.filter(
          i => i.event.type === 'file_changed' || i.event.type === 'file_created'
        );
        break;
    }

    // Sort by receivedAt descending (newest first)
    return filtered
      .filter(i => i.status !== 'archived')
      .sort((a, b) => b.receivedAt - a.receivedAt);
  }

  getUnreadCount(): number {
    return this.items.filter(i => i.status === 'unread').length;
  }

  async addItem(event: NotificationEvent): Promise<void> {
    // Dedup by event ID
    if (this.items.some(i => i.id === event.id)) return;

    const item: InboxItem = {
      id: event.id,
      event,
      status: 'unread',
      receivedAt: Date.now(),
    };

    this.items.push(item);
    await this.persistItem(item);
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

  private notifyChange(): void {
    for (const cb of this.onChangeCallbacks) {
      cb();
    }
  }
}
