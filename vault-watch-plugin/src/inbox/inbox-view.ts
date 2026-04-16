import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { InboxItem, InboxFilter, ReactionEmoji, Member } from '../types';
import { INBOX_VIEW_TYPE, REACTION_EMOJIS } from '../types';
import type { InboxStore } from './inbox-store';
import { InboxActions } from './actions';

export class InboxView extends ItemView {
  private currentFilter: InboxFilter = 'all';
  private searchQuery = '';
  private showMembers = false;
  private changeHandler: () => void;
  private onReact: ((itemId: string, emoji: string) => Promise<void>) | null = null;
  private getMembers: () => Member[] = () => [];
  private myId = '';
  private pluginVersion = '';

  constructor(
    leaf: WorkspaceLeaf,
    private inboxStore: InboxStore,
    private inboxActions: InboxActions
  ) {
    super(leaf);
    this.changeHandler = () => this.render();
  }

  setMemberSource(getMembers: () => Member[], myId: string, version: string): void {
    this.getMembers = getMembers;
    this.myId = myId;
    this.pluginVersion = version;
  }

  setReactionHandler(handler: (itemId: string, emoji: string) => Promise<void>): void {
    this.onReact = handler;
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

  /** Navigate to next unread item */
  focusNextUnread(): void {
    const items = this.inboxStore.getItems(this.currentFilter);
    const next = items.find(i => i.status === 'unread');
    if (next) {
      this.inboxActions.openFile(next);
      this.inboxStore.markRead(next.id);
    }
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

    // Search bar
    const searchContainer = container.createDiv({ cls: 'vault-watch-search' });
    const searchInput = searchContainer.createEl('input', {
      type: 'text',
      placeholder: 'Search notifications...',
      cls: 'vault-watch-search-input',
      value: this.searchQuery,
    });
    searchInput.addEventListener('input', (e) => {
      this.searchQuery = (e.target as HTMLInputElement).value;
      this.render();
    });

    // Filter tabs
    const tabs = container.createDiv({ cls: 'vault-watch-tabs' });
    for (const filter of ['all', 'mentions', 'changes'] as InboxFilter[]) {
      const tab = tabs.createEl('button', {
        text: filter.charAt(0).toUpperCase() + filter.slice(1),
        cls: `vault-watch-tab ${this.currentFilter === filter && !this.showMembers ? 'active' : ''}`,
      });
      tab.addEventListener('click', () => {
        this.currentFilter = filter;
        this.showMembers = false;
        this.render();
      });
    }
    // Members tab
    const membersTab = tabs.createEl('button', {
      text: 'Members',
      cls: `vault-watch-tab ${this.showMembers ? 'active' : ''}`,
    });
    membersTab.addEventListener('click', () => {
      this.showMembers = true;
      this.render();
    });

    // Members view
    if (this.showMembers) {
      this.renderMembers(container);
      return;
    }

    // Items
    let items = this.inboxStore.getItems(this.currentFilter);

    // Apply search filter
    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      items = items.filter(i =>
        i.event.fileTitle.toLowerCase().includes(q) ||
        i.event.sender.name.toLowerCase().includes(q) ||
        i.event.change.summary.toLowerCase().includes(q)
      );
    }

    const list = container.createDiv({ cls: 'vault-watch-list' });

    if (items.length === 0) {
      list.createEl('p', {
        text: this.searchQuery ? 'No matching notifications' : 'No notifications yet',
        cls: 'vault-watch-empty',
      });
    } else {
      for (const item of items) {
        this.renderCard(list, item);
      }
    }

    // Footer
    const footer = container.createDiv({ cls: 'vault-watch-footer' });
    if (items.some(i => i.status === 'unread')) {
      const markAllBtn = footer.createEl('button', {
        text: 'Mark All Read',
        cls: 'vault-watch-footer-btn',
      });
      markAllBtn.addEventListener('click', () => {
        this.inboxStore.markAllRead();
      });
    }
  }

