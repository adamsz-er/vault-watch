import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

export interface SealedPayload {
  ciphertext: string;    // Base64
  nonce: string;         // Base64
  ephemeralPub: string;  // Base64
}

/**
 * Encrypt a message for a specific recipient using their X25519 public key.
 * Uses ephemeral keypair for forward secrecy (NaCl box).
 */
export function sealForRecipient(
  plaintext: string,
  recipientX25519Pub: string
): SealedPayload {
  const recipientPub = decodeBase64(recipientX25519Pub);
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = new TextEncoder().encode(plaintext);

  const ciphertext = nacl.box(
    messageBytes,
    nonce,
    recipientPub,
    ephemeral.secretKey
  );

  if (!ciphertext) {
    throw new Error('Encryption failed');
  }

  return {
    ciphertext: encodeBase64(ciphertext),
    nonce: encodeBase64(nonce),
    ephemeralPub: encodeBase64(ephemeral.publicKey),
  };
}

/**
 * Encrypt a notification event for multiple recipients.
 * Returns a map of recipientId -> SealedPayload.
 */
export function sealForRecipients(
  plaintext: string,
  recipients: Map<string, string>  // memberId -> X25519 public key (base64)
): Map<string, SealedPayload> {
  const result = new Map<string, SealedPayload>();

  for (const [memberId, pubKey] of recipients) {
    result.set(memberId, sealForRecipient(plaintext, pubKey));
  }

  return result;
}
