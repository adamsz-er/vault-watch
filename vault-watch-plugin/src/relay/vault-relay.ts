import { Vault, TFile, TFolder, EventRef } from 'obsidian';
import type {
  NotificationEvent,
  NotificationEnvelope,
  VaultWatchSettings,
  PublicKeyBundle,
} from '../types';
import { OUTBOX_DIR, INBOX_DIR, OUTBOX_TTL_MS } from '../types';
import { sealForRecipient } from '../crypto/encrypt';
import { signEvent } from '../crypto/identity';
import { unseal } from '../crypto/decrypt';
import { verifySignature, isTimestampValid } from '../crypto/identity';
import type { MemberRegistryManager } from '../members/registry';
import type { InboxStore } from '../inbox/inbox-store';

export class VaultRelay {
  private eventRef: EventRef | null = null;
  private processedIds = new Set<string>();

  constructor(
    private vault: Vault,
    private settings: VaultWatchSettings,
    private memberRegistry: MemberRegistryManager,
    private inboxStore: InboxStore
  ) {}

  /**
   * Write an encrypted notification event to the outbox.
   * One envelope per recipient so each can decrypt independently.
   */
  async dispatch(event: NotificationEvent): Promise<void> {
    const allKeys = await this.memberRegistry.getAllPublicKeys();

    for (const recipientId of event.recipients) {
      const recipientKeys = allKeys.get(recipientId);
      if (!recipientKeys) {
        console.warn(`[vault-watch] No public key for ${recipientId}, skipping`);
        continue;
      }

      const plaintext = JSON.stringify(event);
      const sealed = sealForRecipient(plaintext, recipientKeys.x25519);

      // Sign: eventId + timestamp + ciphertext
      const sig = signEvent(
        event.id,
        event.ts,
        sealed.ciphertext,
        this.settings.privateKeyEd25519!
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
      await this.vault.create(filePath, JSON.stringify(envelope, null, 2));
    }
  }

  /**
   * Start watching the outbox for new files (from other members via Relay sync).
   */
  startWatching(): void {
    this.eventRef = this.vault.on('create', async (file) => {
      if (file instanceof TFile && file.path.startsWith(OUTBOX_DIR + '/') && file.extension === 'json') {
        await this.processOutboxFile(file);
      }
    });

    // Also process any existing outbox files on startup
    this.processExistingOutbox();
  }

  stopWatching(): void {
    if (this.eventRef) {
      this.vault.offref(this.eventRef);
      this.eventRef = null;
    }
  }

  /**
   * Clean up outbox files older than TTL.
   */
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

      // Skip if already processed
      if (this.processedIds.has(envelope.id)) return;

      // Skip if I'm the sender (my own outbox files)
      if (envelope.sender === this.settings.memberId) return;

      // Skip if I'm not a recipient
      if (!envelope.recipients.includes(this.settings.memberId)) return;

      // Validate timestamp (5-min window is too strict for relay sync, use 24h)
      if (!isTimestampValid(envelope.ts, OUTBOX_TTL_MS)) {
        console.warn(`[vault-watch] Envelope ${envelope.id} has expired timestamp`);
        return;
      }

      // Verify sender signature
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

      // Decrypt
      const plaintext = unseal(
        {
          ciphertext: envelope.payload,
          nonce: envelope.nonce,
          ephemeralPub: envelope.ephemeralPub,
        },
        this.settings.privateKeyX25519!
      );

      const event = JSON.parse(plaintext) as NotificationEvent;

      // Add to inbox
      this.processedIds.add(envelope.id);
      await this.inboxStore.addItem(event);

    } catch (err) {
      console.error(`[vault-watch] Error processing outbox file ${file.path}:`, err);
    }
  }
}
