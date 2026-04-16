import nacl from 'tweetnacl';
import { decodeBase64 } from 'tweetnacl-util';

export interface SealedPayload {
  ciphertext: string;
  nonce: string;
  ephemeralPub: string;
}

/**
 * Decrypt a sealed payload using the recipient's X25519 private key.
 * Shared between Obsidian plugin and Chrome extension.
 */
export function unseal(sealed: SealedPayload, recipientX25519Secret: string): string {
  const ciphertext = decodeBase64(sealed.ciphertext);
  const nonce = decodeBase64(sealed.nonce);
  const ephemeralPub = decodeBase64(sealed.ephemeralPub);
  const secretKey = decodeBase64(recipientX25519Secret);

  const plaintext = nacl.box.open(ciphertext, nonce, ephemeralPub, secretKey);

  if (!plaintext) {
    throw new Error('Decryption failed');
  }

  return new TextDecoder().decode(plaintext);
}

/**
 * Parse the compact vault-watch payload format: nonce.ephemeralPub.ciphertext
 */
export function parseCompactPayload(raw: string): SealedPayload {
  const parts = raw.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid payload format');
  }
  return {
    nonce: parts[0],
    ephemeralPub: parts[1],
    ciphertext: parts[2],
  };
}
