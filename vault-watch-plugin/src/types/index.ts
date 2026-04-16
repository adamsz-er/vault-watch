// ─── Notification Events ───

export type EventType =
  | 'file_changed'
  | 'file_created'
  | 'file_deleted'
  | 'file_renamed'
  | 'mention'
  | 'task_assigned'
  | 'share'
  | 'reaction';

export type Priority = 'low' | 'normal' | 'high';

export type ChangeClassification =
  | 'content_added'
  | 'content_removed'
  | 'heading_changed'
  | 'task_toggled'
  | 'mention_added'
  | 'tag_added'
  | 'trivial'
  | 'sync_artifact';

export interface ChangeAnalysis {
  changeType: ChangeClassification;
  summary: string;
  affectedHeadings: string[];
  charDelta: number;
  addedExcerpt?: string;
  isSignificant: boolean;
  mentionedMembers: string[];
  addedTags: string[];
}

export interface NotificationEvent {
  id: string;              // ULID
  v: 1;
  type: EventType;
  ts: number;              // Unix ms
  sender: { id: string; name: string };
  vault: string;
  filePath: string;
  fileTitle: string;
  oldPath?: string;
  change: {
    changeType: string;
    summary: string;
    affectedHeadings: string[];
    charDelta: number;
    addedExcerpt?: string;
    coalescedCount: number;
  };
  recipients: string[];
  mentionedMembers: string[];
  priority: Priority;
  tags?: string[];
}

// ─── Encryption Envelope ───

export interface NotificationEnvelope {
  v: 1;
  id: string;              // ULID
  ts: number;
  sender: string;          // Member ID
  recipients: string[];
  payload: string;         // Base64(sealed_box(NotificationEvent))
  sig: string;             // Ed25519 signature
  nonce: string;           // Base64(24-byte nonce)
  ephemeralPub: string;    // Base64(ephemeral X25519 public key)
}

// ─── Members ───

export interface MemberPrefs {
  notifyOn: EventType[];
  slackEnabled: boolean;
  minPriority: Priority;
}

export interface Member {
  id: string;
  displayName: string;
  pubKeyEd25519: string;   // Base64
  pubKeyX25519: string;    // Base64
  slackUserId?: string;
  joinedAt: number;
  prefs: MemberPrefs;
}

export interface MemberRegistry {
  v: 1;
  members: Member[];
}

// ─── Inbox ───

export type InboxItemStatus = 'unread' | 'read' | 'archived' | 'starred';

export interface InboxItem {
  id: string;
  event: NotificationEvent;
  status: InboxItemStatus;
  receivedAt: number;
  readAt?: number;
  snoozedUntil?: number;
  reactions?: { emoji: string; from: string; ts: number }[];
}

export type InboxFilter = 'all' | 'mentions' | 'changes';

// ─── Watcher ───

export interface EditSession {
  filePath: string;
  firstContent: string;
  latestContent: string;
  firstEventTs: number;
  changeCount: number;
  sessionTimer: ReturnType<typeof setTimeout>;
}

export interface SlackBatch {
  events: NotificationEvent[];
  windowTimer: ReturnType<typeof setTimeout>;
  hasHighPriority: boolean;
}

// ─── Settings ───

export interface VaultWatchSettings {
  memberId: string;
  displayName: string;
  vaultName: string;
  slackWebhookUrl: string;
  slackEnabled: boolean;
  watchPath: string;
  ignorePaths: string[];
  debounceMs: number;
  sessionTimeoutMs: number;
  slackBatchMs: number;
  minPriority: Priority;
  privateKeyEd25519?: string;
  privateKeyX25519?: string;
  setupComplete: boolean;
  soundEnabled: boolean;
  soundVolume: number;              // 0-1
  doNotDisturb: boolean;
}

export const DEFAULT_SETTINGS: VaultWatchSettings = {
  memberId: '',
  displayName: '',
  vaultName: '',
  slackWebhookUrl: '',
  slackEnabled: false,
  watchPath: '',
  ignorePaths: [
    '.obsidian/',
    'Z_Meta/.vault-watch/',
    '.trash/',
    'templates/',
  ],
  debounceMs: 2000,
  sessionTimeoutMs: 30000,
  slackBatchMs: 300000,
  minPriority: 'normal',
  setupComplete: false,
  soundEnabled: true,
  soundVolume: 0.5,
  doNotDisturb: false,
};

export type ReactionEmoji = '👍' | '✅' | '👀' | '❗';
export const REACTION_EMOJIS: ReactionEmoji[] = ['👍', '✅', '👀', '❗'];

// ─── Crypto Keys ───

export interface PublicKeyBundle {
  memberId: string;
  ed25519: string;         // Base64
  x25519: string;          // Base64
  publishedAt: number;
}

// ─── Constants ───

export const VAULT_WATCH_DIR = 'Z_Meta/.vault-watch';
export const MEMBERS_FILE = `${VAULT_WATCH_DIR}/members.json`; // Legacy, kept for migration
export const MEMBERS_DIR = `${VAULT_WATCH_DIR}/members`;
export const KEYS_DIR = `${VAULT_WATCH_DIR}/keys`;
export const OUTBOX_DIR = `${VAULT_WATCH_DIR}/outbox`;
export const INBOX_DIR = `${VAULT_WATCH_DIR}/inbox`;
export const CONFIG_FILE = `${VAULT_WATCH_DIR}/config.json`;
export const INBOX_VIEW_TYPE = 'vault-watch-inbox';
export const OUTBOX_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
