import { ItemView, WorkspaceLeaf, setIcon, Menu, Notice, TFile, TFolder } from 'obsidian';
import type { InboxItem, InboxFilter, InboxTab, ActivitySubFilter, Member, InboxTask, InboxTaskLane, InboxTasksSettings } from '../types';
import { INBOX_VIEW_TYPE, REACTION_EMOJIS } from '../types';
import type { InboxStore } from './inbox-store';
import { InboxActions } from './actions';
import type { TaskScanner } from './task-scanner';
import type { TaskActions } from './task-actions';
import { getEventVerb } from '../utils/event-verbs';
import { INBOX_TIMESTAMP_REFRESH_MS } from '../core/constants';
import { groupInboxItems } from './event-grouping';
import { ChatInput, ChatSubmission } from '../chat/chat-input';
import { groupIntoThreads, ChatThread } from '../chat/chat-grouping';
import {
  getInitials,
  eventColorClass,
  formatDate,
  formatTimeAgo,
  formatItemSummary,
} from './inbox-formatting';

type ChatSendHandler = (
  body: string,
  threadRootId: string | undefined,
  docRefs: string[],
  mentionedMembers: string[]
) => Promise<void>;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

export class InboxView extends ItemView {
  private currentFilter: InboxTab = 'inbox';
  private activitySub: ActivitySubFilter = 'all';
  private searchQuery = '';
  private showMembers = false;
  private personFilter: string | null = null;
  private taskRootFilter: string | null = null;
  private taskScopeMine = true;
  private expandedGroups = new Set<string>();
  private changeHandler: () => void;
  private taskChangeHandler: () => void;
  private onReact: ((itemId: string, emoji: string) => Promise<void>) | null = null;
  private getMembers: () => Member[] = () => [];
  private myId = '';
  private pluginVersion = '';
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private taskScanner: TaskScanner | null = null;
  private taskActions: TaskActions | null = null;
  private getTasksSettings: (() => InboxTasksSettings) | null = null;
  private saveSettings: (() => Promise<void>) | null = null;
  private chatHandler: ChatSendHandler | null = null;
  private chatInput: ChatInput | null = null;
  private chatThreadId: string | null = null;   // null = main list; otherwise = root id
  private getSetupComplete: () => boolean = () => true;
  private openSetup: () => void = () => {};

  constructor(
    leaf: WorkspaceLeaf,
    private inboxStore: InboxStore,
    private inboxActions: InboxActions
  ) {
    super(leaf);
    this.changeHandler = () => this.render();
    this.taskChangeHandler = () => {
      if (this.currentFilter === 'inbox') this.render();
    };
  }

  setTasksSource(
    scanner: TaskScanner,
    actions: TaskActions,
    getSettings: () => InboxTasksSettings,
    saveSettings: () => Promise<void>
  ): void {
    // Detach previous listener if any
    if (this.taskScanner) this.taskScanner.offChange(this.taskChangeHandler);
    this.taskScanner = scanner;
    this.taskActions = actions;
    this.getTasksSettings = getSettings;
    this.saveSettings = saveSettings;
    this.taskScopeMine = getSettings().perspective === 'mine';
    scanner.onChange(this.taskChangeHandler);
  }

  setMemberSource(getMembers: () => Member[], myId: string, version: string): void {
    this.getMembers = getMembers;
    this.myId = myId;
    this.pluginVersion = version;
  }

  setReactionHandler(handler: (itemId: string, emoji: string) => Promise<void>): void {
    this.onReact = handler;
  }

  setChatHandler(handler: ChatSendHandler): void {
    this.chatHandler = handler;
  }

  setSetupSource(getSetupComplete: () => boolean, openSetup: () => void): void {
    this.getSetupComplete = getSetupComplete;
    this.openSetup = openSetup;
  }

  /**
   * Switch to the Chat tab and pre-insert a doc-ref chip for `filePath`,
   * ready for the user to type their message.
   */
  startChatAbout(filePath: string): void {
    this.currentFilter = 'chat';
    this.chatThreadId = null;
    this.showMembers = false;
    this.render();
    // The input mount happens inside renderChatTab, so schedule the insert
    // after the DOM is attached.
    requestAnimationFrame(() => {
      if (!this.chatInput) return;
      const file = this.app.vault.getAbstractFileByPath(filePath);
      const label = file instanceof TFile
        ? file.basename
        : file instanceof TFolder
          ? file.name
          : filePath.split('/').pop()?.replace(/\.md$/, '') || filePath;
      const kind: 'file' | 'folder' = file instanceof TFolder ? 'folder' : 'file';
      this.chatInput.insertDocRef(filePath, label, kind);
    });
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
    this.refreshInterval = setInterval(() => {
      // Skip timer-based re-render while composing in chat — would clobber draft text
      if (this.currentFilter === 'chat') return;
      this.render();
    }, INBOX_TIMESTAMP_REFRESH_MS);
  }

  async onClose(): Promise<void> {
    this.inboxStore.offChange(this.changeHandler);
    if (this.taskScanner) this.taskScanner.offChange(this.taskChangeHandler);
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    if (this.chatInput) {
      this.chatInput.destroy();
      this.chatInput = null;
    }
    document.querySelectorAll('.vw-popover').forEach(el => el.remove());
  }

  focusNextUnread(): void {
    const items = this.inboxStore.getItems(this.currentFilter, this.activitySub);
    const next = items.find(i => i.status === 'unread');
    if (next) {
      this.inboxActions.openFile(next);
      this.inboxStore.markRead(next.id);
    }
  }

  private render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('vw-inbox');

    if (!this.getSetupComplete()) {
      this.renderSetupCta(container);
      return;
    }

    this.renderHeader(container);

    if (this.showMembers) {
      this.renderMembers(container);
      this.renderFooter(container, false);
      return;
    }

    if (this.currentFilter === 'chat') {
      this.renderChatTab(container);
      // Chat has its own footer (no mark-all button — chat auto-reads on view)
      return;
    }

    if (this.currentFilter === 'inbox') {
      this.renderInboxTab(container);
      this.renderFooter(container, false);
      return;
    }

