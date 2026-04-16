import { Plugin, WorkspaceLeaf, Notice, TFile, TFolder, Menu } from 'obsidian';
import type { VaultWatchSettings, Member, NotificationEvent } from '../types';
import { DEFAULT_SETTINGS, INBOX_VIEW_TYPE } from '../types';
import { VaultWatchSettingTab } from './settings';
import { IgnoreRules } from '../watcher/ignore-rules';
import { VaultWatcher } from '../watcher/vault-watcher';
import { Coalescer } from '../watcher/coalescer';
import { DiffAnalyzer } from '../watcher/diff-analyzer';
import { EventBuilder } from '../notifications/event-builder';
import { Dispatcher } from '../notifications/dispatcher';
import { MemberRegistryManager } from '../members/registry';
import { MentionSuggest } from '../members/mention-suggest';
import { InboxStore } from '../inbox/inbox-store';
import { InboxView } from '../inbox/inbox-view';
import { InboxActions } from '../inbox/actions';
import { VaultRelay } from '../relay/vault-relay';
import { SlackWebhook } from '../relay/slack-webhook';
import { generateKeySet, createPublicKeyBundle } from '../crypto/keys';

export default class VaultWatchPlugin extends Plugin {
  settings: VaultWatchSettings = DEFAULT_SETTINGS;

  private watcher!: VaultWatcher;
  private coalescer!: Coalescer;
  private eventBuilder!: EventBuilder;
  private memberRegistry!: MemberRegistryManager;
  private inboxStore!: InboxStore;
  private vaultRelay!: VaultRelay;
  private slackWebhook!: SlackWebhook;
  private dispatcher!: Dispatcher;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private ribbonIconEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Initialize member registry
    this.memberRegistry = new MemberRegistryManager(this.app.vault);
    await this.memberRegistry.initialize();

    // Initialize inbox
    this.inboxStore = new InboxStore(this.app.vault, this.settings);

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

    // Register inbox view
    this.registerView(INBOX_VIEW_TYPE, (leaf) => {
      const actions = new InboxActions(this.app);
      return new InboxView(leaf, this.inboxStore, actions);
    });

    // Register mention suggest
    this.registerEditorSuggest(
      new MentionSuggest(this.app, () => this.memberRegistry.getMembers())
    );

    // Add settings tab
    this.addSettingTab(new VaultWatchSettingTab(this.app, this));

    // Add ribbon icon with unread badge
    this.ribbonIconEl = this.addRibbonIcon('bell', 'Vault Watch Inbox', () => {
      this.activateView();
    });
    this.ribbonIconEl.addClass('vault-watch-ribbon');

    // Update badge when inbox changes
    this.inboxStore.onChange(() => this.updateRibbonBadge());

