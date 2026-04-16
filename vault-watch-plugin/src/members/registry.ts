import { Vault, TFile, TFolder } from 'obsidian';
import type { MemberRegistry, Member, PublicKeyBundle } from '../types';
import { MEMBERS_DIR, KEYS_DIR, VAULT_WATCH_DIR, INBOX_DIR, OUTBOX_DIR } from '../types';
import { serializePublicKeys, deserializePublicKeys } from '../crypto/keys';

/**
 * Per-member file registry. Each member owns their own file
 * (members/{id}.json), so CRDT sync never causes conflicts.
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
    await this.ensureDirectories();
    await this.loadAll();
    console.log(`[vault-watch] Registry ready: ${this.members.size} member(s)`);
  }

  async reload(): Promise<void> {
    await this.loadAll();
  }

  async registerMember(member: Member, pubKeys: PublicKeyBundle): Promise<void> {
    await this.loadAll();
    this.members.set(member.id, member);
    await this.writeMemberFile(member);
    await this.writePublicKey(pubKeys);
    await this.ensureInbox(member.id);
  }

  async updateMember(id: string, updates: Partial<Member>): Promise<void> {
    const member = this.members.get(id);
    if (!member) throw new Error(`Member ${id} not found`);
    Object.assign(member, updates);
    await this.writeMemberFile(member);
  }

  async loadPublicKeys(memberId: string): Promise<PublicKeyBundle | null> {
    const member = this.members.get(memberId);
    if (member?.pubKeyEd25519 && member?.pubKeyX25519) {
      return {
        memberId,
        ed25519: member.pubKeyEd25519,
        x25519: member.pubKeyX25519,
        publishedAt: member.joinedAt,
      };
    }
    const path = `${KEYS_DIR}/${memberId}.pub`;
    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      try {
        return deserializePublicKeys(await this.vault.read(file));
      } catch { return null; }
    }
    return null;
  }

  async getAllPublicKeys(): Promise<Map<string, PublicKeyBundle>> {
    const keys = new Map<string, PublicKeyBundle>();
    for (const [id, m] of this.members) {
      if (m.pubKeyEd25519 && m.pubKeyX25519) {
        keys.set(id, { memberId: id, ed25519: m.pubKeyEd25519, x25519: m.pubKeyX25519, publishedAt: m.joinedAt });
      }
    }
    return keys;
  }

  // ─── Private ───

  private async loadAll(): Promise<void> {
    this.members.clear();
    const dir = this.vault.getAbstractFileByPath(MEMBERS_DIR);
    if (dir instanceof TFolder) {
      for (const child of dir.children) {
        if (child instanceof TFile && child.extension === 'json') {
          try {
            const member = JSON.parse(await this.vault.read(child)) as Member;
            if (member.id) this.members.set(member.id, member);
          } catch { /* skip bad files */ }
        }
      }
    }
  }

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
