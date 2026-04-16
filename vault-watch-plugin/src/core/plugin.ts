import { Plugin, WorkspaceLeaf, Notice } from 'obsidian';
import type { VaultWatchSettings, Member } from '../types';
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
  private memberRegistry!: MemberRegistryManager;
  private inboxStore!: InboxStore;
  private vaultRelay!: VaultRelay;
  private slackWebhook!: SlackWebhook;
  private dispatcher!: Dispatcher;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

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
    const eventBuilder = new EventBuilder(
      this.settings,
      () => this.memberRegistry.getMembers()
    );

    // Initialize ignore rules
    const ignoreRules = new IgnoreRules(this.settings);

    // Initialize coalescer
    this.coalescer = new Coalescer(
      this.settings,
      eventBuilder,
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

    // Add ribbon icon
    this.addRibbonIcon('bell', 'Vault Watch Inbox', () => {
      this.activateView();
    });

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

  private async startWatching(): Promise<void> {
    // Snapshot existing files for diff baseline
    await this.watcher.snapshotAll();

    // Load inbox from disk
    await this.inboxStore.loadFromDisk();

    // Start file watcher
    this.watcher.start();

    // Start outbox watcher (for incoming notifications)
    this.vaultRelay.startWatching();

    // Periodic outbox cleanup (every hour)
    this.cleanupInterval = setInterval(
      () => this.vaultRelay.cleanupOutbox(),
      60 * 60 * 1000
    );

    console.log('[vault-watch] Started watching vault');
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
