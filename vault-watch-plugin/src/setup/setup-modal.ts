import { App, Modal, Notice, TFile, TFolder } from 'obsidian';
import { MEMBERS_DIR } from '../types';

export interface SetupFormResult {
  memberId: string;
  displayName: string;
}

function sanitizeId(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);
}

export class SetupModal extends Modal {
  private memberId: string;
  private displayName: string;
  private memberIdManuallySet: boolean;
  private idInput!: HTMLInputElement;
  private statusEl!: HTMLElement;
  private submitBtn!: HTMLButtonElement;

  constructor(
    app: App,
    defaultDisplayName: string,
    defaultMemberId: string,
    private onSubmit: (result: SetupFormResult) => Promise<void>
  ) {
    super(app);
    this.displayName = defaultDisplayName;
    this.memberId = defaultMemberId || sanitizeId(defaultDisplayName);
    this.memberIdManuallySet = Boolean(defaultMemberId);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vw-setup-modal');

    contentEl.createEl('h2', { text: 'Welcome to Vault Watch', cls: 'vw-setup-title' });
    contentEl.createEl('p', {
      text: 'Pick a display name and member ID to join your team. Your keys are generated on this device — end-to-end encrypted, no central server.',
      cls: 'vw-setup-subtitle',
    });

    const existing = this.listExistingMembers();
    if (existing.length > 0) {
      const row = contentEl.createDiv({ cls: 'vw-setup-existing' });
      row.createSpan({ text: 'Already on this vault: ', cls: 'vw-setup-existing-label' });
      row.createSpan({ text: existing.join(', '), cls: 'vw-setup-existing-list' });
    }

    // Display name
    const nameField = contentEl.createDiv({ cls: 'vw-setup-field' });
    nameField.createEl('label', { text: 'Display name', attr: { for: 'vw-setup-name' } });
    const nameInput = nameField.createEl('input', {
      type: 'text',
      attr: { id: 'vw-setup-name', placeholder: 'e.g. Matthew' },
    });
    nameInput.value = this.displayName;
    nameInput.addEventListener('input', () => {
      this.displayName = nameInput.value;
      if (!this.memberIdManuallySet) {
        this.memberId = sanitizeId(nameInput.value);
        this.idInput.value = this.memberId;
      }
      this.refreshStatus();
    });

    // Member ID
    const idField = contentEl.createDiv({ cls: 'vw-setup-field' });
    idField.createEl('label', { text: 'Member ID', attr: { for: 'vw-setup-id' } });
    idField.createEl('div', {
      cls: 'vw-setup-field-hint',
      text: 'Lowercase, no spaces — used in @mentions and as your filename.',
    });
    this.idInput = idField.createEl('input', {
      type: 'text',
      attr: { id: 'vw-setup-id', placeholder: 'e.g. matthew' },
    });
    this.idInput.value = this.memberId;
    this.idInput.addEventListener('input', () => {
      const sanitized = sanitizeId(this.idInput.value);
      if (this.idInput.value !== sanitized) this.idInput.value = sanitized;
      this.memberId = sanitized;
      this.memberIdManuallySet = true;
      this.refreshStatus();
    });
    this.statusEl = idField.createDiv({ cls: 'vw-setup-status' });

    // Actions
    const actions = contentEl.createDiv({ cls: 'vw-setup-actions' });
    const later = actions.createEl('button', { text: 'Later', cls: 'vw-setup-later' });
    later.addEventListener('click', () => this.close());
    this.submitBtn = actions.createEl('button', { text: 'Join team', cls: 'mod-cta' });
    this.submitBtn.addEventListener('click', () => void this.handleSubmit());

    // Focus: if name already filled, jump to id; else start at name
    (this.displayName.trim() ? this.idInput : nameInput).focus();
    this.refreshStatus();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private listExistingMembers(): string[] {
    const dir = this.app.vault.getAbstractFileByPath(MEMBERS_DIR);
    if (!(dir instanceof TFolder)) return [];
    const ids: string[] = [];
    for (const child of dir.children) {
      if (child instanceof TFile && child.extension === 'json' && child.basename !== '_dir') {
        ids.push(child.basename);
      }
    }
    return ids.sort();
  }

  private refreshStatus(): void {
    this.statusEl.empty();
    let ready = true;

    if (!this.displayName.trim()) {
      this.statusEl.createSpan({ text: 'Enter a display name above', cls: 'vw-setup-status-muted' });
      ready = false;
    } else if (!this.memberId) {
      this.statusEl.createSpan({ text: 'Enter a member ID', cls: 'vw-setup-status-error' });
      ready = false;
    } else if (this.app.vault.getAbstractFileByPath(`${MEMBERS_DIR}/${this.memberId}.json`)) {
      this.statusEl.createSpan({ text: `"${this.memberId}" is already taken`, cls: 'vw-setup-status-error' });
      ready = false;
    } else {
      this.statusEl.createSpan({ text: `"${this.memberId}" is available`, cls: 'vw-setup-status-ok' });
    }

    this.submitBtn.disabled = !ready;
  }

  private async handleSubmit(): Promise<void> {
    this.submitBtn.disabled = true;
    const originalText = this.submitBtn.textContent || 'Join team';
    this.submitBtn.setText('Setting up…');
    try {
      await this.onSubmit({
        memberId: this.memberId,
        displayName: this.displayName.trim(),
      });
      this.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Setup failed: ${msg}`, 6000);
      this.submitBtn.disabled = false;
      this.submitBtn.setText(originalText);
    }
  }
}
