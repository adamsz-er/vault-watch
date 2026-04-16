import { Vault, TFile, TFolder } from 'obsidian';
import type { MemberRegistry, Member, PublicKeyBundle } from '../types';
import { MEMBERS_FILE, MEMBERS_DIR, KEYS_DIR, VAULT_WATCH_DIR, INBOX_DIR, OUTBOX_DIR } from '../types';
import { serializePublicKeys, deserializePublicKeys } from '../crypto/keys';

/**
 * Per-member file registry. Each member owns their own file
 * (members/{id}.json), so CRDT sync never causes conflicts.
 *
 * Also reads legacy members.json as fallback until migration completes.
 * Public keys are read from both Member files and legacy .pub files.
 */
export class MemberRegistryManager {
  private members: Map<string, Member> = new Map();
  private initialized = false;

  constructor(private vault: Vault) {}

  getMembers(): Member[] {
    return Array.from(this.members.values());
  }

  getMember(id: string): Member | undefined {
    return this.members.get(id);
  }

  /**
   * Call once when vault is ready (onLayoutReady), not during onload.
   */
  async initialize(): Promise<void> {
    await this.ensureDirectories();
    await this.loadAll();
    await this.migrateLegacy();
    this.initialized = true;
    console.log(`[vault-watch] Registry ready: ${this.members.size} member(s)`);
  }

  /**
   * Reload all members from disk. Safe to call anytime after initialize.
   */
  async reload(): Promise<void> {
    await this.loadAll();
  }

  async registerMember(member: Member, pubKeys: PublicKeyBundle): Promise<void> {
    if (!this.initialized) await this.initialize();

    // Reload to pick up any CRDT-synced members
    await this.loadAll();

    this.members.set(member.id, member);
    await this.writeMemberFile(member);
    await this.writePublicKey(pubKeys);
    await this.ensureInbox(member.id);

    // Migrate legacy if still present
    await this.migrateLegacy();
  }

  async updateMember(id: string, updates: Partial<Member>): Promise<void> {
    const member = this.members.get(id);
    if (!member) throw new Error(`Member ${id} not found`);
    Object.assign(member, updates);
    await this.writeMemberFile(member);
  }

  /**
   * Get public keys for a single member.
   * Reads from member file first, falls back to legacy .pub file.
   */
  async loadPublicKeys(memberId: string): Promise<PublicKeyBundle | null> {
    // Try member file first (canonical source)
    const member = this.members.get(memberId);
    if (member?.pubKeyEd25519 && member?.pubKeyX25519) {
      return {
        memberId,
        ed25519: member.pubKeyEd25519,
        x25519: member.pubKeyX25519,
        publishedAt: member.joinedAt,
      };
    }

    // Fallback: legacy .pub file
    return this.readPubFile(memberId);
  }

  /**
   * Get all public keys for all known members.
   */
  async getAllPublicKeys(): Promise<Map<string, PublicKeyBundle>> {
    const keys = new Map<string, PublicKeyBundle>();

    // From member registry (canonical)
    for (const [id, member] of this.members) {
      if (member.pubKeyEd25519 && member.pubKeyX25519) {
        keys.set(id, {
          memberId: id,
          ed25519: member.pubKeyEd25519,
          x25519: member.pubKeyX25519,
          publishedAt: member.joinedAt,
        });
      }
    }

    // Fill gaps from legacy .pub files
    const keysDir = this.vault.getAbstractFileByPath(KEYS_DIR);
    if (keysDir instanceof TFolder) {
      for (const child of keysDir.children) {
        if (child instanceof TFile && child.extension === 'pub') {
          const id = child.basename;
          if (!keys.has(id)) {
            try {
              const content = await this.vault.read(child);
              const bundle = deserializePublicKeys(content);
              keys.set(bundle.memberId, bundle);
            } catch { /* skip corrupted */ }
          }
        }
      }
    }

    return keys;
  }

  // ─── Private: Loading ───

  private async loadAll(): Promise<void> {
    this.members.clear();

    // 1. Legacy members.json (baseline, overwritten by per-member files)
    const legacyFile = this.vault.getAbstractFileByPath(MEMBERS_FILE);
    if (legacyFile instanceof TFile) {
      try {
        const content = await this.vault.read(legacyFile);
        const registry = JSON.parse(content) as MemberRegistry;
        for (const m of registry.members ?? []) {
          if (m.id) this.members.set(m.id, m);
        }
      } catch { /* ignore corrupt legacy */ }
    }

    // 2. Per-member files (authoritative, override legacy)
    const membersDir = this.vault.getAbstractFileByPath(MEMBERS_DIR);
    if (membersDir instanceof TFolder) {
      for (const child of membersDir.children) {
        if (child instanceof TFile && child.extension === 'json') {
          try {
            const content = await this.vault.read(child);
            const member = JSON.parse(content) as Member;
            if (member.id) this.members.set(member.id, member);
          } catch {
            console.warn(`[vault-watch] Bad member file: ${child.path}`);
          }
        }
      }
    }
  }

  // ─── Private: Writing ───

  private async writeMemberFile(member: Member): Promise<void> {
    const path = `${MEMBERS_DIR}/${member.id}.json`;
    const content = JSON.stringify(member, null, 2);
    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.vault.modify(file, content);
    } else {
      await this.vault.create(path, content);
    }
  }

  private async writePublicKey(bundle: PublicKeyBundle): Promise<void> {
    const path = `${KEYS_DIR}/${bundle.memberId}.pub`;
    const content = serializePublicKeys(bundle);
    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.vault.modify(file, content);
    } else {
      await this.vault.create(path, content);
    }
  }

  private async readPubFile(memberId: string): Promise<PublicKeyBundle | null> {
    const path = `${KEYS_DIR}/${memberId}.pub`;
    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      try {
        const content = await this.vault.read(file);
        return deserializePublicKeys(content);
      } catch { return null; }
    }
    return null;
  }

  // ─── Private: Migration ───

  private async migrateLegacy(): Promise<void> {
    const file = this.vault.getAbstractFileByPath(MEMBERS_FILE);
    if (!(file instanceof TFile)) return;

    try {
      const content = await this.vault.read(file);
      const legacy = JSON.parse(content) as MemberRegistry;
      if (!legacy.members?.length) {
        await this.vault.delete(file);
        return;
      }

      for (const member of legacy.members) {
        const perMemberPath = `${MEMBERS_DIR}/${member.id}.json`;
        if (!this.vault.getAbstractFileByPath(perMemberPath)) {
          await this.writeMemberFile(member);
          this.members.set(member.id, member);
        }
      }

      await this.vault.delete(file);
      console.log(`[vault-watch] Migrated ${legacy.members.length} member(s), removed members.json`);
    } catch (e) {
      console.warn('[vault-watch] Migration failed (will retry):', e);
    }
  }

  // ─── Private: Setup ───

  private async ensureInbox(memberId: string): Promise<void> {
    const path = `${INBOX_DIR}/${memberId}`;
    if (!this.vault.getAbstractFileByPath(path)) {
      await this.vault.create(`${path}/_dir`, '');
    }
  }

  private async ensureDirectories(): Promise<void> {
    for (const dir of [VAULT_WATCH_DIR, MEMBERS_DIR, KEYS_DIR, OUTBOX_DIR, INBOX_DIR]) {
      if (!this.vault.getAbstractFileByPath(dir)) {
        try { await this.vault.create(`${dir}/_dir`, ''); }
        catch { /* already exists */ }
      }
    }
  }
}
