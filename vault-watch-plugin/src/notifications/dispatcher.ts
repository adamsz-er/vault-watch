import type { NotificationEvent } from '../types';
import type { CoalescerSink } from '../watcher/coalescer';
import type { VaultRelay } from '../relay/vault-relay';
import type { SlackWebhook } from '../relay/slack-webhook';

/**
 * Routes notification events to vault relay and Slack.
 * Implements CoalescerSink so the coalescer can dispatch through it.
 */
export class Dispatcher implements CoalescerSink {
  constructor(
    private vaultRelay: VaultRelay,
    private slackWebhook: SlackWebhook
  ) {}

  async dispatchToVault(event: NotificationEvent): Promise<void> {
    await this.vaultRelay.dispatch(event);
  }

  async sendSlackSingle(event: NotificationEvent): Promise<void> {
    await this.slackWebhook.sendSingle(event);
  }

  async sendSlackBatch(events: NotificationEvent[]): Promise<void> {
    await this.slackWebhook.sendBatch(events);
  }
}
