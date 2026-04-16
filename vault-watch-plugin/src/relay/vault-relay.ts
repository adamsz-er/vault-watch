import { Vault, TFile, TFolder, EventRef } from 'obsidian';
import type {
  NotificationEvent,
  NotificationEnvelope,
  VaultWatchSettings,
} from '../types';
import { OUTBOX_DIR, OUTBOX_TTL_MS, MEMBERS_FILE } from '../types';
import { sealForRecipient } from '../crypto/encrypt';
import { signEvent } from '../crypto/identity';
import { unseal } from '../crypto/decrypt';
import { verifySignature, isTimestampValid } from '../crypto/identity';
import type { MemberRegistryManager } from '../members/registry';
import type { InboxStore } from '../inbox/inbox-store';

const MAX_PROCESSED_IDS = 500;

export class VaultRelay {
  private eventRef: EventRef | null = null;
  private processedIds = new Set<string>();

  constructor(
    private vault: Vault,
    private settings: VaultWatchSettings,
    private memberRegistry: MemberRegistryManager,
    private inboxStore: InboxStore
  ) {}

  async dispatch(event: NotificationEvent): Promise<void> {
    if (!this.settings.privateKeyEd25519) {
      console.warn('[vault-watch] No signing key, cannot dispatch');
      return;
    }

    const allKeys = await this.memberRegistry.getAllPublicKeys();

    for (const recipientId of event.recipients) {
      const recipientKeys = allKeys.get(recipientId);
      if (!recipientKeys) {
        console.warn(`[vault-watch] No public key for ${recipientId}, skipping`);
        continue;
      }

      const plaintext = JSON.stringify(event);
      const sealed = sealForRecipient(plaintext, recipientKeys.x25519);

      const sig = signEvent(
        event.id,
        event.ts,
        sealed.ciphertext,
        this.settings.privateKeyEd25519
      );

      const envelope: NotificationEnvelope = {
        v: 1,
        id: event.id,
        ts: event.ts,
        sender: event.sender.id,
        recipients: [recipientId],
        payload: sealed.ciphertext,
        sig,
        nonce: sealed.nonce,
        ephemeralPub: sealed.ephemeralPub,
      };

      const filePath = `${OUTBOX_DIR}/${event.id}-${recipientId}.json`;
      try {
        await this.vault.create(filePath, JSON.stringify(envelope, null, 2));
      } catch (err) {
        console.error(`[vault-watch] Failed to write outbox file:`, err);
      }
    }
  }

  startWatching(): void {
    this.eventRef = this.vault.on('create', async (file) => {
      if (file instanceof TFile && file.path.startsWith(OUTBOX_DIR + '/') && file.extension === 'json') {
        await this.processOutboxFile(file);
      }
    });

    // Process existing outbox files on startup (fire-and-forget is OK here, errors are caught inside)
    this.processExistingOutbox();
  }

  stopWatching(): void {
    if (this.eventRef) {
      this.vault.offref(this.eventRef);
      this.eventRef = null;
    }
  }

  async cleanupOutbox(): Promise<void> {
    const folder = this.vault.getAbstractFileByPath(OUTBOX_DIR);
    if (!(folder instanceof TFolder)) return;

    const now = Date.now();
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === 'json') {
        if (now - child.stat.mtime > OUTBOX_TTL_MS) {
          try {
            await this.vault.delete(child);
          } catch {
            // May already be deleted
          }
        }
      }
    }

    // Prune processedIds to prevent unbounded growth
    if (this.processedIds.size > MAX_PROCESSED_IDS) {
      const ids = Array.from(this.processedIds);
      this.processedIds = new Set(ids.slice(ids.length - MAX_PROCESSED_IDS));
    }
  }

  private async processExistingOutbox(): Promise<void> {
    const folder = this.vault.getAbstractFileByPath(OUTBOX_DIR);
    if (!(folder instanceof TFolder)) return;

    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === 'json') {
        await this.processOutboxFile(child);
      }
    }
  }

  private async processOutboxFile(file: TFile): Promise<void> {
    try {
      const content = await this.vault.read(file);
      const envelope = JSON.parse(content) as NotificationEnvelope;

      if (this.processedIds.has(envelope.id)) return;
      if (envelope.sender === this.settings.memberId) return;
      if (!envelope.recipients.includes(this.settings.memberId)) return;

      if (!isTimestampValid(envelope.ts, OUTBOX_TTL_MS)) {
        console.warn(`[vault-watch] Envelope ${envelope.id} has expired timestamp`);
        return;
      }

      const senderKeys = await this.memberRegistry.loadPublicKeys(envelope.sender);
      if (!senderKeys) {
        console.warn(`[vault-watch] No public key for sender ${envelope.sender}`);
        return;
      }

      const valid = verifySignature(
        envelope.id,
        envelope.ts,
        envelope.payload,
        envelope.sig,
        senderKeys.ed25519
      );
      if (!valid) {
        console.warn(`[vault-watch] Invalid signature on envelope ${envelope.id}`);
        return;
      }

      if (!this.settings.privateKeyX25519) {
        console.warn('[vault-watch] No decryption key configured');
        return;
      }

      const plaintext = unseal(
        {
          ciphertext: envelope.payload,
          nonce: envelope.nonce,
          ephemeralPub: envelope.ephemeralPub,
        },
        this.settings.privateKeyX25519
      );

      const event = JSON.parse(plaintext) as NotificationEvent;

      this.processedIds.add(envelope.id);
      await this.inboxStore.addItem(event);

    } catch (err) {
      console.error(`[vault-watch] Error processing outbox file ${file.path}:`, err);
    }
  }
}
