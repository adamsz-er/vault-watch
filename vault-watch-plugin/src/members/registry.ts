import { Vault, TFile, TFolder } from 'obsidian';
import type { MemberRegistry, Member, PublicKeyBundle } from '../types';
import { MEMBERS_FILE, MEMBERS_DIR, KEYS_DIR, VAULT_WATCH_DIR, INBOX_DIR, OUTBOX_DIR } from '../types';
import { serializePublicKeys, deserializePublicKeys } from '../crypto/keys';

/**
 * Per-member file registry. Each member writes only their own file
 * (members/{id}.json), eliminating CRDT merge conflicts.
 * Falls back to legacy members.json and auto-migrates.
 */
export class MemberRegistryManager {
  private members: Map<string, Member> = new Map();

  constructor(private vault: Vault) {}

  getMembers(): Member[] {
    return Array.from(this.members.values());
  }

  getMember(id: string): Member | undefined {
    return this.members.get(id);
  }

  async initialize(): Promise<void> {
    await this.ensureDirectoryStructure();
    await this.loadRegistry();
    await this.migrateFromLegacy();
  }

  async loadRegistry(): Promise<void> {
    this.members.clear();

    // Scan per-member files in members/ directory
    const folder = this.vault.getAbstractFileByPath(MEMBERS_DIR);
    if (folder instanceof TFolder) {
      for (const child of folder.children) {
        if (child instanceof TFile && child.extension === 'json') {
          try {
            const content = await this.vault.read(child);
            const member = JSON.parse(content) as Member;
            if (member.id) {
              this.members.set(member.id, member);
            }
          } catch {
            console.warn(`[vault-watch] Could not parse member file: ${child.path}`);
          }
        }
      }
    }
  }

  async registerMember(member: Member, pubKeys: PublicKeyBundle): Promise<void> {
    // Re-read all members from disk to pick up CRDT-synced entries
    await this.loadRegistry();

    // Write only this member's file (no conflict with other members)
    this.members.set(member.id, member);
    await this.saveMemberFile(member);

    await this.publishPublicKeys(pubKeys);
    await this.ensureMemberInbox(member.id);
  }

  async updateMember(id: string, updates: Partial<Member>): Promise<void> {
    const member = this.members.get(id);
    if (!member) throw new Error(`Member ${id} not found`);

    Object.assign(member, updates);
    await this.saveMemberFile(member);
  }

  async loadPublicKeys(memberId: string): Promise<PublicKeyBundle | null> {
    const path = `${KEYS_DIR}/${memberId}.pub`;
    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      try {
        const content = await this.vault.read(file);
        return deserializePublicKeys(content);
      } catch {
        return null;
      }
    }
    return null;
  }

  async getAllPublicKeys(): Promise<Map<string, PublicKeyBundle>> {
    const keys = new Map<string, PublicKeyBundle>();
    const folder = this.vault.getAbstractFileByPath(KEYS_DIR);

    if (folder instanceof TFolder) {
      for (const child of folder.children) {
        if (child instanceof TFile && child.extension === 'pub') {
          try {
            const content = await this.vault.read(child);
            const bundle = deserializePublicKeys(content);
            keys.set(bundle.memberId, bundle);
          } catch {
            // Skip corrupted key files
          }
        }
      }
    }

    return keys;
  }

  // ─── Private ───

  private async saveMemberFile(member: Member): Promise<void> {
    const path = `${MEMBERS_DIR}/${member.id}.json`;
    const content = JSON.stringify(member, null, 2);
    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.vault.modify(file, content);
    } else {
      await this.vault.create(path, content);
    }
  }

  private async publishPublicKeys(bundle: PublicKeyBundle): Promise<void> {
    const path = `${KEYS_DIR}/${bundle.memberId}.pub`;
    const content = serializePublicKeys(bundle);
    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.vault.modify(file, content);
    } else {
      await this.vault.create(path, content);
    }
  }

  private async ensureMemberInbox(memberId: string): Promise<void> {
    const inboxPath = `${INBOX_DIR}/${memberId}`;
    const folder = this.vault.getAbstractFileByPath(inboxPath);
    if (!folder) {
      await this.vault.create(`${inboxPath}/.gitkeep`, '');
    }
  }

  /**
   * Migrate from legacy single-file members.json to per-member files.
   * Reads members.json, writes individual files, then deletes the legacy file.
   */
  private async migrateFromLegacy(): Promise<void> {
    const file = this.vault.getAbstractFileByPath(MEMBERS_FILE);
    if (!(file instanceof TFile)) return;

    try {
      const content = await this.vault.read(file);
      const legacy = JSON.parse(content) as MemberRegistry;

      if (!legacy.members || legacy.members.length === 0) {
        // Empty legacy file, just remove it
        await this.vault.delete(file);
        return;
      }

      console.log(`[vault-watch] Migrating ${legacy.members.length} member(s) from members.json`);

      for (const member of legacy.members) {
        // Only migrate if we don't already have a newer per-member file
        if (!this.members.has(member.id)) {
          this.members.set(member.id, member);
          await this.saveMemberFile(member);
        }
      }

      // Remove legacy file after successful migration
      await this.vault.delete(file);
      console.log('[vault-watch] Migration complete, removed members.json');
    } catch (e) {
      console.warn('[vault-watch] Legacy migration failed, will retry next load:', e);
    }
  }

  private async ensureDirectoryStructure(): Promise<void> {
    const dirs = [VAULT_WATCH_DIR, MEMBERS_DIR, KEYS_DIR, OUTBOX_DIR, INBOX_DIR];

    for (const dir of dirs) {
      const folder = this.vault.getAbstractFileByPath(dir);
      if (!folder) {
        try {
          await this.vault.create(`${dir}/.gitkeep`, '');
        } catch {
          // Directory may already exist from another create
        }
      }
    }
  }
}
