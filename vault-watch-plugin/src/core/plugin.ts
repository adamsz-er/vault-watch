import { Plugin, WorkspaceLeaf, Notice, TFile, TFolder, Menu } from 'obsidian';
import type { VaultWatchSettings, Member, NotificationEvent } from '../types';
import { DEFAULT_SETTINGS, INBOX_VIEW_TYPE } from '../types';
import { VaultWatchSettingTab } from './settings';
import { IgnoreRules } from '../watcher/ignore-rules';
import { VaultWatcher } from '../watcher/vault-watcher';
import { Coalescer } from '../watcher/coalescer';
import { EventBuilder } from '../notifications/event-builder';
import { Dispatcher } from '../notifications/dispatcher';
import { NotificationSound } from '../notifications/sound';
import { MemberRegistryManager } from '../members/registry';
import { MentionSuggest } from '../members/mention-suggest';
import { InboxStore } from '../inbox/inbox-store';
import { InboxView } from '../inbox/inbox-view';
import { InboxActions } from '../inbox/actions';
import { TaskScanner } from '../inbox/task-scanner';
import { TaskActions } from '../inbox/task-actions';
import { RecipientPickerModal } from '../notifications/recipient-picker';
import type { RecipientPickerResult } from '../notifications/recipient-picker';
import type { Priority } from '../types';
import { VaultRelay } from '../relay/vault-relay';
import { SlackWebhook } from '../relay/slack-webhook';
import { generateKeySet, createPublicKeyBundle } from '../crypto/keys';
import { notifyError } from '../utils/notify';
import { ulid } from 'ulid';

export default class VaultWatchPlugin extends Plugin {
  settings: VaultWatchSettings = DEFAULT_SETTINGS;

  private watcher!: VaultWatcher;
  private coalescer!: Coalescer;
  private eventBuilder!: EventBuilder;
  memberRegistry!: MemberRegistryManager;
  private inboxStore!: InboxStore;
  private vaultRelay!: VaultRelay;
  private slackWebhook!: SlackWebhook;
  private dispatcher!: Dispatcher;
  private sound!: NotificationSound;
  taskScanner!: TaskScanner;
  taskActions!: TaskActions;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private ribbonIconEl: HTMLElement | null = null;
  private statusBarEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Create registry (loaded later in onLayoutReady when vault is indexed)
    this.memberRegistry = new MemberRegistryManager(this.app.vault);

    // Initialize sound
    this.sound = new NotificationSound(this.settings);

    // Initialize inbox
    this.inboxStore = new InboxStore(this.app.vault, this.settings);
    this.inboxStore.setSound(this.sound);

    // Initialize relays
    this.slackWebhook = new SlackWebhook(this.settings, this.memberRegistry);
    this.vaultRelay = new VaultRelay(
      this.app.vault,
      this.settings,
      this.memberRegistry,
      this.inboxStore
    );

    // Initialize dispatcher
    this.dispatcher = new Dispatcher(this.vaultRelay, this.slackWebhook);

    // Initialize event builder
    this.eventBuilder = new EventBuilder(
      this.settings,
      () => this.memberRegistry.getMembers()
    );

    // Initialize ignore rules
    const ignoreRules = new IgnoreRules(this.settings);

    // Initialize coalescer
    this.coalescer = new Coalescer(
      this.settings,
      this.eventBuilder,
      this.dispatcher,
      (filePath) => this.watcher.getLastKnownContent(filePath)
    );

    // Initialize watcher
    this.watcher = new VaultWatcher(
      this.app.vault,
      this.settings,
      ignoreRules,
      this.coalescer
    );

    // Inbox Tasks scanner & actions (folder-backed task inbox)
    this.taskScanner = new TaskScanner(
      this.app,
      this.settings,
      () => this.memberRegistry.getMembers()
    );
    this.taskActions = new TaskActions(
      this.app,
      this.settings,
      this.taskScanner,
      () => this.memberRegistry.getMembers()
    );

    // Register inbox view
    this.registerView(INBOX_VIEW_TYPE, (leaf) => {
      const actions = new InboxActions(this.app);
      const view = new InboxView(leaf, this.inboxStore, actions);
      view.setReactionHandler((itemId, emoji) => this.sendReaction(itemId, emoji));
      view.setMemberSource(
        () => this.memberRegistry.getMembers(),
        this.settings.memberId,
        this.manifest.version
      );
      view.setTasksSource(
        this.taskScanner,
        this.taskActions,
        () => this.settings.inboxTasks,
        () => this.saveSettings()
      );
      view.setChatHandler((body, threadRootId, docRefs, mentionedMembers) =>
        this.sendChatMessage(body, threadRootId, docRefs, mentionedMembers)
      );
      return view;
    });

