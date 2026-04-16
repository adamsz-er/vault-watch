import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type { VaultWatchSettings, EventType } from '../types';
import { generateKeySet, createPublicKeyBundle } from '../crypto/keys';
import type VaultWatchPlugin from './plugin';

const ROUTABLE_EVENT_TYPES: { id: EventType; label: string }[] = [
  { id: 'file_changed', label: 'File edits' },
  { id: 'file_created', label: 'File additions' },
  { id: 'file_deleted', label: 'File deletions' },
  { id: 'file_renamed', label: 'File renames' },
  { id: 'mention', label: 'Mentions' },
  { id: 'share', label: 'Shares' },
  { id: 'reaction', label: 'Reactions' },
  { id: 'task_assigned', label: 'Task assignments' },
];

export class VaultWatchSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: VaultWatchPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Vault Watch Settings' });

    // ── Identity ──
    containerEl.createEl('h3', { text: 'Identity' });

    new Setting(containerEl)
      .setName('Member ID')
      .setDesc('Your unique identifier (lowercase, no spaces)')
      .addText(text =>
        text
          .setPlaceholder('adam')
          .setValue(this.plugin.settings.memberId)
          .onChange(async (value) => {
            this.plugin.settings.memberId = value.toLowerCase().replace(/\s/g, '');
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Display Name')
      .setDesc('Your display name shown in notifications')
      .addText(text =>
        text
          .setPlaceholder('Adam')
          .setValue(this.plugin.settings.displayName)
          .onChange(async (value) => {
            this.plugin.settings.displayName = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Vault Name')
      .setDesc('Name of this vault (used in Obsidian deep links)')
      .addText(text =>
        text
          .setPlaceholder('jumbo-vault')
          .setValue(this.plugin.settings.vaultName)
          .onChange(async (value) => {
            this.plugin.settings.vaultName = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Setup ──
    if (!this.plugin.settings.setupComplete) {
      containerEl.createEl('h3', { text: 'First-Time Setup' });

      new Setting(containerEl)
        .setName('Generate Keys & Register')
        .setDesc('Generate encryption keys and register as a member. Do this once.')
        .addButton(btn =>
          btn
            .setButtonText('Setup')
            .setCta()
            .onClick(async () => {
              if (!this.plugin.settings.memberId || !this.plugin.settings.displayName) {
                new Notice('Please fill in Member ID and Display Name first');
                return;
              }
              await this.plugin.runSetup();
              new Notice('Setup complete! Keys generated and member registered.');
              this.display(); // Refresh
            })
        );
    } else {
      containerEl.createEl('p', {
        text: `Registered as "${this.plugin.settings.displayName}" (${this.plugin.settings.memberId})`,
        cls: 'vault-watch-setup-status',
      });
    }

    // ── Slack ──
    containerEl.createEl('h3', { text: 'Slack Integration' });

    new Setting(containerEl)
      .setName('Enable Slack notifications')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.slackEnabled)
          .onChange(async (value) => {
            this.plugin.settings.slackEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Slack Webhook URL')
      .setDesc('Incoming Webhook URL for your #vault-watch channel')
      .addText(text =>
        text
          .setPlaceholder('https://hooks.slack.com/services/...')
          .setValue(this.plugin.settings.slackWebhookUrl)
          .onChange(async (value) => {
            this.plugin.settings.slackWebhookUrl = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Sound & DND ──
    containerEl.createEl('h3', { text: 'Notifications' });

    new Setting(containerEl)
      .setName('Notification sound')
      .setDesc('Play a ping sound for incoming notifications')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.soundEnabled)
          .onChange(async (value) => {
            this.plugin.settings.soundEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Sound volume')
      .setDesc('0 (silent) to 100 (loud)')
      .addSlider(slider =>
        slider
          .setLimits(0, 100, 5)
          .setValue(this.plugin.settings.soundVolume * 100)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.soundVolume = value / 100;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Do Not Disturb')
      .setDesc('Suppress all toasts and sounds. Toggle via command palette: "Toggle Do Not Disturb"')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.doNotDisturb)
          .onChange(async (value) => {
            this.plugin.settings.doNotDisturb = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Timing ──
    containerEl.createEl('h3', { text: 'Notification Timing' });

    new Setting(containerEl)
      .setName('Debounce (ms)')
      .setDesc('Wait time after last keystroke before processing (Layer 1)')
      .addText(text =>
        text
          .setValue(String(this.plugin.settings.debounceMs))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.debounceMs = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName('Session timeout (ms)')
      .setDesc('Inactivity window before closing an edit session (Layer 2)')
      .addText(text =>
        text
          .setValue(String(this.plugin.settings.sessionTimeoutMs))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.sessionTimeoutMs = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName('Slack batch window (ms)')
      .setDesc('Time window for batching Slack messages (Layer 3)')
      .addText(text =>
        text
          .setValue(String(this.plugin.settings.slackBatchMs))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.slackBatchMs = num;
              await this.plugin.saveSettings();
            }
          })
      );

    // ── Inbox Routing ──
    this.renderInboxRoutingSection(containerEl);

    // ── Inbox Tasks ──
    this.renderInboxTasksSection(containerEl);

    // ── Ignore Paths ──
    containerEl.createEl('h3', { text: 'Ignore Paths' });

    new Setting(containerEl)
      .setName('Ignored paths')
      .setDesc('Paths to ignore (one per line). Directories end with /')
      .addTextArea(text =>
        text
          .setValue(this.plugin.settings.ignorePaths.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.ignorePaths = value
              .split('\n')
              .map(l => l.trim())
              .filter(l => l.length > 0);
            await this.plugin.saveSettings();
          })
      );

    // ── Key Export (for Chrome extension) ──
    if (this.plugin.settings.setupComplete) {
      containerEl.createEl('h3', { text: 'Key Export' });

      new Setting(containerEl)
        .setName('Export private key (for Chrome extension)')
        .setDesc('Copy this to set up the Chrome extension. Keep it secret!')
        .addButton(btn =>
          btn
            .setButtonText('Copy to Clipboard')
            .onClick(async () => {
              const keyData = JSON.stringify({
                memberId: this.plugin.settings.memberId,
                privateKeyX25519: this.plugin.settings.privateKeyX25519,
                privateKeyEd25519: this.plugin.settings.privateKeyEd25519,
              });
              await navigator.clipboard.writeText(keyData);
              new Notice('Private key copied to clipboard');
            })
        );
    }
  }

  private renderInboxRoutingSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Activity Sensitivity' });
    containerEl.createEl('p', {
      text: 'Tune what reaches the Activity tab. Applies to what you receive — doesn\'t change what you send.',
      cls: 'vault-watch-setup-status',
    });

    const r = this.plugin.settings.inboxRouting;

    new Setting(containerEl)
      .setName('Minimum edit size')
      .setDesc('Hide edits smaller than this many characters. They\'re still stored. Default: 20.')
      .addText(text =>
        text
          .setValue(String(r.activityMinCharDelta))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num >= 0) {
              r.activityMinCharDelta = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName('Hide trivial & sync edits')
      .setDesc('Hide whitespace-only edits and Relay CRDT sync artifacts.')
      .addToggle(toggle =>
        toggle.setValue(r.activityIgnoreTrivial).onChange(async (value) => {
          r.activityIgnoreTrivial = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Ignore path patterns')
      .setDesc('Glob patterns (one per line). Matching files are hidden from Activity. Example: Daily/**')
      .addTextArea(text =>
        text
          .setValue(r.activityIgnorePaths.join('\n'))
          .onChange(async (value) => {
            r.activityIgnorePaths = value
              .split('\n')
              .map(l => l.trim())
              .filter(l => l.length > 0);
            await this.plugin.saveSettings();
          })
      );

    const mutedContainer = containerEl.createDiv();
    mutedContainer.createEl('p', {
      text: 'Muted event types',
      attr: { style: 'font-weight: 600; margin: 12px 0 4px 0;' },
    });
    mutedContainer.createEl('p', {
      text: 'Completely suppress these event types from Activity.',
      cls: 'vault-watch-setup-status',
    });
    for (const et of ROUTABLE_EVENT_TYPES) {
      new Setting(mutedContainer)
        .setName(et.label)
        .addToggle(toggle =>
          toggle.setValue(r.mutedTypes.includes(et.id)).onChange(async (value) => {
            const set = new Set(r.mutedTypes);
            if (value) set.add(et.id); else set.delete(et.id);
            r.mutedTypes = Array.from(set);
            await this.plugin.saveSettings();
          })
        );
    }
  }

  private renderInboxTasksSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Inbox Tasks' });
    containerEl.createEl('p', {
      text: 'Surface a folder-based inbox (e.g. "0 - INBOX/Adam/1 - FOR REVIEW/") as an inbox view with one-click status transitions. Folder structure is the source of truth — no frontmatter required.',
      cls: 'vault-watch-setup-status',
    });

    const cfg = this.plugin.settings.inboxTasks;

    new Setting(containerEl)
      .setName('Enable Inbox Tasks')
      .setDesc('Adds a "Tasks" tab to the inbox view.')
      .addToggle(toggle =>
        toggle
          .setValue(cfg.enabled)
          .onChange(async (value) => {
            cfg.enabled = value;
            await this.plugin.saveSettings();
            if (value) {
              await this.plugin.taskScanner.scan();
            }
            this.display();
          })
      );

    if (!cfg.enabled) return;

    // ── Roots ──
    const rootsSetting = new Setting(containerEl)
      .setName('Inbox root folders')
      .setDesc('Vault-relative folder paths scanned for tasks (one per line).');
    rootsSetting.addTextArea(text =>
      text
        .setPlaceholder('0 - INBOX')
        .setValue(cfg.roots.join('\n'))
        .onChange(async (value) => {
          cfg.roots = value
            .split('\n')
            .map(s => s.trim().replace(/^\/+|\/+$/g, ''))
            .filter(s => s.length > 0);
          await this.plugin.saveSettings();
          await this.plugin.taskScanner.scan();
        })
    );

    new Setting(containerEl)
      .setName('Auto-detect inbox folders')
      .setDesc('Scan vault for top-level folders matching /inbox/i.')
      .addButton(btn =>
        btn.setButtonText('Detect').onClick(async () => {
          const candidates = this.plugin.taskScanner.detectCandidateRoots();
          if (candidates.length === 0) {
            new Notice('No inbox-like folders found at the vault root.');
            return;
          }
          // Merge with existing, de-dup
          const merged = Array.from(new Set([...cfg.roots, ...candidates]));
          cfg.roots = merged;
          await this.plugin.saveSettings();
          await this.plugin.taskScanner.scan();
          new Notice(`Added: ${candidates.join(', ')}`);
          this.display();
        })
      );

    // ── Scope ──
    new Setting(containerEl)
      .setName('Default perspective')
      .setDesc('Which tasks to show by default.')
      .addDropdown(dd =>
        dd
          .addOption('mine', 'Mine (tasks in my person folder)')
          .addOption('everyone', 'Everyone (all tasks)')
          .setValue(cfg.perspective)
          .onChange(async (value) => {
            cfg.perspective = value as 'mine' | 'everyone';
            await this.plugin.saveSettings();
          })
      );

    // ── Advanced ──
    containerEl.createEl('h4', { text: 'Advanced' });

    new Setting(containerEl)
      .setName('Status lane pattern (regex)')
      .setDesc('Folders matching this regex are treated as status lanes. Default: ^(\\d+)\\s*-\\s*(.+)$')
      .addText(text =>
        text
          .setValue(cfg.statusPattern)
          .onChange(async (value) => {
            cfg.statusPattern = value.trim() || '^(\\d+)\\s*-\\s*(.+)$';
            await this.plugin.saveSettings();
            await this.plugin.taskScanner.scan();
          })
      );

    new Setting(containerEl)
      .setName('Done lane name')
      .setDesc('Which lane is terminal. Blank = highest-ranked lane. Match by folder name or label.')
      .addText(text =>
        text
          .setPlaceholder('DONE')
          .setValue(cfg.doneLane || '')
          .onChange(async (value) => {
            cfg.doneLane = value.trim() || null;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Person folder overrides')
      .setDesc('One "memberId = folderName" per line, for when the person folder name differs from member displayName.')
      .addTextArea(text => {
        const entries = Object.entries(cfg.personFolderMap);
        text
          .setPlaceholder('adam = Adam\nangelo = Angelo')
          .setValue(entries.map(([k, v]) => `${k} = ${v}`).join('\n'))
          .onChange(async (value) => {
            const map: Record<string, string> = {};
            for (const line of value.split('\n')) {
              const m = line.match(/^\s*([^=\s]+)\s*=\s*(.+?)\s*$/);
              if (m) map[m[1]] = m[2];
            }
            cfg.personFolderMap = map;
            await this.plugin.saveSettings();
            await this.plugin.taskScanner.scan();
          });
      });
  }
}