  private renderCard(parent: HTMLElement, item: InboxItem): void {
    const card = parent.createDiv({
      cls: `vault-watch-card ${item.status === 'unread' ? 'unread' : ''} ${item.status === 'starred' ? 'starred' : ''}`,
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

    // Reactions display
    if (item.reactions && item.reactions.length > 0) {
      const reactionsEl = card.createDiv({ cls: 'vault-watch-reactions-display' });
      const grouped = new Map<string, string[]>();
      for (const r of item.reactions) {
        const names = grouped.get(r.emoji) || [];
        names.push(r.from);
        grouped.set(r.emoji, names);
      }
      for (const [emoji, names] of grouped) {
        reactionsEl.createEl('span', {
          text: `${emoji} ${names.join(', ')}`,
          cls: 'vault-watch-reaction-chip',
        });
      }
    }

    // Actions row
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

    const replyBtn = actions.createEl('button', {
      text: 'Reply',
      cls: 'vault-watch-btn',
    });
    replyBtn.addEventListener('click', async () => {
      await this.inboxActions.replyToItem(item);
      if (item.status === 'unread') {
        await this.inboxStore.markRead(item.id);
      }
    });

    // Reaction buttons
    const reactRow = actions.createDiv({ cls: 'vault-watch-react-row' });
    for (const emoji of REACTION_EMOJIS) {
      const btn = reactRow.createEl('button', {
        text: emoji,
        cls: 'vault-watch-react-btn',
      });
      btn.addEventListener('click', async () => {
        if (this.onReact) {
          await this.onReact(item.id, emoji);
        }
      });
    }

    // Secondary actions
    const secondary = card.createDiv({ cls: 'vault-watch-card-secondary' });

    if (item.status === 'unread') {
      const readBtn = secondary.createEl('button', {
        text: 'Mark Read',
        cls: 'vault-watch-btn-link',
      });
      readBtn.addEventListener('click', () => this.inboxStore.markRead(item.id));
    }

    const snoozeBtn = secondary.createEl('button', {
      text: 'Snooze 1h',
      cls: 'vault-watch-btn-link',
    });
    snoozeBtn.addEventListener('click', () => {
      this.inboxStore.snooze(item.id, 60 * 60 * 1000);
    });

    const archiveBtn = secondary.createEl('button', {
      text: 'Archive',
      cls: 'vault-watch-btn-link',
    });
    archiveBtn.addEventListener('click', () => this.inboxStore.archive(item.id));

    const starBtn = secondary.createEl('button', {
      text: item.status === 'starred' ? 'Unstar' : 'Star',
      cls: 'vault-watch-btn-link',
    });
    starBtn.addEventListener('click', () => this.inboxStore.star(item.id));
  }

  private renderMembers(container: HTMLElement): void {
    const members = this.getMembers();
    const list = container.createDiv({ cls: 'vault-watch-members-list' });

    if (members.length === 0) {
      list.createEl('p', {
        text: 'No members registered yet. Run setup in settings.',
        cls: 'vault-watch-empty',
      });
      return;
    }

    // Show self first, then others sorted by name
    const sorted = [...members].sort((a, b) => {
      if (a.id === this.myId) return -1;
      if (b.id === this.myId) return 1;
      return a.displayName.localeCompare(b.displayName);
    });

    for (const member of sorted) {
      const isMe = member.id === this.myId;
      const card = list.createDiv({ cls: 'vault-watch-member-card' });

      const nameRow = card.createDiv({ cls: 'vault-watch-member-header' });
      const initials = member.displayName
        .split(/\s+/)
        .map(w => w[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);
      nameRow.createEl('span', { text: initials, cls: 'vault-watch-member-avatar' });

      const nameEl = nameRow.createDiv({ cls: 'vault-watch-member-info' });
      nameEl.createEl('strong', {
        text: member.displayName + (isMe ? ' (you)' : ''),
      });
      nameEl.createEl('span', {
        text: `@${member.id}`,
        cls: 'vault-watch-member-id',
      });

      const meta = card.createDiv({ cls: 'vault-watch-member-meta' });
      meta.createEl('span', {
        text: `Joined ${this.formatDate(member.joinedAt)}`,
        cls: 'vault-watch-time',
      });
    }

    // Footer with count + version
    const footer = container.createDiv({ cls: 'vault-watch-members-footer' });
    footer.createEl('span', {
      text: `${members.length} member${members.length !== 1 ? 's' : ''} in this vault`,
      cls: 'vault-watch-time',
    });
    if (this.pluginVersion) {
      footer.createEl('span', {
        text: `v${this.pluginVersion}`,
        cls: 'vault-watch-version',
      });
    }
  }

  private formatDate(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  private formatAction(item: InboxItem): string {
    switch (item.event.type) {
      case 'file_created': return `Created "${item.event.fileTitle}"`;
      case 'file_deleted': return `Deleted "${item.event.fileTitle}"`;
      case 'file_renamed': return `Renamed "${item.event.fileTitle}"`;
      case 'mention': return `Mentioned you in "${item.event.fileTitle}"`;
      case 'share': return `Shared "${item.event.fileTitle}"`;
      case 'reaction': return `Reacted to "${item.event.fileTitle}"`;
      default: return `Edited "${item.event.fileTitle}"`;
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
