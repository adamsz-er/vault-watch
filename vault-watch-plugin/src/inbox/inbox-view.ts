import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import type { InboxItem, InboxFilter, Member } from '../types';
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
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

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
    // Auto-refresh timestamps every 30s
    this.refreshInterval = setInterval(() => this.render(), 30_000);
  }

  async onClose(): Promise<void> {
    this.inboxStore.offChange(this.changeHandler);
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

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
    const unreadCount = this.inboxStore.getUnreadCount();
    if (unreadCount > 0) {
      header.createEl('span', { text: `${unreadCount}`, cls: 'vault-watch-badge' });
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
    const membersTab = tabs.createEl('button', {
      text: 'Members',
      cls: `vault-watch-tab ${this.showMembers ? 'active' : ''}`,
    });
    membersTab.addEventListener('click', () => {
      this.showMembers = true;
      this.render();
    });

    if (this.showMembers) {
      this.renderMembers(container);
      return;
    }

    // Get + filter items
    let items = this.inboxStore.getItems(this.currentFilter);
    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      items = items.filter(i =>
        i.event.fileTitle.toLowerCase().includes(q) ||
        i.event.sender.name.toLowerCase().includes(q) ||
        i.event.change.summary.toLowerCase().includes(q)
      );
    }

    // Group consecutive same-file events from the same sender
    const grouped = this.groupItems(items);

    const list = container.createDiv({ cls: 'vault-watch-list' });

    if (grouped.length === 0) {
      this.renderEmptyState(list);
    } else {
      for (const group of grouped) {
        if (group.length === 1) {
          this.renderCard(list, group[0]);
        } else {
          this.renderGroupedCard(list, group);
        }
      }
    }

    // Footer
    const footer = container.createDiv({ cls: 'vault-watch-footer' });
    if (items.some(i => i.status === 'unread')) {
      const markAllBtn = footer.createEl('button', {
        text: 'Mark All Read',
        cls: 'vault-watch-footer-btn',
      });
      markAllBtn.addEventListener('click', () => this.inboxStore.markAllRead());
    }
  }

  private renderEmptyState(parent: HTMLElement): void {
    const empty = parent.createDiv({ cls: 'vault-watch-empty-state' });
    const iconEl = empty.createDiv({ cls: 'vault-watch-empty-icon' });
    setIcon(iconEl, 'bell-off');
    empty.createEl('p', { text: 'All caught up', cls: 'vault-watch-empty-title' });
    empty.createEl('p', {
      text: this.searchQuery ? 'No matching notifications' : 'New notifications will appear here',
      cls: 'vault-watch-empty-sub',
    });
  }

  /**
   * Group consecutive items for the same file + sender.
   */
  private groupItems(items: InboxItem[]): InboxItem[][] {
    if (items.length === 0) return [];

    const groups: InboxItem[][] = [];
    let current: InboxItem[] = [items[0]];

    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1];
      const curr = items[i];
      const sameFile = prev.event.filePath === curr.event.filePath;
      const sameSender = prev.event.sender.id === curr.event.sender.id;
      const closeInTime = Math.abs(prev.receivedAt - curr.receivedAt) < 10 * 60 * 1000; // 10 min

      if (sameFile && sameSender && closeInTime) {
        current.push(curr);
      } else {
        groups.push(current);
        current = [curr];
      }
    }
    groups.push(current);
    return groups;
  }

  private renderGroupedCard(parent: HTMLElement, items: InboxItem[]): void {
    const first = items[0];
    const hasUnread = items.some(i => i.status === 'unread');
    const card = parent.createDiv({
      cls: `vault-watch-card vault-watch-card-grouped ${hasUnread ? 'unread' : ''} ${this.eventColorClass(first.event.type)}`,
    });

    // Header
    const cardHeader = card.createDiv({ cls: 'vault-watch-card-header' });
    cardHeader.createEl('strong', { text: first.event.sender.name });
    cardHeader.createEl('span', {
      text: this.formatTimeAgo(first.receivedAt),
      cls: 'vault-watch-time',
    });

    // Grouped summary
    card.createEl('div', {
      text: `${items.length} changes to "${first.event.fileTitle}"`,
      cls: 'vault-watch-card-action',
    });

    // Expandable detail list
    const details = card.createDiv({ cls: 'vault-watch-group-details' });
    for (const item of items) {
      details.createEl('div', {
        text: `${this.formatAction(item)} — ${item.event.change.summary}`,
        cls: 'vault-watch-group-detail-line',
      });
    }

    // Actions
    const actions = card.createDiv({ cls: 'vault-watch-card-actions' });
    const openBtn = actions.createEl('button', { text: 'Open', cls: 'vault-watch-btn' });
    openBtn.addEventListener('click', async () => {
      await this.inboxActions.openFile(first);
      for (const item of items) {
        if (item.status === 'unread') await this.inboxStore.markRead(item.id);
      }
    });

    if (hasUnread) {
      const readBtn = actions.createEl('button', { text: 'Mark Read', cls: 'vault-watch-btn vault-watch-btn-secondary' });
      readBtn.addEventListener('click', () => {
        for (const item of items) this.inboxStore.markRead(item.id);
      });
    }
  }

  private renderCard(parent: HTMLElement, item: InboxItem): void {
    const card = parent.createDiv({
      cls: `vault-watch-card ${item.status === 'unread' ? 'unread' : ''} ${item.status === 'starred' ? 'starred' : ''} ${this.eventColorClass(item.event.type)}`,
    });

    // Header
    const cardHeader = card.createDiv({ cls: 'vault-watch-card-header' });
    cardHeader.createEl('strong', { text: item.event.sender.name });
    cardHeader.createEl('span', {
      text: this.formatTimeAgo(item.receivedAt),
      cls: 'vault-watch-time',
    });

    // Action + summary
    card.createEl('div', { text: this.formatAction(item), cls: 'vault-watch-card-action' });
    card.createEl('div', { text: item.event.change.summary, cls: 'vault-watch-card-summary' });

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

    // Primary actions row
    const actions = card.createDiv({ cls: 'vault-watch-card-actions' });

    const openBtn = actions.createEl('button', { text: 'Open', cls: 'vault-watch-btn' });
    openBtn.addEventListener('click', async () => {
      await this.inboxActions.openFile(item);
      if (item.status === 'unread') await this.inboxStore.markRead(item.id);
    });

    const replyBtn = actions.createEl('button', { text: 'Reply', cls: 'vault-watch-btn' });
    replyBtn.addEventListener('click', async () => {
      await this.inboxActions.replyToItem(item);
      if (item.status === 'unread') await this.inboxStore.markRead(item.id);
    });

    // Reaction buttons
    const reactRow = actions.createDiv({ cls: 'vault-watch-react-row' });
    for (const emoji of REACTION_EMOJIS) {
      const btn = reactRow.createEl('button', { text: emoji, cls: 'vault-watch-react-btn' });
      btn.addEventListener('click', async () => {
        if (this.onReact) await this.onReact(item.id, emoji);
      });
    }

    // Secondary actions
    const secondary = card.createDiv({ cls: 'vault-watch-card-secondary' });

    if (item.status === 'unread') {
      const readBtn = secondary.createEl('button', { text: 'Mark Read', cls: 'vault-watch-btn-link' });
      readBtn.addEventListener('click', () => this.inboxStore.markRead(item.id));
    }

    const snoozeBtn = secondary.createEl('button', { text: 'Snooze 1h', cls: 'vault-watch-btn-link' });
    snoozeBtn.addEventListener('click', () => this.inboxStore.snooze(item.id, 60 * 60 * 1000));

    const archiveBtn = secondary.createEl('button', { text: 'Archive', cls: 'vault-watch-btn-link' });
    archiveBtn.addEventListener('click', () => this.inboxStore.archive(item.id));

    const starBtn = secondary.createEl('button', {
      text: item.status === 'starred' ? 'Unstar' : 'Star',
      cls: 'vault-watch-btn-link',
    });
    starBtn.addEventListener('click', () => this.inboxStore.star(item.id));
  }

  private eventColorClass(type: string): string {
    switch (type) {
      case 'mention': return 'vault-watch-type-mention';
      case 'file_created': return 'vault-watch-type-created';
      case 'file_deleted': return 'vault-watch-type-deleted';
      case 'share': return 'vault-watch-type-share';
      case 'reaction': return 'vault-watch-type-reaction';
      default: return 'vault-watch-type-edit';
    }
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
      nameEl.createEl('strong', { text: member.displayName + (isMe ? ' (you)' : '') });
      nameEl.createEl('span', { text: `@${member.id}`, cls: 'vault-watch-member-id' });

      const meta = card.createDiv({ cls: 'vault-watch-member-meta' });
      meta.createEl('span', {
        text: `Joined ${this.formatDate(member.joinedAt)}`,
        cls: 'vault-watch-time',
      });
    }

    const footer = container.createDiv({ cls: 'vault-watch-members-footer' });
    footer.createEl('span', {
      text: `${members.length} member${members.length !== 1 ? 's' : ''} in this vault`,
      cls: 'vault-watch-time',
    });
    if (this.pluginVersion) {
      footer.createEl('span', { text: `v${this.pluginVersion}`, cls: 'vault-watch-version' });
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
    if (diff < 0) return 'just now';
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }
}
