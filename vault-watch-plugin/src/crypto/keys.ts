import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import type { PublicKeyBundle } from '../types';

export interface KeyPair {
  publicKey: string;   // Base64
  secretKey: string;   // Base64
}

export interface FullKeySet {
  ed25519: KeyPair;    // Signing
  x25519: KeyPair;     // Encryption
}

/**
 * Generate a full set of keys for a new member.
 */
export function generateKeySet(): FullKeySet {
  // Ed25519 for signing
  const edPair = nacl.sign.keyPair();
  // X25519 for encryption (Curve25519)
  const boxPair = nacl.box.keyPair();

  return {
    ed25519: {
      publicKey: encodeBase64(edPair.publicKey),
      secretKey: encodeBase64(edPair.secretKey),
    },
    x25519: {
      publicKey: encodeBase64(boxPair.publicKey),
      secretKey: encodeBase64(boxPair.secretKey),
    },
  };
}

/**
 * Create a public key bundle for publishing.
 */
export function createPublicKeyBundle(
  memberId: string,
  keys: FullKeySet
): PublicKeyBundle {
  return {
    memberId,
    ed25519: keys.ed25519.publicKey,
    x25519: keys.x25519.publicKey,
    publishedAt: Date.now(),
  };
}

/**
 * Serialize a public key bundle to JSON for storage.
 */
export function serializePublicKeys(bundle: PublicKeyBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/**
 * Deserialize a public key bundle from JSON.
 */
export function deserializePublicKeys(json: string): PublicKeyBundle {
  return JSON.parse(json) as PublicKeyBundle;
}

// Re-export for convenience
export { encodeBase64, decodeBase64 };