    let baseItems = this.inboxStore.getItems(this.currentFilter, this.activitySub);
    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      baseItems = baseItems.filter(i =>
        i.event.fileTitle.toLowerCase().includes(q) ||
        i.event.sender.name.toLowerCase().includes(q) ||
        (i.event.change.summary || '').toLowerCase().includes(q)
      );
    }

    this.renderPersonChips(container, baseItems);

    let items = baseItems;
    if (this.personFilter) {
      items = items.filter(i => i.event.sender.id === this.personFilter);
    }

    const grouped = groupInboxItems(items);
    const list = container.createDiv({ cls: 'vw-list' });

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

    this.renderFooter(container, items.some(i => i.status === 'unread'));
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: 'vw-header' });

    const titleRow = header.createDiv({ cls: 'vw-title-row' });
    titleRow.createEl('span', { text: 'Vault Watch', cls: 'vw-title' });
    titleRow.createDiv({ cls: 'vw-spacer' });

    const membersBtn = titleRow.createEl('button', {
      cls: `vw-icon-btn ${this.showMembers ? 'is-active' : ''}`,
      attr: { 'aria-label': 'Members', title: 'Members' },
    });
    setIcon(membersBtn, 'users');
    membersBtn.addEventListener('click', () => {
      this.showMembers = !this.showMembers;
      this.render();
    });

    if (this.showMembers) return;

    const activityBadge = this.inboxStore.getActivityUnreadCount();
    const inboxBadge = this.countMyOpenTasks();
    const chatBadge = this.inboxStore.getChatUnreadCount();

    const tabs: { id: InboxTab; label: string; badge: number }[] = [
      { id: 'inbox', label: 'Inbox', badge: inboxBadge },
      { id: 'activity', label: 'Activity', badge: activityBadge },
      { id: 'chat', label: 'Chat', badge: chatBadge },
    ];

    const tabRow = header.createDiv({ cls: 'vw-tabs' });
    for (const t of tabs) {
      const btn = tabRow.createEl('button', {
        cls: `vw-tab ${this.currentFilter === t.id ? 'is-active' : ''}`,
      });
      btn.createSpan({ text: t.label, cls: 'vw-tab-label' });
      if (t.badge > 0) {
        btn.createSpan({ text: String(t.badge), cls: 'vw-tab-badge' });
      }
      btn.addEventListener('click', () => {
        if (this.currentFilter !== t.id) {
          this.currentFilter = t.id;
          this.activitySub = 'all';
          this.personFilter = null;
        }
        this.render();
      });
    }

    if (this.currentFilter === 'activity') {
      this.renderActivitySubFilters(header);
    }

    const search = header.createEl('input', {
      type: 'text',
      placeholder: 'Search…',
      cls: 'vw-search',
      value: this.searchQuery,
    });
    search.addEventListener('input', (e) => {
      this.searchQuery = (e.target as HTMLInputElement).value;
      this.render();
    });
  }

  private renderActivitySubFilters(parent: HTMLElement): void {
    const row = parent.createDiv({ cls: 'vw-subfilters' });
    const subs: { id: ActivitySubFilter; label: string }[] = [
      { id: 'all', label: 'All' },
      { id: 'to-me', label: 'To me' },
      { id: 'additions', label: 'Additions' },
      { id: 'edits', label: 'Edits' },
      { id: 'deletions', label: 'Deletes' },
    ];
    for (const s of subs) {
      const btn = row.createEl('button', {
        text: s.label,
        cls: `vw-subfilter ${this.activitySub === s.id ? 'is-active' : ''}`,
      });
      btn.addEventListener('click', () => {
        this.activitySub = s.id;
        this.render();
      });
    }
  }

  private countMyOpenTasks(): number {
    if (!this.taskScanner || !this.getTasksSettings) return 0;
    const cfg = this.getTasksSettings();
    if (!cfg.enabled) return 0;
    try {
      const tasks = this.taskScanner.getTasks();
      const dismissed = new Set(cfg.dismissedPaths);
      const doneLane = this.resolveDoneLane(this.taskScanner.getLanes(), cfg.doneLane);
      return tasks.filter(t => {
        if (this.myId && t.assignee !== null && t.assignee !== this.myId) return false;
        if (dismissed.has(t.path)) return false;
        if (doneLane && t.lane && t.lane.name === doneLane.name) return false;
        return true;
      }).length;
    } catch {
      return 0;
    }
  }

  private renderInboxTab(container: HTMLElement): void {
    const tasksEnabled = this.getTasksSettings?.().enabled === true;
    if (!tasksEnabled) {
      const empty = container.createDiv({ cls: 'vw-empty' });
      const iconEl = empty.createDiv({ cls: 'vw-empty-icon' });
      setIcon(iconEl, 'inbox');
      empty.createEl('p', { text: 'Inbox is empty', cls: 'vw-empty-title' });
      empty.createEl('p', {
        text: 'Enable "Inbox Tasks" in settings to turn your folder-based workflow into your inbox.',
        cls: 'vw-empty-sub',
      });
      return;
    }
    this.renderTasksTab(container);
  }

  private renderPersonChips(container: HTMLElement, items: InboxItem[]): void {
    const senderMap = new Map<string, { name: string; count: number }>();
    for (const i of items) {
      const e = senderMap.get(i.event.sender.id) || { name: i.event.sender.name, count: 0 };
      e.count++;
      senderMap.set(i.event.sender.id, e);
    }

    if (senderMap.size <= 1) {
      if (this.personFilter && !senderMap.has(this.personFilter)) {
        this.personFilter = null;
      }
      return;
    }

    const row = container.createDiv({ cls: 'vw-chip-row' });
    const allChip = row.createEl('button', {
      text: 'All',
      cls: `vw-chip ${this.personFilter === null ? 'is-active' : ''}`,
    });
    allChip.addEventListener('click', () => {
      this.personFilter = null;
      this.render();
    });

    const sorted = [...senderMap.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [id, info] of sorted) {
      const chip = row.createEl('button', {
        cls: `vw-chip ${this.personFilter === id ? 'is-active' : ''}`,
      });
      chip.createSpan({ text: getInitials(info.name), cls: 'vw-chip-avatar' });
      chip.createSpan({ text: info.name, cls: 'vw-chip-name' });
      chip.createSpan({ text: `${info.count}`, cls: 'vw-chip-count' });
      chip.addEventListener('click', () => {
        this.personFilter = this.personFilter === id ? null : id;
        this.render();
      });
    }
  }

  private renderEmptyState(parent: HTMLElement): void {
    const empty = parent.createDiv({ cls: 'vw-empty' });
    const iconEl = empty.createDiv({ cls: 'vw-empty-icon' });
    const hasUserFilter = this.searchQuery || this.personFilter || this.activitySub !== 'all';
    const icon = hasUserFilter ? 'filter' : 'activity';
    const title = hasUserFilter ? 'Nothing matches' : 'No recent activity';
    const sub = hasUserFilter
      ? 'Try clearing filters'
      : 'File events, shares, mentions, and reactions will appear here';

    setIcon(iconEl, icon);
    empty.createEl('p', { text: title, cls: 'vw-empty-title' });
    empty.createEl('p', { text: sub, cls: 'vw-empty-sub' });
  }

  /**
   * Group adjacent items affecting the same file within 1h, regardless of sender.
   */
  private renderCard(parent: HTMLElement, item: InboxItem): void {
    const typeCls = eventColorClass(item.event.type);
    const statusCls = item.status === 'unread' ? 'is-unread'
                    : item.status === 'starred' ? 'is-starred' : '';
    const card = parent.createDiv({ cls: `vw-card ${typeCls} ${statusCls}` });

    // Lead column: dot + avatar
    const lead = card.createDiv({ cls: 'vw-card-lead' });
    lead.createDiv({ cls: 'vw-dot' });
    lead.createEl('span', {
      text: getInitials(item.event.sender.name),
      cls: 'vw-avatar',
    });

    // Body — clickable
    const body = card.createDiv({ cls: 'vw-card-body' });
    body.addEventListener('click', async () => {
      await this.inboxActions.openFile(item);
      if (item.status === 'unread') await this.inboxStore.markRead(item.id);
    });

    const top = body.createDiv({ cls: 'vw-card-top' });
    const phrase = top.createSpan({ cls: 'vw-phrase' });
    phrase.createSpan({ text: item.event.sender.name, cls: 'vw-sender' });
    phrase.createSpan({ text: getEventVerb(item.event.type), cls: 'vw-verb' });
    phrase.createSpan({ text: item.event.fileTitle, cls: 'vw-file' });
    top.createSpan({ text: formatTimeAgo(item.receivedAt), cls: 'vw-time' });

    // Mention pill
    if (item.event.type === 'mention') {
      const mentionRow = body.createDiv({ cls: 'vw-mention-row' });
      mentionRow.createEl('span', { text: '@you', cls: 'vw-mention-tag' });
    }

    // Summary (one line, truncated)
    const summary = formatItemSummary(item.event.change.summary);
    if (summary) {
      body.createEl('div', { text: summary, cls: 'vw-summary' });
    }

    // Reactions display
    if (item.reactions && item.reactions.length > 0) {
      const reactionsEl = body.createDiv({ cls: 'vw-reactions' });
      const grouped = new Map<string, string[]>();
      for (const r of item.reactions) {
        const names = grouped.get(r.emoji) || [];
        names.push(r.from);
        grouped.set(r.emoji, names);
      }
      for (const [emoji, names] of grouped) {
        const chip = reactionsEl.createEl('span', {
          cls: 'vw-reaction-chip',
          attr: { title: names.join(', ') },
        });
        chip.createSpan({ text: emoji });
        if (names.length > 1) {
          chip.createSpan({ text: ` ${names.length}`, cls: 'vw-reaction-count' });
        }
      }
    }

    // Always-visible Done button (archives = removes from list)
    const doneBtn = card.createEl('button', {
      cls: 'vw-done',
      attr: { 'aria-label': 'Done', title: 'Done — remove from list' },
    });
    setIcon(doneBtn, 'check');
    doneBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.inboxStore.archive(item.id);
    });

    // Hover-revealed extra actions
    const actions = card.createDiv({ cls: 'vw-actions' });

    const replyBtn = actions.createEl('button', {
      cls: 'vw-icon-btn',
      attr: { 'aria-label': 'Reply', title: 'Reply' },
    });
    setIcon(replyBtn, 'reply');
    replyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.inboxActions.replyToItem(item);
      if (item.status === 'unread') await this.inboxStore.markRead(item.id);
    });

    const reactBtn = actions.createEl('button', {
      cls: 'vw-icon-btn',
      attr: { 'aria-label': 'React', title: 'React' },
    });
    setIcon(reactBtn, 'smile-plus');
    reactBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openReactionPopover(reactBtn, item);
    });

    const moreBtn = actions.createEl('button', {
      cls: 'vw-icon-btn',
      attr: { 'aria-label': 'More', title: 'More' },
    });
    setIcon(moreBtn, 'more-horizontal');
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openCardMenu(e as MouseEvent, item);
    });
  }

  private renderGroupedCard(parent: HTMLElement, items: InboxItem[]): void {
    const first = items[0]; // most recent
    const groupKey = items.map(i => i.id).join(':');
    const isExpanded = this.expandedGroups.has(groupKey);
    const hasUnread = items.some(i => i.status === 'unread');
    const senderNames = Array.from(new Set(items.map(i => i.event.sender.name)));
    const typeCls = eventColorClass(first.event.type);
    const statusCls = hasUnread ? 'is-unread' : '';

    const card = parent.createDiv({ cls: `vw-card vw-card-grouped ${typeCls} ${statusCls}` });

    const lead = card.createDiv({ cls: 'vw-card-lead' });
    lead.createDiv({ cls: 'vw-dot' });
    const stack = lead.createDiv({ cls: 'vw-avatar-stack' });
    for (const name of senderNames.slice(0, 3)) {
      stack.createEl('span', { text: getInitials(name), cls: 'vw-avatar' });
    }

    const body = card.createDiv({ cls: 'vw-card-body' });
    body.addEventListener('click', async () => {
      await this.inboxActions.openFile(first);
      for (const item of items) {
        if (item.status === 'unread') await this.inboxStore.markRead(item.id);
      }
    });

    const top = body.createDiv({ cls: 'vw-card-top' });
    const phrase = top.createSpan({ cls: 'vw-phrase' });
    const senderLabel = senderNames.length === 1
      ? senderNames[0]
      : `${senderNames.slice(0, 2).join(' & ')}${senderNames.length > 2 ? ' +' + (senderNames.length - 2) : ''}`;
    phrase.createSpan({ text: senderLabel, cls: 'vw-sender' });
    phrase.createSpan({ text: `${items.length} changes to`, cls: 'vw-verb' });
    phrase.createSpan({ text: first.event.fileTitle, cls: 'vw-file' });
    top.createSpan({ text: formatTimeAgo(first.receivedAt), cls: 'vw-time' });

    // Compact summary: total char delta
    const totalDelta = items.reduce((sum, i) => sum + Math.abs(i.event.change.charDelta || 0), 0);
    if (totalDelta > 0) {
      body.createEl('div', {
        text: `${totalDelta} chars changed`,
        cls: 'vw-summary',
      });
    }

    // Expand toggle
    const expandBtn = body.createEl('button', {
      text: isExpanded ? 'Hide details' : `Show all ${items.length}`,
      cls: 'vw-expand-btn',
    });
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isExpanded) {
        this.expandedGroups.delete(groupKey);
      } else {
        this.expandedGroups.add(groupKey);
      }
      this.render();
    });

    if (isExpanded) {
      const details = body.createDiv({ cls: 'vw-group-details' });
      for (const item of items) {
        const line = details.createDiv({ cls: 'vw-group-line' });
        line.createSpan({ text: item.event.sender.name, cls: 'vw-group-line-sender' });
        line.createSpan({ text: ' · ' });
        const summary = item.event.change.summary || getEventVerb(item.event.type);
        line.createSpan({ text: summary, cls: 'vw-group-line-summary' });
        line.createSpan({ text: formatTimeAgo(item.receivedAt), cls: 'vw-time' });
      }
    }

    // Always-visible Done button (archives all items in the group)
    const doneBtn = card.createEl('button', {
      cls: 'vw-done',
      attr: { 'aria-label': 'Done', title: `Done — remove ${items.length} from list` },
    });
    setIcon(doneBtn, 'check');
    doneBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      for (const item of items) await this.inboxStore.archive(item.id);
    });

    // Hover-revealed extra actions
    const actions = card.createDiv({ cls: 'vw-actions' });
    const moreBtn = actions.createEl('button', {
      cls: 'vw-icon-btn',
      attr: { 'aria-label': 'More', title: 'More' },
    });
    setIcon(moreBtn, 'more-horizontal');
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openGroupMenu(e as MouseEvent, items);
    });
  }

  private openReactionPopover(anchor: HTMLElement, item: InboxItem): void {
    document.querySelectorAll('.vw-popover').forEach(el => el.remove());

    const rect = anchor.getBoundingClientRect();
    const popover = document.body.createDiv({ cls: 'vw-popover' });
    for (const emoji of REACTION_EMOJIS) {
      const btn = popover.createEl('button', { text: emoji, cls: 'vw-popover-emoji' });
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (this.onReact) await this.onReact(item.id, emoji);
        popover.remove();
      });
    }

    const popRect = popover.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - popRect.width - 8));
    const top = rect.top - popRect.height - 6 > 8
      ? rect.top - popRect.height - 6
      : rect.bottom + 6;
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;

    const closeHandler = (e: MouseEvent) => {
      if (!popover.contains(e.target as Node)) {
        popover.remove();
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);
  }

  private openCardMenu(evt: MouseEvent, item: InboxItem): void {
    const menu = new Menu();
    if (item.status === 'unread') {
      menu.addItem(i =>
        i.setTitle('Mark read').setIcon('check').onClick(() => this.inboxStore.markRead(item.id))
      );
    }
    menu.addItem(i =>
      i.setTitle(item.status === 'starred' ? 'Unstar' : 'Star')
        .setIcon('star')
        .onClick(() => this.inboxStore.star(item.id))
    );
    menu.addSeparator();
    menu.addItem(i =>
      i.setTitle('Snooze 1 hour').setIcon('clock').onClick(() => this.inboxStore.snooze(item.id, HOUR))
    );
    menu.addItem(i =>
      i.setTitle('Snooze 1 day').setIcon('clock').onClick(() => this.inboxStore.snooze(item.id, DAY))
    );
    menu.showAtMouseEvent(evt);
  }

  private openGroupMenu(evt: MouseEvent, items: InboxItem[]): void {
    const hasUnread = items.some(i => i.status === 'unread');
    const menu = new Menu();
    if (hasUnread) {
      menu.addItem(i =>
        i.setTitle('Mark all read').setIcon('check').onClick(async () => {
          for (const item of items) await this.inboxStore.markRead(item.id);
        })
      );
    }
    menu.addItem(i =>
      i.setTitle('Snooze all 1 hour').setIcon('clock').onClick(async () => {
        for (const item of items) await this.inboxStore.snooze(item.id, HOUR);
      })
    );
    menu.showAtMouseEvent(evt);
  }

  private renderFooter(container: HTMLElement, hasUnread: boolean): void {
    const footer = container.createDiv({ cls: 'vw-footer' });
    if (this.pluginVersion) {
      footer.createEl('span', { text: `v${this.pluginVersion}`, cls: 'vw-version' });
    } else {
      footer.createDiv({ cls: 'vw-spacer' });
    }
    if (hasUnread) {
      const markAllBtn = footer.createEl('button', {
        text: 'Mark all read',
        cls: 'vw-footer-btn',
      });
      markAllBtn.addEventListener('click', () => this.inboxStore.markAllRead());
    }
  }

  private renderMembers(container: HTMLElement): void {
    const members = this.getMembers();

    // Always-visible "Re-run setup" action at the top — useful for invitees
    // who want to re-open the modal without waiting for first-run state.
    const actionRow = container.createDiv({ cls: 'vw-member-actions' });
    const setupBtn = actionRow.createEl('button', { cls: 'vw-member-action-btn' });
    setIcon(setupBtn.createSpan(), 'user-plus');
    setupBtn.createSpan({ text: 'Open setup' });
    setupBtn.addEventListener('click', () => this.openSetup());

    if (members.length === 0) {
      const empty = container.createDiv({ cls: 'vw-empty' });
      const iconEl = empty.createDiv({ cls: 'vw-empty-icon' });
      setIcon(iconEl, 'users');
      empty.createEl('p', { text: 'No members yet', cls: 'vw-empty-title' });
      empty.createEl('p', { text: 'Click "Open setup" above to join.', cls: 'vw-empty-sub' });
      return;
    }

    const sorted = [...members].sort((a, b) => {
      if (a.id === this.myId) return -1;
      if (b.id === this.myId) return 1;
      return a.displayName.localeCompare(b.displayName);
    });

    const list = container.createDiv({ cls: 'vw-member-list' });
    for (const member of sorted) {
      const isMe = member.id === this.myId;
      const card = list.createDiv({ cls: 'vw-member' });
      card.createEl('span', {
        text: getInitials(member.displayName),
        cls: 'vw-avatar vw-avatar-lg',
      });
      const info = card.createDiv({ cls: 'vw-member-info' });
      const nameRow = info.createDiv({ cls: 'vw-member-name' });
      nameRow.createSpan({ text: member.displayName });
      if (isMe) nameRow.createSpan({ text: 'you', cls: 'vw-member-tag' });
      info.createEl('span', {
        text: `@${member.id} · joined ${formatDate(member.joinedAt)}`,
        cls: 'vw-member-meta',
      });
    }
  }

  // ─── Tasks Tab ───

  private renderTasksTab(container: HTMLElement): void {
    if (!this.taskScanner || !this.taskActions || !this.getTasksSettings) {
      this.renderTasksEmpty(container, 'Tasks not initialized');
      return;
    }

    const cfg = this.getTasksSettings();
    if (!cfg.enabled) {
      this.renderTasksEmpty(container, 'Enable Inbox Tasks in settings');
      return;
    }
    if (cfg.roots.length === 0) {
      this.renderTasksEmpty(container, 'No inbox roots configured');
      return;
    }

    const allTasks = this.taskScanner.getTasks();
    const lanes = this.taskScanner.getLanes();
    const doneLane = this.resolveDoneLane(lanes, cfg.doneLane);

    let visible = allTasks;

    if (this.taskScopeMine && this.myId) {
      visible = visible.filter(t => t.assignee === this.myId || t.assignee === null);
    }

    if (this.taskRootFilter) {
      visible = visible.filter(t => t.root === this.taskRootFilter);
    }

    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      visible = visible.filter(t =>
        t.title.toLowerCase().includes(q) ||
        t.tags.some(tag => tag.toLowerCase().includes(q)) ||
        (t.assignee || '').toLowerCase().includes(q)
      );
    }

    const dismissed = new Set(cfg.dismissedPaths);
    visible = visible.filter(t => !dismissed.has(t.path));

    if (cfg.hideDone && doneLane) {
      visible = visible.filter(t => !t.lane || t.lane.name !== doneLane.name);
    }

    this.renderTasksSubheader(container, cfg, lanes, doneLane, allTasks);

    if (visible.length === 0) {
      const empty = container.createDiv({ cls: 'vw-list' });
      this.renderTasksEmpty(empty, 'Nothing in your inbox');
      return;
    }

    if (cfg.viewMode === 'lanes') {
      this.renderTasksLanes(container, visible, lanes, cfg.hideDone ? doneLane : null);
    } else {
      this.renderTasksList(container, visible, lanes);
    }
  }

  private renderTasksEmpty(parent: HTMLElement, message: string): void {
    const empty = parent.createDiv({ cls: 'vw-empty' });
    const iconEl = empty.createDiv({ cls: 'vw-empty-icon' });
    setIcon(iconEl, 'inbox');
    empty.createEl('p', { text: message, cls: 'vw-empty-title' });
  }

  private resolveDoneLane(lanes: InboxTaskLane[], configured: string | null): InboxTaskLane | null {
    if (configured) {
      const match = lanes.find(l => l.name === configured || l.label === configured);
      if (match) return match;
    }
    return lanes.length > 0 ? lanes[lanes.length - 1] : null;
  }

  private renderTasksSubheader(
    container: HTMLElement,
    cfg: { roots: string[]; hideDone: boolean; viewMode: 'lanes' | 'list'; dismissedPaths: string[] },
    lanes: InboxTaskLane[],
    doneLane: InboxTaskLane | null,
    allTasks: InboxTask[]
  ): void {
    const bar = container.createDiv({ cls: 'vw-task-subbar' });

    const scopeRow = bar.createDiv({ cls: 'vw-task-scope' });
    const mineBtn = scopeRow.createEl('button', {
      text: 'Mine',
      cls: `vw-chip ${this.taskScopeMine ? 'is-active' : ''}`,
    });
    mineBtn.addEventListener('click', () => {
      this.taskScopeMine = true;
      this.render();
    });
    const everyoneBtn = scopeRow.createEl('button', {
      text: 'Everyone',
      cls: `vw-chip ${!this.taskScopeMine ? 'is-active' : ''}`,
    });
    everyoneBtn.addEventListener('click', () => {
      this.taskScopeMine = false;
      this.render();
    });

    scopeRow.createDiv({ cls: 'vw-spacer' });

    const viewBtn = scopeRow.createEl('button', {
      cls: 'vw-task-subtle-btn',
      attr: { title: cfg.viewMode === 'lanes' ? 'Switch to list' : 'Switch to lanes' },
    });
    setIcon(viewBtn, cfg.viewMode === 'lanes' ? 'list' : 'kanban');
    viewBtn.addEventListener('click', async () => {
      const s = this.getTasksSettings?.();
      if (!s || !this.saveSettings) return;
      s.viewMode = s.viewMode === 'lanes' ? 'list' : 'lanes';
      await this.saveSettings();
      this.render();
    });

    if (doneLane) {
      const doneBtn = scopeRow.createEl('button', {
        text: cfg.hideDone ? `Show ${doneLane.label}` : `Hide ${doneLane.label}`,
        cls: 'vw-task-subtle-btn',
      });
      doneBtn.addEventListener('click', async () => {
        const s = this.getTasksSettings?.();
        if (!s || !this.saveSettings) return;
        s.hideDone = !s.hideDone;
        await this.saveSettings();
        this.render();
      });
    }

    if (cfg.dismissedPaths.length > 0) {
      const undismissBtn = scopeRow.createEl('button', {
        text: `${cfg.dismissedPaths.length} hidden · show`,
        cls: 'vw-task-subtle-btn',
      });
      undismissBtn.addEventListener('click', async () => {
        const s = this.getTasksSettings?.();
        if (!s || !this.saveSettings) return;
        s.dismissedPaths = [];
        await this.saveSettings();
        this.render();
      });
    }

    if (cfg.roots.length > 1) {
      const rootRow = bar.createDiv({ cls: 'vw-task-rootrow' });
      const allBtn = rootRow.createEl('button', {
        text: 'All roots',
        cls: `vw-chip ${this.taskRootFilter === null ? 'is-active' : ''}`,
      });
      allBtn.addEventListener('click', () => {
        this.taskRootFilter = null;
        this.render();
      });
      for (const root of cfg.roots) {
        const count = allTasks.filter(t => t.root === root).length;
        const chip = rootRow.createEl('button', {
          cls: `vw-chip ${this.taskRootFilter === root ? 'is-active' : ''}`,
        });
        chip.createSpan({ text: root, cls: 'vw-chip-name' });
        chip.createSpan({ text: `${count}`, cls: 'vw-chip-count' });
        chip.addEventListener('click', () => {
          this.taskRootFilter = this.taskRootFilter === root ? null : root;
          this.render();
        });
      }
    }
  }

  private renderTasksLanes(
    container: HTMLElement,
    tasks: InboxTask[],
    lanes: InboxTaskLane[],
    hiddenDone: InboxTaskLane | null
  ): void {
    const board = container.createDiv({ cls: 'vw-task-board' });
    const shownLanes = lanes.filter(l => !hiddenDone || l.name !== hiddenDone.name);
    const orphans = tasks.filter(t => !t.lane);

    for (const lane of shownLanes) {
      const col = board.createDiv({ cls: 'vw-task-lane' });
      const head = col.createDiv({ cls: 'vw-task-lane-head' });
      head.createSpan({ text: lane.label, cls: 'vw-task-lane-title' });
      const items = tasks.filter(t => t.lane?.name === lane.name);
      head.createSpan({ text: String(items.length), cls: 'vw-task-lane-count' });
      const body = col.createDiv({ cls: 'vw-task-lane-body' });
      if (items.length === 0) {
        body.createDiv({ cls: 'vw-task-lane-empty', text: '—' });
      } else {
        for (const t of items) this.renderTaskCard(body, t, lanes);
      }
    }

    if (orphans.length > 0) {
      const col = board.createDiv({ cls: 'vw-task-lane vw-task-lane-orphan' });
      const head = col.createDiv({ cls: 'vw-task-lane-head' });
      head.createSpan({ text: 'No lane', cls: 'vw-task-lane-title' });
      head.createSpan({ text: String(orphans.length), cls: 'vw-task-lane-count' });
      const body = col.createDiv({ cls: 'vw-task-lane-body' });
      for (const t of orphans) this.renderTaskCard(body, t, lanes);
    }
  }

  private renderTasksList(container: HTMLElement, tasks: InboxTask[], lanes: InboxTaskLane[]): void {
    const list = container.createDiv({ cls: 'vw-list' });
    const byLane = new Map<string, InboxTask[]>();
    const orphans: InboxTask[] = [];
    for (const t of tasks) {
      if (t.lane) {
        const arr = byLane.get(t.lane.name) || [];
        arr.push(t);
        byLane.set(t.lane.name, arr);
      } else {
        orphans.push(t);
      }
    }
    for (const lane of lanes) {
      const items = byLane.get(lane.name);
      if (!items || items.length === 0) continue;
      const header = list.createDiv({ cls: 'vw-task-list-header' });
      header.createSpan({ text: lane.label, cls: 'vw-task-list-header-label' });
      header.createSpan({ text: String(items.length), cls: 'vw-chip-count' });
      for (const t of items) this.renderTaskCard(list, t, lanes);
    }
    if (orphans.length > 0) {
      const header = list.createDiv({ cls: 'vw-task-list-header' });
      header.createSpan({ text: 'No lane', cls: 'vw-task-list-header-label' });
      for (const t of orphans) this.renderTaskCard(list, t, lanes);
    }
  }

  private renderTaskCard(parent: HTMLElement, task: InboxTask, lanes: InboxTaskLane[]): void {
    const priorityCls = task.priority ? `vw-task-pri-${task.priority}` : '';
    const card = parent.createDiv({ cls: `vw-task-card ${priorityCls}` });

    if (this.hasRecentActivity(task.path)) card.addClass('has-activity');

    const top = card.createDiv({ cls: 'vw-task-card-top' });
    const icon = top.createSpan({ cls: 'vw-task-card-icon' });
    setIcon(icon, task.ext === 'canvas' ? 'layout-dashboard' : 'file-text');
    const titleEl = top.createEl('span', { text: task.title, cls: 'vw-task-card-title' });
    titleEl.addEventListener('click', () => this.taskActions?.open(task));

    const meta = card.createDiv({ cls: 'vw-task-card-meta' });
    if (task.assignee) {
      const m = this.getMembers().find(x => x.id === task.assignee);
      meta.createSpan({
        text: m ? m.displayName : task.assignee,
        cls: `vw-task-assignee ${task.assignee === this.myId ? 'is-me' : ''}`,
      });
    }
    if (this.taskRootFilter === null && this.getTasksSettings && this.getTasksSettings().roots.length > 1) {
      meta.createSpan({ text: task.root, cls: 'vw-task-root' });
    }
    if (task.priority) {
      meta.createSpan({ text: task.priority, cls: `vw-task-pri-pill vw-task-pri-${task.priority}` });
    }
    if (task.tags.length > 0) {
      for (const tag of task.tags.slice(0, 3)) {
        meta.createSpan({ text: `#${tag}`, cls: 'vw-task-tag' });
      }
    }
    meta.createSpan({ text: formatTimeAgo(task.mtime), cls: 'vw-time' });

    const actions = card.createDiv({ cls: 'vw-task-card-actions' });
    const nextLane = task.lane ? lanes.find(l => l.rank > task.lane!.rank) : null;
    if (nextLane) {
      const advance = actions.createEl('button', {
        cls: 'vw-task-btn vw-task-btn-primary',
        attr: { title: `Advance to ${nextLane.label}` },
      });
      advance.createSpan({ text: `→ ${nextLane.label}` });
      advance.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.taskActions?.advance(task);
      });
    }
    const openBtn = actions.createEl('button', {
      cls: 'vw-task-btn',
      attr: { title: 'Open', 'aria-label': 'Open' },
    });
    setIcon(openBtn, 'external-link');
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.taskActions?.open(task);
    });

    const moreBtn = actions.createEl('button', {
      cls: 'vw-task-btn',
      attr: { title: 'More', 'aria-label': 'More' },
    });
    setIcon(moreBtn, 'more-horizontal');
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openTaskMenu(e as MouseEvent, task, lanes);
    });

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openTaskMenu(e as MouseEvent, task, lanes);
    });
  }

  private openTaskMenu(evt: MouseEvent, task: InboxTask, lanes: InboxTaskLane[]): void {
    const menu = new Menu();

    menu.addItem(i => i.setTitle('Open').setIcon('external-link').onClick(() => this.taskActions?.open(task)));

    if (lanes.length > 0) {
      menu.addSeparator();
      for (const lane of lanes) {
        if (task.lane && lane.name === task.lane.name) continue;
        menu.addItem(i =>
          i.setTitle(`Move to ${lane.label}`)
            .setIcon('chevrons-right')
            .onClick(() => this.taskActions?.moveToLane(task, lane))
        );
      }
    }

    const members = this.getMembers();
    if (members.length > 0) {
      menu.addSeparator();
      for (const m of members) {
        if (m.id === task.assignee) continue;
        menu.addItem(i =>
          i.setTitle(`Reassign to ${m.displayName}`)
            .setIcon('user')
            .onClick(() => this.taskActions?.reassign(task, m.id))
        );
      }
    }

    menu.addSeparator();
    menu.addItem(i =>
      i.setTitle('Hide from Tasks')
        .setIcon('eye-off')
        .onClick(async () => {
          if (!this.saveSettings) return;
          await this.taskActions?.dismiss(task, this.saveSettings);
          this.render();
        })
    );

    menu.showAtMouseEvent(evt);
  }

  private hasRecentActivity(path: string): boolean {
    return this.inboxStore.hasRecentActivityForPath(path, DAY);
  }

  private renderSetupCta(container: HTMLElement): void {
    const header = container.createDiv({ cls: 'vw-header' });
    const titleRow = header.createDiv({ cls: 'vw-title-row' });
    titleRow.createEl('span', { text: 'Vault Watch', cls: 'vw-title' });

    const card = container.createDiv({ cls: 'vw-setup-cta' });
    const iconEl = card.createDiv({ cls: 'vw-setup-cta-icon' });
    setIcon(iconEl, 'bell-plus');
    card.createEl('h3', {
      text: 'Finish setup to join your team',
      cls: 'vw-setup-cta-title',
    });
    card.createEl('p', {
      text: 'Pick a member ID to generate your keys and appear to teammates. End-to-end encrypted — no servers, no accounts.',
      cls: 'vw-setup-cta-sub',
    });
    const btn = card.createEl('button', {
      text: 'Set up now',
      cls: 'mod-cta vw-setup-cta-btn',
    });
    btn.addEventListener('click', () => this.openSetup());
  }

  // ─── Chat Tab ───

  private renderChatTab(container: HTMLElement): void {
    if (!this.chatHandler) {
      this.renderEmptyChat(container, 'Chat is unavailable until setup completes');
      return;
    }

    const messages = this.inboxStore.getChatMessages();
    const threads = groupIntoThreads(messages);

    const body = container.createDiv({ cls: 'vw-chat-body' });

    if (this.chatThreadId) {
      this.renderChatThread(body, threads);
    } else {
      this.renderChatMainList(body, threads);
    }

    const inputSlot = container.createDiv({ cls: 'vw-chat-input-slot' });
    if (!this.chatInput) {
      this.chatInput = new ChatInput({
        app: this.app,
        getMembers: () => this.getMembers(),
        onSubmit: (submission) => this.handleChatSubmit(submission),
        placeholder: this.chatThreadId ? 'Reply in thread…' : 'Message — @ mention, # link a note',
      });
    } else {
      this.chatInput.setPlaceholder(
        this.chatThreadId ? 'Reply in thread…' : 'Message — @ mention, # link a note'
      );
    }
    this.chatInput.mount(inputSlot);

    // Clear unread when viewing
    void this.inboxStore.markAllChatRead();
  }

  private renderChatMainList(parent: HTMLElement, threads: ChatThread[]): void {
    if (threads.length === 0) {
      this.renderEmptyChat(parent, 'No messages yet — say hi 👋');
      return;
    }
    const list = parent.createDiv({ cls: 'vw-chat-list' });
    for (const thread of threads) {
      this.renderChatRoot(list, thread);
    }
    // Auto-scroll to bottom after paint
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }

  private renderChatThread(parent: HTMLElement, threads: ChatThread[]): void {
    const thread = threads.find(t => t.root.id === this.chatThreadId);
    if (!thread) {
      // Root not found — drop back to main
      this.chatThreadId = null;
      this.renderChatMainList(parent, threads);
      return;
    }

    const header = parent.createDiv({ cls: 'vw-chat-thread-header' });
    const back = header.createEl('button', { cls: 'vw-chat-thread-back' });
    setIcon(back, 'arrow-left');
    back.createSpan({ text: 'All messages' });
    back.addEventListener('click', () => {
      this.chatThreadId = null;
      this.render();
    });
    header.createSpan({
      text: `Thread · ${thread.replies.length + 1} message${thread.replies.length === 0 ? '' : 's'}`,
      cls: 'vw-chat-thread-title',
    });

    const list = parent.createDiv({ cls: 'vw-chat-list vw-chat-thread-list' });
    this.renderChatMessage(list, thread.root, { isRoot: true, showReplyAction: false });
    for (const reply of thread.replies) {
      this.renderChatMessage(list, reply, { isRoot: false, showReplyAction: false });
    }
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }

  private renderChatRoot(parent: HTMLElement, thread: ChatThread): void {
    this.renderChatMessage(parent, thread.root, {
      isRoot: true,
      showReplyAction: true,
      replyCount: thread.replies.length,
      lastReplyTs: thread.replies[thread.replies.length - 1]?.event.ts,
    });
  }

  private renderChatMessage(
    parent: HTMLElement,
    item: InboxItem,
    opts: { isRoot: boolean; showReplyAction: boolean; replyCount?: number; lastReplyTs?: number }
  ): void {
    const isMe = item.event.sender.id === this.myId;
    const isMention = item.event.mentionedMembers.includes(this.myId);
    const msg = parent.createDiv({
      cls: `vw-chat-msg ${isMe ? 'is-me' : ''} ${isMention ? 'is-mention' : ''} ${item.status === 'unread' ? 'is-unread' : ''}`,
    });

    const lead = msg.createDiv({ cls: 'vw-chat-msg-lead' });
    lead.createSpan({ text: getInitials(item.event.sender.name), cls: 'vw-avatar' });

    const mainCol = msg.createDiv({ cls: 'vw-chat-msg-main' });

    const top = mainCol.createDiv({ cls: 'vw-chat-msg-top' });
    top.createSpan({ text: item.event.sender.name, cls: 'vw-chat-msg-sender' });
    top.createSpan({ text: formatTimeAgo(item.event.ts), cls: 'vw-time' });

    const bodyEl = mainCol.createDiv({ cls: 'vw-chat-msg-body' });
    this.renderChatBody(bodyEl, item);

    if (opts.showReplyAction) {
      const actions = mainCol.createDiv({ cls: 'vw-chat-msg-actions' });
      const replyCount = opts.replyCount ?? 0;
      if (replyCount > 0) {
        const pill = actions.createEl('button', { cls: 'vw-chat-thread-pill' });
        pill.createSpan({
          text: `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`,
          cls: 'vw-chat-thread-pill-count',
        });
        if (opts.lastReplyTs) {
          pill.createSpan({ text: `· last ${formatTimeAgo(opts.lastReplyTs)}`, cls: 'vw-chat-thread-pill-meta' });
        }
        pill.addEventListener('click', () => {
          this.chatThreadId = item.id;
          this.render();
        });
      } else {
        const reply = actions.createEl('button', { cls: 'vw-chat-reply-btn' });
        setIcon(reply, 'reply');
        reply.createSpan({ text: 'Reply in thread' });
        reply.addEventListener('click', () => {
          this.chatThreadId = item.id;
          this.render();
        });
      }
    }
  }

  private renderChatBody(parent: HTMLElement, item: InboxItem): void {
    const body = item.event.body || item.event.change.summary || '';
    const mentionedIds = new Set(item.event.mentionedMembers);
    const docRefs = new Set(item.event.docRefs || []);
    const members = this.getMembers();

    // Tokenize: find @id and #path tokens, render as chips; other text as plain spans.
    // Path tokens can contain '/', '.', spaces, so we greedy-match the longest registered docRef.
    let i = 0;
    while (i < body.length) {
      const ch = body[i];
      if (ch === '@') {
        // Match longest member id/displayName at position
        const matched = matchMemberToken(body, i + 1, members, mentionedIds);
        if (matched) {
          const chip = parent.createSpan({
            text: `@${matched.displayName}`,
            cls: 'vw-chat-chip vw-chat-chip-mention' + (matched.id === this.myId ? ' is-self' : ''),
          });
          chip.setAttr('title', `@${matched.id}`);
          i += 1 + matched.matchedLength;
          continue;
        }
      }
      if (ch === '#') {
        const matched = matchPathToken(body, i + 1, docRefs);
        if (matched) {
          const isFolder = matched.endsWith('/') || !matched.includes('.');
          const chip = parent.createEl('a', {
            cls: `vw-chat-chip vw-chat-chip-ref is-${isFolder ? 'folder' : 'file'}`,
            text: `${isFolder ? '📁' : '📄'} ${labelForPath(matched)}`,
            attr: { href: '#', title: matched },
          });
          chip.addEventListener('click', (e) => {
            e.preventDefault();
            void this.openDocRef(matched);
          });
          i += 1 + matched.length;
          continue;
        }
      }
      if (ch === '\n') {
        parent.createEl('br');
        i++;
        continue;
      }
      // Accumulate plain text until next special char. Include the current char
      // (which may be a stray @ or # that didn't match a token) so we always advance.
      let j = i + 1;
      while (j < body.length && body[j] !== '@' && body[j] !== '#' && body[j] !== '\n') j++;
      parent.createSpan({ text: body.slice(i, j) });
      i = j;
    }
  }

  private async openDocRef(path: string): Promise<void> {
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (abstract instanceof TFile) {
      await this.app.workspace.openLinkText(path, '', false);
      return;
    }
    if (abstract instanceof TFolder) {
      // Reveal folder in the file explorer pane if available
      const explorer = this.app.workspace.getLeavesOfType('file-explorer')[0];
      if (explorer) {
        this.app.workspace.revealLeaf(explorer);
        const view = explorer.view as unknown as { revealInFolder?: (f: TFolder) => void };
        view.revealInFolder?.(abstract);
        return;
      }
      new Notice(`Folder: ${path}`);
      return;
    }
    new Notice(`"${path}" not found in vault`);
  }

  private renderEmptyChat(parent: HTMLElement, message: string): void {
    const empty = parent.createDiv({ cls: 'vw-empty vw-chat-empty' });
    const iconEl = empty.createDiv({ cls: 'vw-empty-icon' });
    setIcon(iconEl, 'message-circle');
    empty.createEl('p', { text: message, cls: 'vw-empty-title' });
  }

  private async handleChatSubmit(submission: ChatSubmission): Promise<void> {
    if (!this.chatHandler) return;
    await this.chatHandler(
      submission.body,
      this.chatThreadId || undefined,
      submission.docRefs,
      submission.mentionedMembers
    );
  }
}

