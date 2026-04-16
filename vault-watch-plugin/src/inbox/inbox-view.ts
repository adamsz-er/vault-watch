import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { InboxItem, InboxFilter } from '../types';
import { INBOX_VIEW_TYPE } from '../types';
import type { InboxStore } from './inbox-store';
import { InboxActions } from './actions';

export class InboxView extends ItemView {
  private currentFilter: InboxFilter = 'all';
  private changeHandler: () => void;

  constructor(
    leaf: WorkspaceLeaf,
    private inboxStore: InboxStore,
    private inboxActions: InboxActions
  ) {
    super(leaf);
    this.changeHandler = () => this.render();
  }

  getViewType(): string {
    return INBOX_VIEW_TYPE;
  }

  getDisplayText(): string {
    const count = this.inboxStore.getUnreadCount();
    return count > 0 ? `Vault Watch [${count}]` : 'Vault Watch';
  }

  getIcon(): string {
    return 'bell';
  }

  async onOpen(): Promise<void> {
    this.inboxStore.onChange(this.changeHandler);
    this.render();
  }

  async onClose(): Promise<void> {
    this.inboxStore.offChange(this.changeHandler);
  }

  private render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('vault-watch-inbox');

    // Header
    const header = container.createDiv({ cls: 'vault-watch-header' });
    header.createEl('h3', { text: 'Vault Watch' });
    const badge = this.inboxStore.getUnreadCount();
    if (badge > 0) {
      header.createEl('span', { text: `${badge}`, cls: 'vault-watch-badge' });
    }

    // Filter tabs
    const tabs = container.createDiv({ cls: 'vault-watch-tabs' });
    for (const filter of ['all', 'mentions', 'changes'] as InboxFilter[]) {
      const tab = tabs.createEl('button', {
        text: filter.charAt(0).toUpperCase() + filter.slice(1),
        cls: `vault-watch-tab ${this.currentFilter === filter ? 'active' : ''}`,
      });
      tab.addEventListener('click', () => {
        this.currentFilter = filter;
        this.render();
      });
    }

    // Items
    const items = this.inboxStore.getItems(this.currentFilter);
    const list = container.createDiv({ cls: 'vault-watch-list' });

    if (items.length === 0) {
      list.createEl('p', {
        text: 'No notifications yet',
        cls: 'vault-watch-empty',
      });
    } else {
      for (const item of items) {
        this.renderCard(list, item);
      }
    }

    // Footer
    if (items.some(i => i.status === 'unread')) {
      const footer = container.createDiv({ cls: 'vault-watch-footer' });
      const markAllBtn = footer.createEl('button', {
        text: 'Mark All Read',
        cls: 'vault-watch-mark-all',
      });
      markAllBtn.addEventListener('click', () => {
        this.inboxStore.markAllRead();
      });
    }
  }

  private renderCard(parent: HTMLElement, item: InboxItem): void {
    const card = parent.createDiv({
      cls: `vault-watch-card ${item.status === 'unread' ? 'unread' : ''}`,
    });

    // Header line: sender + time
    const cardHeader = card.createDiv({ cls: 'vault-watch-card-header' });
    cardHeader.createEl('strong', { text: item.event.sender.name });
    cardHeader.createEl('span', {
      text: this.formatTimeAgo(item.receivedAt),
      cls: 'vault-watch-time',
    });

    // Action description
    const actionText = this.formatAction(item);
    card.createEl('div', { text: actionText, cls: 'vault-watch-card-action' });

    // Summary
    card.createEl('div', {
      text: item.event.change.summary,
      cls: 'vault-watch-card-summary',
    });

    // Mention badge
    if (item.event.mentionedMembers.length > 0) {
      card.createEl('span', {
        text: item.event.mentionedMembers.map(m => `@${m}`).join(' ') + ' mentioned',
        cls: 'vault-watch-mention-badge',
      });
    }

    // Actions
    const actions = card.createDiv({ cls: 'vault-watch-card-actions' });

    const openBtn = actions.createEl('button', {
      text: 'Open',
      cls: 'vault-watch-btn',
    });
    openBtn.addEventListener('click', async () => {
      await this.inboxActions.openFile(item);
      if (item.status === 'unread') {
        await this.inboxStore.markRead(item.id);
      }
    });

    if (item.status === 'unread') {
      const readBtn = actions.createEl('button', {
        text: 'Mark Read',
        cls: 'vault-watch-btn vault-watch-btn-secondary',
      });
      readBtn.addEventListener('click', () => {
        this.inboxStore.markRead(item.id);
      });
    }

    const archiveBtn = actions.createEl('button', {
      text: 'Archive',
      cls: 'vault-watch-btn vault-watch-btn-secondary',
    });
    archiveBtn.addEventListener('click', () => {
      this.inboxStore.archive(item.id);
    });
  }

  private formatAction(item: InboxItem): string {
    switch (item.event.type) {
      case 'file_created':
        return `Created "${item.event.fileTitle}"`;
      case 'file_deleted':
        return `Deleted "${item.event.fileTitle}"`;
      case 'file_renamed':
        return `Renamed "${item.event.fileTitle}"`;
      case 'mention':
        return `Mentioned you in "${item.event.fileTitle}"`;
      default:
        return `Edited "${item.event.fileTitle}"`;
    }
  }

  private formatTimeAgo(ts: number): string {
    const diff = Date.now() - ts;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }
}
