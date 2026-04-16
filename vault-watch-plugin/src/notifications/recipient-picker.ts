import { App, Modal, Setting } from 'obsidian';
import type { Member, Priority } from '../types';

export interface RecipientPickerResult {
  recipients: string[];
  priority: Priority;
  note: string;
}

/**
 * Modal for picking notification recipients and optional note/priority
 * when sending a file or folder to Vault Watch from the right-click menu.
 */
export class RecipientPickerModal extends Modal {
  private selected: Set<string>;
  private priority: Priority = 'normal';
  private note = '';
  private listEl!: HTMLElement;
  private resolved = false;

  constructor(
    app: App,
    private members: Member[],
    private title: string,
    private subtitle: string,
    private onSubmit: (result: RecipientPickerResult | null) => void
  ) {
    super(app);
    // Default: everyone
    this.selected = new Set(members.map(m => m.id));
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('vw-recipient-modal');
    contentEl.createEl('h2', { text: this.title });
    if (this.subtitle) {
      contentEl.createEl('p', { text: this.subtitle, cls: 'vw-recipient-subtitle' });
    }

    if (this.members.length === 0) {
      contentEl.createEl('p', {
        text: 'No other members registered yet. Run setup on another machine first.',
        cls: 'vw-recipient-empty',
      });
      contentEl.createDiv({ cls: 'vw-recipient-actions' }, (row) => {
        const close = row.createEl('button', { text: 'Close' });
        close.addEventListener('click', () => this.close());
      });
      return;
    }

    // "Everyone" toggle row
    const everyoneRow = contentEl.createDiv({ cls: 'vw-recipient-everyone' });
    const everyoneCb = everyoneRow.createEl('input', { type: 'checkbox' });
    everyoneCb.checked = this.selected.size === this.members.length;
    everyoneRow.createEl('label', { text: 'Everyone' });
    const everyoneCount = everyoneRow.createEl('span', {
      text: `${this.members.length} member${this.members.length !== 1 ? 's' : ''}`,
      cls: 'vw-recipient-count',
    });
    everyoneCb.addEventListener('change', () => {
      if (everyoneCb.checked) {
        this.selected = new Set(this.members.map(m => m.id));
      } else {
        this.selected.clear();
      }
      this.renderMembers();
      this.updateSendEnabled();
    });
    // Store reference so renderMembers can sync the everyone checkbox too
    (this as any)._everyoneCb = everyoneCb;
    (this as any)._everyoneCount = everyoneCount;

    // Per-member list
    this.listEl = contentEl.createDiv({ cls: 'vw-recipient-list' });
    this.renderMembers();

    // Priority picker
    new Setting(contentEl)
      .setName('Priority')
      .setDesc('High priority bypasses the 5-minute Slack batch window.')
      .addDropdown(dd =>
        dd
          .addOption('low', 'Low')
          .addOption('normal', 'Normal')
          .addOption('high', 'High')
          .setValue(this.priority)
          .onChange((v) => { this.priority = v as Priority; })
      );

    // Optional note
    new Setting(contentEl)
      .setName('Note (optional)')
      .setDesc('A short message included with the notification.')
      .addText(text =>
        text
          .setPlaceholder('Can you review this?')
          .onChange((v) => { this.note = v; })
      );

    // Action buttons
    const actions = contentEl.createDiv({ cls: 'vw-recipient-actions' });
    const cancel = actions.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
    const sendBtn = actions.createEl('button', {
      text: 'Send',
      cls: 'mod-cta',
    });
    sendBtn.addEventListener('click', () => {
      if (this.selected.size === 0) return;
      this.resolved = true;
      this.onSubmit({
        recipients: [...this.selected],
        priority: this.priority,
        note: this.note.trim(),
      });
      this.close();
    });
    (this as any)._sendBtn = sendBtn;
    this.updateSendEnabled();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.onSubmit(null);
  }

  private renderMembers(): void {
    this.listEl.empty();
    for (const m of this.members) {
      const row = this.listEl.createDiv({ cls: 'vw-recipient-row' });
      const cb = row.createEl('input', { type: 'checkbox' });
      cb.checked = this.selected.has(m.id);
      cb.addEventListener('change', () => {
        if (cb.checked) this.selected.add(m.id);
        else this.selected.delete(m.id);
        this.syncEveryoneCheckbox();
        this.updateSendEnabled();
      });
      const label = row.createEl('label');
      label.createSpan({ text: this.initials(m.displayName), cls: 'vw-recipient-avatar' });
      label.createSpan({ text: m.displayName, cls: 'vw-recipient-name' });
      label.createSpan({ text: `@${m.id}`, cls: 'vw-recipient-id' });
      label.addEventListener('click', (e) => {
        e.preventDefault();
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      });
    }
  }

  private syncEveryoneCheckbox(): void {
    const cb = (this as any)._everyoneCb as HTMLInputElement | undefined;
    if (cb) cb.checked = this.selected.size === this.members.length;
  }

  private updateSendEnabled(): void {
    const btn = (this as any)._sendBtn as HTMLButtonElement | undefined;
    if (!btn) return;
    const n = this.selected.size;
    btn.disabled = n === 0;
    btn.setText(n === 0 ? 'Send' : n === this.members.length ? `Send to everyone` : `Send to ${n}`);
  }

  private initials(name: string): string {
    if (!name) return '?';
    return name.split(/\s+/).filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2);
  }
}