// ─── Chat tokenization helpers ───

interface MemberTokenMatch {
  id: string;
  displayName: string;
  matchedLength: number;
}

function matchMemberToken(
  text: string,
  startIndex: number,
  members: Member[],
  mentionedIds: Set<string>
): MemberTokenMatch | null {
  // Try longest id first; an @-token runs to the first whitespace or special char
  let end = startIndex;
  while (end < text.length && !/[\s@#]/.test(text[end])) end++;
  const candidate = text.slice(startIndex, end);
  if (!candidate) return null;
  const member = members.find(
    m => m.id === candidate || m.displayName === candidate
  );
  if (member && mentionedIds.has(member.id)) {
    return { id: member.id, displayName: member.displayName, matchedLength: candidate.length };
  }
  return null;
}

function matchPathToken(text: string, startIndex: number, docRefs: Set<string>): string | null {
  // Try longest matching docRef starting at startIndex. Paths can contain spaces and slashes;
  // we pick the registered docRef that matches at this position with the greatest length.
  let best: string | null = null;
  for (const ref of docRefs) {
    if (text.startsWith(ref, startIndex)) {
      if (!best || ref.length > best.length) best = ref;
    }
  }
  return best;
}

function labelForPath(path: string): string {
  const stripped = path.replace(/\/$/, '');
  const last = stripped.split('/').pop() || stripped;
  return last.replace(/\.md$/, '');
}