    // Add commands
    this.addCommand({
      id: 'open-inbox',
      name: 'Open Inbox',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'mark-all-read',
      name: 'Mark All Read',
      callback: () => this.inboxStore.markAllRead(),
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

    // Right-click context menu: "Push to Vault Watch" (files + folders)
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu: Menu, file) => {
        if (file instanceof TFile && file.path.endsWith('.md')) {
          menu.addItem((item) => {
            item
              .setTitle('Push to Vault Watch')
              .setIcon('message-square')
              .onClick(() => this.pushFile(file));
          });
        } else if (file instanceof TFolder) {
          menu.addItem((item) => {
            item
              .setTitle('Push folder to Vault Watch')
              .setIcon('message-square')
              .onClick(() => this.pushFolder(file));
          });
        }
      })
    );

    // Start when layout is ready
    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.setupComplete) {
        await this.startWatching();
      }
    });
  }

  async onunload(): Promise<void> {
    if (this.watcher) {
      this.watcher.stop();
    }
    if (this.coalescer) {
      await this.coalescer.flushAll();
    }
    if (this.vaultRelay) {
      this.vaultRelay.stopWatching();
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * First-time setup: generate keys, register member.
   */
  async runSetup(): Promise<void> {
    const keys = generateKeySet();

    // Store private keys locally (never synced)
    this.settings.privateKeyEd25519 = keys.ed25519.secretKey;
    this.settings.privateKeyX25519 = keys.x25519.secretKey;
    this.settings.setupComplete = true;

    // Auto-detect vault name if not set
    if (!this.settings.vaultName) {
      this.settings.vaultName = this.app.vault.getName();
    }

    await this.saveSettings();

    // Register member in shared registry
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

    // Start watching
    await this.startWatching();
  }

  private updateRibbonBadge(): void {
    if (!this.ribbonIconEl) return;
    const count = this.inboxStore.getUnreadCount();

    // Remove existing badge
    const existing = this.ribbonIconEl.querySelector('.vault-watch-ribbon-badge');
    if (existing) existing.remove();

    if (count > 0) {
      this.ribbonIconEl.addClass('has-unread');
      const badge = this.ribbonIconEl.createEl('span', {
        text: count > 99 ? '99+' : String(count),
        cls: 'vault-watch-ribbon-badge',
      });
    } else {
      this.ribbonIconEl.removeClass('has-unread');
    }
  }

  private async startWatching(): Promise<void> {
    // Snapshot existing files for diff baseline
    await this.watcher.snapshotAll();

    // Load inbox from disk
    await this.inboxStore.loadFromDisk();
    this.updateRibbonBadge();

    // Start file watcher
    this.watcher.start();

    // Start outbox watcher (for incoming notifications)
    this.vaultRelay.startWatching();

    // Watch for new members joining (members.json changes)
    this.watchForNewMembers();

    // Periodic outbox cleanup (every hour)
    this.cleanupInterval = setInterval(
      () => this.vaultRelay.cleanupOutbox(),
      60 * 60 * 1000
    );

    console.log('[vault-watch] Started watching vault');
  }

  private watchForNewMembers(): void {
    const knownMembers = new Set(this.memberRegistry.getMembers().map(m => m.id));

    this.registerEvent(
      this.app.vault.on('modify', async (file) => {
        if (!(file instanceof TFile)) return;
        if (file.path !== 'Z_Meta/.vault-watch/members.json') return;

        await this.memberRegistry.loadRegistry();
        const current = this.memberRegistry.getMembers();

        for (const member of current) {
          if (!knownMembers.has(member.id) && member.id !== this.settings.memberId) {
            new Notice(
              `${member.displayName} joined Vault Watch!`,
              8000
            );
            knownMembers.add(member.id);
          }
        }
      })
    );
  }

  private async pushFile(file: TFile): Promise<void> {
    if (!this.settings.setupComplete) {
      new Notice('Vault Watch: Run setup first in settings');
      return;
    }

    try {
      const content = await this.app.vault.cachedRead(file);
      const members = this.memberRegistry.getMembers();
      const recipients = members.filter(m => m.id !== this.settings.memberId).map(m => m.id);

      if (recipients.length === 0) {
        new Notice('Vault Watch: No other members registered yet');
        return;
      }

      const fileTitle = file.basename;
      const event: NotificationEvent = {
        id: (await import('ulid')).ulid(),
        v: 1,
        type: 'share',
        ts: Date.now(),
        sender: { id: this.settings.memberId, name: this.settings.displayName },
        vault: this.settings.vaultName,
        filePath: file.path,
        fileTitle,
        change: {
          changeType: 'content_added',
          summary: `Shared "${fileTitle}"`,
          affectedHeadings: [],
          charDelta: content.length,
          addedExcerpt: content.slice(0, 200),
          coalescedCount: 1,
        },
        recipients,
        mentionedMembers: [],
        priority: 'high',
      };

      await this.dispatcher.dispatchToVault(event);
      if (this.settings.slackEnabled) {
        await this.slackWebhook.sendSingle(event);
      }

      new Notice(`Pushed "${fileTitle}" to Vault Watch`);
    } catch (err) {
      console.error('[vault-watch] Push failed:', err);
      new Notice('Vault Watch: Push failed');
    }
  }

  private async pushFolder(folder: TFolder): Promise<void> {
    const mdFiles = this.app.vault.getMarkdownFiles().filter(
      f => f.path.startsWith(folder.path + '/')
    );

    if (mdFiles.length === 0) {
      new Notice('No markdown files in this folder');
      return;
    }

    for (const file of mdFiles) {
      await this.pushFile(file);
    }

    new Notice(`Pushed ${mdFiles.length} files from "${folder.name}"`);
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