    // Register mention suggest
    this.registerEditorSuggest(
      new MentionSuggest(this.app, () => this.memberRegistry.getMembers())
    );

    // Add settings tab
    this.addSettingTab(new VaultWatchSettingTab(this.app, this));

    // Ribbon icon with unread badge
    this.ribbonIconEl = this.addRibbonIcon('bell', 'Vault Watch Inbox', () => {
      this.activateView();
    });
    this.ribbonIconEl.addClass('vault-watch-ribbon');

    // Status bar
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('vault-watch-status-bar');
    this.statusBarEl.addEventListener('click', () => this.activateView());

    // Update badge + status bar when inbox changes
    this.inboxStore.onChange(() => {
      this.updateRibbonBadge();
      this.updateStatusBar();
    });

    // ─── Commands ───

    this.addCommand({
      id: 'open-inbox',
      name: 'Open Inbox',
      hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'n' }],
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'mark-all-read',
      name: 'Mark All Read',
      callback: () => this.inboxStore.markAllRead(),
    });

    this.addCommand({
      id: 'next-unread',
      name: 'Go to Next Unread',
      hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'j' }],
      callback: () => {
        const views = this.app.workspace.getLeavesOfType(INBOX_VIEW_TYPE);
        if (views.length > 0) {
          (views[0].view as InboxView).focusNextUnread();
        }
      },
    });

    this.addCommand({
      id: 'push-current-file',
      name: 'Push Current File to Vault Watch',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;
        this.pushFile(file);
      },
    });

    this.addCommand({
      id: 'force-sync',
      name: 'Force Sync',
      callback: async () => {
        await this.memberRegistry.reload();
        await this.inboxStore.loadFromDisk();
        const members = this.memberRegistry.getMembers().length;
        const unread = this.inboxStore.getUnreadCount();
        new Notice(`Vault Watch: ${members} member${members !== 1 ? 's' : ''}, ${unread} unread`);
      },
    });

    this.addCommand({
      id: 'rescan-inbox-tasks',
      name: 'Rescan Inbox Tasks',
      callback: async () => {
        await this.taskScanner.scan();
        new Notice(`Vault Watch: scanned ${this.taskScanner.getTasks().length} task(s)`);
      },
    });

    this.addCommand({
      id: 'toggle-dnd',
      name: 'Toggle Do Not Disturb',
      callback: () => {
        this.settings.doNotDisturb = !this.settings.doNotDisturb;
        this.saveSettings();
        this.updateStatusBar();
        new Notice(
          this.settings.doNotDisturb
            ? 'Do Not Disturb: ON'
            : 'Do Not Disturb: OFF'
        );
      },
    });

    // Right-click context menu
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu: Menu, file) => {
        if (file instanceof TFile && file.path.endsWith('.md')) {
          this.addSendSubmenu(menu, file);
        } else if (file instanceof TFolder) {
          menu.addItem((item) => {
            item
              .setTitle('Send folder to Vault Watch')
              .setIcon('bell-ring')
              .onClick(() => this.promptSendFolder(file));
          });
        }
      })
    );

    // Inbox Tasks: vault events trigger debounced rescan
    this.registerEvent(this.app.vault.on('create', (f) => {
      this.taskScanner?.onVaultEvent(f.path);
    }));
    this.registerEvent(this.app.vault.on('delete', (f) => {
      this.taskScanner?.onVaultEvent(f.path);
    }));
    this.registerEvent(this.app.vault.on('rename', (f, oldPath) => {
      this.taskScanner?.onVaultEvent(f.path, oldPath);
    }));
    // metadataCache fires after Obsidian reindexes frontmatter/tags — covers modify
    this.registerEvent(this.app.metadataCache.on('changed', (f) => {
      this.taskScanner?.onVaultEvent(f.path);
    }));

    // Start when vault is indexed and layout is ready
    this.app.workspace.onLayoutReady(async () => {
      await this.memberRegistry.initialize();
      if (this.settings.setupComplete) {
        await this.startWatching();
      }
      if (this.settings.inboxTasks.enabled) {
        await this.taskScanner.scan();
      }
    });
  }

  async onunload(): Promise<void> {
    if (this.watcher) this.watcher.stop();
    if (this.coalescer) await this.coalescer.flushAll();
    if (this.vaultRelay) this.vaultRelay.stopWatching();
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.sound) this.sound.destroy();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async runSetup(): Promise<void> {
    const keys = generateKeySet();

    this.settings.privateKeyEd25519 = keys.ed25519.secretKey;
    this.settings.privateKeyX25519 = keys.x25519.secretKey;
    this.settings.setupComplete = true;

    if (!this.settings.vaultName) {
      this.settings.vaultName = this.app.vault.getName();
    }

    await this.saveSettings();

    const member: Member = {
      id: this.settings.memberId,
      displayName: this.settings.displayName,
      pubKeyEd25519: keys.ed25519.publicKey,
      pubKeyX25519: keys.x25519.publicKey,
      joinedAt: Date.now(),
      prefs: {
        notifyOn: ['file_changed', 'file_created', 'file_deleted', 'file_renamed', 'mention'],
        slackEnabled: this.settings.slackEnabled,
        minPriority: this.settings.minPriority,
      },
    };

    const pubBundle = createPublicKeyBundle(this.settings.memberId, keys);
    await this.memberRegistry.registerMember(member, pubBundle);

    await this.startWatching();
  }

  // ─── Private ───

  private updateRibbonBadge(): void {
    if (!this.ribbonIconEl) return;
    const count = this.inboxStore.getUnreadCount();

    const existing = this.ribbonIconEl.querySelector('.vault-watch-ribbon-badge');
    if (existing) existing.remove();

    if (count > 0) {
      this.ribbonIconEl.addClass('has-unread');
      this.ribbonIconEl.createEl('span', {
        text: count > 99 ? '99+' : String(count),
        cls: 'vault-watch-ribbon-badge',
      });
    } else {
      this.ribbonIconEl.removeClass('has-unread');
    }
  }

  private updateStatusBar(): void {
    if (!this.statusBarEl) return;
    const count = this.inboxStore.getUnreadCount();
    const dnd = this.settings.doNotDisturb ? ' (DND)' : '';

    if (count > 0) {
      this.statusBarEl.setText(`Vault Watch: ${count} unread${dnd}`);
      this.statusBarEl.addClass('has-unread');
    } else {
      this.statusBarEl.setText(`Vault Watch${dnd}`);
      this.statusBarEl.removeClass('has-unread');
    }
  }

  private async startWatching(): Promise<void> {
    await this.watcher.snapshotAll();
    await this.inboxStore.loadFromDisk();
    this.updateRibbonBadge();
    this.updateStatusBar();

    this.watcher.start();
    this.vaultRelay.startWatching();
    this.watchForNewMembers();

    this.cleanupInterval = setInterval(
      () => this.vaultRelay.cleanupOutbox(),
      60 * 60 * 1000
    );

    console.log('[vault-watch] Started watching vault');
  }

  private watchForNewMembers(): void {
    const knownMembers = new Set(this.memberRegistry.getMembers().map(m => m.id));
    const membersDir = 'Z_Meta/vault-watch/members/';
    const legacyFile = 'Z_Meta/vault-watch/members.json';

    const handleMemberChange = async (file: TFile) => {
      // Watch both per-member files AND legacy members.json
      const isPerMember = file.path.startsWith(membersDir) && file.extension === 'json';
      const isLegacy = file.path === legacyFile;
      if (!isPerMember && !isLegacy) return;

      await this.memberRegistry.reload();
      const current = this.memberRegistry.getMembers();

      for (const member of current) {
        if (!knownMembers.has(member.id) && member.id !== this.settings.memberId) {
          new Notice(`${member.displayName} joined Vault Watch!`, 8000);
          knownMembers.add(member.id);
        }
      }
    };

    this.registerEvent(this.app.vault.on('create', async (file) => {
      if (file instanceof TFile) await handleMemberChange(file);
    }));
    this.registerEvent(this.app.vault.on('modify', async (file) => {
      if (file instanceof TFile) await handleMemberChange(file);
    }));
  }

  private async sendChatMessage(
    body: string,
    threadRootId?: string,
    docRefs: string[] = [],
    mentionedMembers: string[] = []
  ): Promise<void> {
    if (!this.settings.setupComplete) {
      new Notice('Vault Watch: Run setup first in settings');
      return;
    }
    const trimmed = body.trim();
    if (!trimmed) return;

    const members = this.memberRegistry.getMembers();
    const recipients = members
      .filter(m => m.id !== this.settings.memberId)
      .map(m => m.id);

    const id = ulid();
    const rootId = threadRootId || id;
    const validMentions = mentionedMembers.filter(
      mId => mId !== this.settings.memberId && members.some(m => m.id === mId)
    );
    const priority: Priority = validMentions.length > 0 ? 'high' : 'normal';

    const event: NotificationEvent = {
      id,
      v: 1,
      type: 'chat_message',
      ts: Date.now(),
      sender: { id: this.settings.memberId, name: this.settings.displayName },
      vault: this.settings.vaultName,
      filePath: '',
      fileTitle: '(chat)',
      change: {
        changeType: 'chat',
        summary: trimmed.slice(0, 140),
        affectedHeadings: [],
        charDelta: 0,
        coalescedCount: 1,
      },
      recipients,
      mentionedMembers: validMentions,
      priority,
      body: trimmed,
      threadRootId: rootId,
      docRefs,
    };

    // Self-copy first so the sender sees their message immediately, even if dispatch fails
    await this.inboxStore.addSelfChat(event);

    if (recipients.length > 0) {
      try {
        await this.dispatcher.dispatchToVault(event);
      } catch (err) {
        notifyError('Chat send failed', err);
      }
    }
  }

  private async sendReaction(itemId: string, emoji: string): Promise<void> {
    const item = this.inboxStore.getItem(itemId);
    if (!item) return;

    const recipients = [item.event.sender.id];

    const event: NotificationEvent = {
      id: ulid(),
      v: 1,
      type: 'reaction',
      ts: Date.now(),
      sender: { id: this.settings.memberId, name: this.settings.displayName },
      vault: this.settings.vaultName,
      filePath: item.event.filePath,
      fileTitle: item.event.fileTitle,
      change: {
        changeType: 'content_added',
        summary: emoji,
        affectedHeadings: [],
        charDelta: 0,
        addedExcerpt: itemId, // Store target event ID
        coalescedCount: 1,
      },
      recipients,
      mentionedMembers: [],
      priority: 'normal',
    };

    await this.dispatcher.dispatchToVault(event);
    new Notice(`Reacted ${emoji}`);
  }

  private addSendSubmenu(menu: Menu, file: TFile): void {
    menu.addItem((item) => {
      item.setTitle('Send to Vault Watch').setIcon('bell-ring');

      // setSubmenu is available in Obsidian 1.4+. Fallback to direct click if not.
      const subApi = (item as unknown as { setSubmenu?: () => Menu }).setSubmenu;
      if (typeof subApi !== 'function') {
        item.onClick(() => this.promptSendFile(file));
        return;
      }
      const sub = (item as unknown as { setSubmenu: () => Menu }).setSubmenu();

      if (!this.settings.setupComplete) {
        sub.addItem(i => i.setTitle('Run setup first in settings').setIcon('settings'));
        return;
      }

      const others = this.memberRegistry.getMembers().filter(m => m.id !== this.settings.memberId);
      if (others.length === 0) {
        sub.addItem(i => i.setTitle('No other members yet').setIcon('users'));
        return;
      }

      // ─── Notify (encrypted event → notification inbox) ───
      sub.addItem(i =>
        i.setTitle('Notify everyone')
          .setIcon('bell-ring')
          .onClick(() => this.pushFile(file, others.map(m => m.id), 'high', ''))
      );
      for (const m of others) {
        sub.addItem(i =>
          i.setTitle(`Notify @${m.displayName}`)
            .setIcon('bell')
            .onClick(() => this.pushFile(file, [m.id], 'high', ''))
        );
      }
      sub.addItem(i =>
        i.setTitle('Notify with note…')
          .setIcon('pencil')
          .onClick(() => this.promptSendFile(file))
      );

      // ─── Assign as task (moves file into recipient's task inbox) ───
      const cfg = this.settings.inboxTasks;
      if (cfg.enabled && cfg.roots.length > 0) {
        const lanes = this.taskScanner.getLanes();
        const firstLane = lanes[0];
        if (firstLane) {
          sub.addSeparator();
          for (const root of cfg.roots) {
            for (const m of others) {
              const title = cfg.roots.length > 1
                ? `Assign → ${m.displayName} · ${root} › ${firstLane.label}`
                : `Assign → ${m.displayName} › ${firstLane.label}`;
              sub.addItem(i =>
                i.setTitle(title)
                  .setIcon('clipboard-check')
                  .onClick(() => this.assignAsTask(file, m.id, root, firstLane.name))
              );
            }
          }
        }
      }
    });
  }

  private async assignAsTask(
    file: TFile,
    memberId: string,
    root: string,
    laneName: string
  ): Promise<void> {
    const member = this.memberRegistry.getMembers().find(m => m.id === memberId);
    if (!member) return;
    const cfg = this.settings.inboxTasks;
    const personFolder = cfg.personFolderMap[memberId] || member.displayName;
    const destFolder = `${root}/${personFolder}/${laneName}`;
    try {
      await this.ensureFolder(destFolder);
      const destPath = `${destFolder}/${file.name}`;
      if (destPath === file.path) {
        new Notice('Already in that lane');
        return;
      }
      await this.app.fileManager.renameFile(file, destPath);
      const moved = this.app.vault.getAbstractFileByPath(destPath);
      if (moved instanceof TFile) {
        await this.pushFile(moved, [memberId], 'high', `Assigned to you in ${laneName}`);
      }
      new Notice(`Assigned to ${member.displayName} · ${laneName}`);
    } catch (err) {
      notifyError('Assign failed', err);
    }
  }

  private async ensureFolder(path: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) return;
    try {
      await this.app.vault.createFolder(path);
    } catch {
      const again = this.app.vault.getAbstractFileByPath(path);
      if (!(again instanceof TFolder)) throw new Error(`Cannot create folder: ${path}`);
    }
  }

  private async promptSendFile(file: TFile): Promise<void> {
    if (!this.settings.setupComplete) {
      new Notice('Vault Watch: Run setup first in settings');
      return;
    }
    const others = this.memberRegistry.getMembers().filter(m => m.id !== this.settings.memberId);
    if (others.length === 0) {
      new Notice('Vault Watch: No other members registered yet');
      return;
    }

    new RecipientPickerModal(
      this.app,
      others,
      `Send "${file.basename}"`,
      'Choose who should get this notification.',
      async (result) => {
        if (!result) return;
        await this.pushFile(file, result.recipients, result.priority, result.note);
      }
    ).open();
  }

  private async promptSendFolder(folder: TFolder): Promise<void> {
    if (!this.settings.setupComplete) {
      new Notice('Vault Watch: Run setup first in settings');
      return;
    }
    const mdFiles = this.app.vault.getMarkdownFiles().filter(
      f => f.path.startsWith(folder.path + '/')
    );
    if (mdFiles.length === 0) {
      new Notice('No markdown files in this folder');
      return;
    }
    const others = this.memberRegistry.getMembers().filter(m => m.id !== this.settings.memberId);
    if (others.length === 0) {
      new Notice('Vault Watch: No other members registered yet');
      return;
    }

    new RecipientPickerModal(
      this.app,
      others,
      `Send folder "${folder.name}"`,
      `${mdFiles.length} markdown file${mdFiles.length !== 1 ? 's' : ''} will be sent.`,
      async (result) => {
        if (!result) return;
        for (const file of mdFiles) {
          await this.pushFile(file, result.recipients, result.priority, result.note);
        }
        new Notice(`Pushed ${mdFiles.length} files from "${folder.name}"`);
      }
    ).open();
  }

  private async pushFile(
    file: TFile,
    recipientsOverride?: string[],
    priority: Priority = 'high',
    note: string = ''
  ): Promise<void> {
    if (!this.settings.setupComplete) {
      new Notice('Vault Watch: Run setup first in settings');
      return;
    }

    try {
      const content = await this.app.vault.cachedRead(file);
      const members = this.memberRegistry.getMembers();
      const recipients = (recipientsOverride && recipientsOverride.length > 0)
        ? recipientsOverride.filter(id => id !== this.settings.memberId)
        : members.filter(m => m.id !== this.settings.memberId).map(m => m.id);

      if (recipients.length === 0) {
        new Notice('Vault Watch: No recipients selected');
        return;
      }

      const fileTitle = file.basename;
      const summary = note ? `${note} — shared "${fileTitle}"` : `Shared "${fileTitle}"`;
      const event: NotificationEvent = {
        id: ulid(),
        v: 1,
        type: 'share',
        ts: Date.now(),
        sender: { id: this.settings.memberId, name: this.settings.displayName },
        vault: this.settings.vaultName,
        filePath: file.path,
        fileTitle,
        change: {
          changeType: 'content_added',
          summary,
          affectedHeadings: [],
          charDelta: content.length,
          addedExcerpt: note || content.slice(0, 200),
          coalescedCount: 1,
        },
        recipients,
        mentionedMembers: [],
        priority,
      };

      await this.dispatcher.dispatchToVault(event);
      if (this.settings.slackEnabled) {
        await this.slackWebhook.sendSingle(event);
      }

      const names = recipients.length === members.length - 1
        ? 'everyone'
        : recipients
            .map(id => members.find(m => m.id === id)?.displayName || id)
            .join(', ');
      new Notice(`Sent "${fileTitle}" to ${names}`);
    } catch (err) {
      notifyError('Vault Watch: Push failed', err);
    }
  }

  private async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(INBOX_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: INBOX_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }
}
