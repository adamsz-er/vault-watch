import nacl from 'tweetnacl';
import { decodeBase64 } from 'tweetnacl-util';
import type { SealedPayload } from './encrypt';

/**
 * Decrypt a sealed payload using the recipient's X25519 private key.
 */
export function unseal(
  sealed: SealedPayload,
  recipientX25519Secret: string
): string {
  const ciphertext = decodeBase64(sealed.ciphertext);
  const nonce = decodeBase64(sealed.nonce);
  const ephemeralPub = decodeBase64(sealed.ephemeralPub);
  const secretKey = decodeBase64(recipientX25519Secret);

  const plaintext = nacl.box.open(
    ciphertext,
    nonce,
    ephemeralPub,
    secretKey
  );

  if (!plaintext) {
    throw new Error('Decryption failed -- invalid key or corrupted data');
  }

  return new TextDecoder().decode(plaintext);
}
