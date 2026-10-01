import { randomBytes, randomUUID } from 'node:crypto';

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
// Invite codes avoid characters people mix up when reading them aloud (0/O, 1/I/L).
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Random id with a readable prefix, e.g. newId('ord') -> 'ord_k3x9...'. */
export function newId(prefix) {
  const bytes = randomBytes(12);
  let s = '';
  for (const b of bytes) s += ID_ALPHABET[b & 31];
  return `${prefix}_${s}`;
}

export function newUuid() {
  return randomUUID();
}

/** Short human-friendly code, e.g. for parent invitation codes. */
export function newCode(length = 8) {
  const bytes = randomBytes(length);
  let s = '';
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}
