import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

/**
 * Sign a message using Ed25519 private key.
 * Signs: eventId + timestamp + ciphertextHash
 */
export function signEvent(
  eventId: string,
  timestamp: number,
  ciphertextBase64: string,
  ed25519SecretKey: string
): string {
  const message = `${eventId}:${timestamp}:${ciphertextBase64}`;
  const messageBytes = new TextEncoder().encode(message);
  const secretKey = decodeBase64(ed25519SecretKey);

  const signature = nacl.sign.detached(messageBytes, secretKey);
  return encodeBase64(signature);
}

/**
 * Verify an Ed25519 signature.
 */
export function verifySignature(
  eventId: string,
  timestamp: number,
  ciphertextBase64: string,
  signatureBase64: string,
  ed25519PublicKey: string
): boolean {
  const message = `${eventId}:${timestamp}:${ciphertextBase64}`;
  const messageBytes = new TextEncoder().encode(message);
  const signature = decodeBase64(signatureBase64);
  const publicKey = decodeBase64(ed25519PublicKey);

  return nacl.sign.detached.verify(messageBytes, signature, publicKey);
}

/**
 * Check if an event timestamp is within acceptable window (5 minutes).
 */
export function isTimestampValid(ts: number, windowMs: number = 5 * 60 * 1000): boolean {
  const now = Date.now();
  return Math.abs(now - ts) <= windowMs;
}
