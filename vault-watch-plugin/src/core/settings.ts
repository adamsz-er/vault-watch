import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type { VaultWatchSettings } from '../types';
import { generateKeySet, createPublicKeyBundle } from '../crypto/keys';
import type VaultWatchPlugin from './plugin';

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
}
