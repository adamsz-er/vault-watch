import { requestUrl } from 'obsidian';
import type { NotificationEvent, VaultWatchSettings } from '../types';
import { sealForRecipient } from '../crypto/encrypt';
import type { MemberRegistryManager } from '../members/registry';
import { encodeBase64 } from 'tweetnacl-util';

export class SlackWebhook {
  constructor(
    private settings: VaultWatchSettings,
    private memberRegistry: MemberRegistryManager
  ) {}

  async sendSingle(event: NotificationEvent): Promise<void> {
    if (!this.settings.slackWebhookUrl) return;

    const encryptedPayload = await this.buildEncryptedPayload(event);
    const blocks = this.buildSingleBlocks(event, encryptedPayload);

    await this.postToSlack(blocks);
  }

  async sendBatch(events: NotificationEvent[]): Promise<void> {
    if (!this.settings.slackWebhookUrl || events.length === 0) return;

    const encryptedPayload = await this.buildBatchEncryptedPayload(events);
    const blocks = this.buildBatchBlocks(events, encryptedPayload);

    await this.postToSlack(blocks);
  }

  private buildSingleBlocks(event: NotificationEvent, encPayload: string): object[] {
    const blocks: object[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${event.sender.name}* ${this.actionVerb(event.type)} "${event.fileTitle}"`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `> ${event.change.summary}${
            event.mentionedMembers.length > 0
              ? `\n> ${event.mentionedMembers.map(m => `@${m}`).join(' ')} mentioned`
              : ''
          }`,
        },
      },
    ];

    // Encrypted payload as context block
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `vault-watch:v1:${encPayload}`,
        },
      ],
    });

    // Open in Obsidian button
    const obsidianUrl = `obsidian://open?vault=${encodeURIComponent(event.vault)}&file=${encodeURIComponent(event.filePath)}`;
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open in Obsidian' },
          url: obsidianUrl,
        },
      ],
    });

    return blocks;
  }

  private buildBatchBlocks(events: NotificationEvent[], encPayload: string): object[] {
    const sender = events[0].sender.name;
    const blocks: object[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${sender}* edited ${events.length} files`,
        },
      },
    ];

    // Summary for each file
    const summaryLines = events.map(e => {
      let line = `> *${e.fileTitle}*\n> ${e.change.summary}`;
      if (e.mentionedMembers.length > 0) {
        line += `, ${e.mentionedMembers.map(m => `@${m}`).join(' ')} mentioned`;
      }
      return line;
    });

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: summaryLines.join('\n\n'),
      },
    });

    // Encrypted payload
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `vault-watch:v1:${encPayload}`,
        },
      ],
    });

    // Open vault button
    const obsidianUrl = `obsidian://open?vault=${encodeURIComponent(events[0].vault)}`;
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open Vault' },
          url: obsidianUrl,
        },
      ],
    });

    return blocks;
  }

  private async buildEncryptedPayload(event: NotificationEvent): Promise<string> {
    return this.encryptForAllRecipients(JSON.stringify(event));
  }

  private async buildBatchEncryptedPayload(events: NotificationEvent[]): Promise<string> {
    return this.encryptForAllRecipients(JSON.stringify(events));
  }

  /**
   * Encrypt payload for all non-sender members.
   * For Slack, we encrypt for the first non-sender recipient.
   * (2-person team = one recipient).
   */
  private async encryptForAllRecipients(plaintext: string): Promise<string> {
    const allKeys = await this.memberRegistry.getAllPublicKeys();
    // Find first recipient (non-self)
    for (const [memberId, keys] of allKeys) {
      if (memberId !== this.settings.memberId) {
        const sealed = sealForRecipient(plaintext, keys.x25519);
        // Compact format: nonce.ephemeralPub.ciphertext
        return `${sealed.nonce}.${sealed.ephemeralPub}.${sealed.ciphertext}`;
      }
    }
    return '';
  }

  private async postToSlack(blocks: object[]): Promise<void> {
    try {
      await requestUrl({
        url: this.settings.slackWebhookUrl,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks }),
      });
    } catch (err) {
      console.error('[vault-watch] Slack webhook failed:', err);
    }
  }

  private actionVerb(type: string): string {
    switch (type) {
      case 'file_created': return 'created';
      case 'file_deleted': return 'deleted';
      case 'file_renamed': return 'renamed';
      case 'mention': return 'mentioned you in';
      default: return 'edited';
    }
  }
}
