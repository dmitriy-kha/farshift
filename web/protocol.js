import { ed25519 } from '@noble/curves/ed25519.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const encoder = new TextEncoder();
const Point = ed25519.Point;
const order = Point.Fn.ORDER;
// Preserve the parameters and transcript of RustCrypto spake2 0.4 Ed25519.
const M = Point.fromHex('15cfd18e385952982b6a8f8c7854963b58e34388c8e6dae891db756481a02312');
const N = Point.fromHex('f04f2e7eb734b2a8f8b472eaf9c3c632576ac64aea650b496a8a20ff00e583c3');
if (!M.isTorsionFree() || !N.isTorsionFree() || M.isSmallOrder() || N.isSmallOrder()) throw new Error('Invalid SPAKE2 parameters');
const DOMAIN = encoder.encode('farshift/pairing/v2');
const MAX_SIGNAL = 65536;

function symbols(value, length) {
  return typeof value === 'string' && value.length === length && Array.from(value).every(char => ALPHABET.includes(char));
}
export const validRoom = value => symbols(value, 3);
export const validSecret = value => symbols(value, 5);
export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '');
  if (!/^(?:[A-Za-z0-9]{8}|[A-Za-z0-9]{4}-[A-Za-z0-9]{4})$/.test(trimmed)) return null;
  const code = trimmed.replace('-', '').toUpperCase();
  return symbols(code, 8) ? code : null;
}
export function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  const value = Array.from(bytes, byte => ALPHABET[byte % 32]).join('');
  bytes.fill(0);
  return value;
}
export function bytesBase64(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function unbase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid authentication tag');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
  if (bytesBase64(bytes) !== value) throw new Error('Invalid authentication tag');
  return bytes;
}
function concat(...parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
function integer(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}
async function hash(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
async function hkdf(input, salt, info, length) {
  const key = await crypto.subtle.importKey('raw', input, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) }, key, length * 8));
}
function randomScalar() {
  let scalar;
  do {
    const random = crypto.getRandomValues(new Uint8Array(64));
    scalar = integer(random) % order;
    random.fill(0);
  } while (scalar === 0n);
  return scalar;
}
function multiply(point, scalar) {
  return scalar === 0n ? Point.ZERO : point.multiply(scalar);
}
const opposite = role => role === 'a' ? 'b' : 'a';
function textBytes(value) {
  // Rust strings are valid Unicode; do not authenticate replacement characters.
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Invalid Unicode payload');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('Invalid Unicode payload');
  }
  return encoder.encode(value);
}

export class Pairing {
  static async create(role, idA, idB, attempt, secretA, secretB) {
    if (!['a', 'b'].includes(role) || !validRoom(idA) || !validRoom(idB) || idA >= idB || !validSecret(secretA) || !validSecret(secretB) || typeof attempt !== 'string' || !/^[0-9a-f]{32}$/.test(attempt)) {
      throw new Error('Invalid pairing context');
    }
    const context = `farshift/pairing/v2/${idA}/${idB}/${attempt}`;
    const password = encoder.encode(secretA + secretB);
    const expanded = await hkdf(password, new Uint8Array(), 'SPAKE2 pw', 48);
    const passwordScalar = integer(expanded) % order;
    expanded.fill(0);
    const scalar = randomScalar();
    const local = Point.BASE.multiply(scalar).add(multiply(role === 'a' ? M : N, passwordScalar)).toBytes();
    const pairing = new Pairing();
    Object.assign(pairing, { role, context, password, passwordScalar, scalar, local, used: false });
    return { pairing, message: concat(Uint8Array.of(role === 'a' ? 65 : 66), local) };
  }

  async finish(message) {
    if (this.used) throw new Error('Repeated key exchange');
    this.used = true;
    try {
      if (!(message instanceof Uint8Array) || message.length !== 33 || message[0] !== (this.role === 'a' ? 66 : 65)) throw new Error('Invalid pairing message');
      const peerBytes = message.slice(1);
      const peer = Point.fromBytes(peerBytes, false);
      if (!peer.isTorsionFree() || peer.isSmallOrder()) throw new Error('Invalid pairing point');
      const unmasked = peer.subtract(multiply(this.role === 'a' ? N : M, this.passwordScalar));
      if (unmasked.is0()) throw new Error('Invalid pairing point');
      const sharedPoint = unmasked.multiply(this.scalar).toBytes();
      const passwordHash = await hash(this.password);
      const identityA = await hash(encoder.encode(`${this.context}/a`));
      const identityB = await hash(encoder.encode(`${this.context}/b`));
      const transcript = concat(passwordHash, identityA, identityB, this.role === 'a' ? this.local : peerBytes, this.role === 'a' ? peerBytes : this.local, sharedPoint);
      const shared = await hash(transcript);
      transcript.fill(0);
      sharedPoint.fill(0);
      passwordHash.fill(0);
      try { return await Session.create(this.role, this.context, shared); }
      finally { shared.fill(0); }
    } finally { this.destroy(); }
  }

  destroy() {
    this.used = true;
    this.password?.fill(0);
    this.local?.fill(0);
    this.scalar = 0n;
    this.passwordScalar = 0n;
  }
}

function u64(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}
function signalData(role, sequence, bytes) {
  return concat(encoder.encode('farshift/signal/v2' + role), u64(sequence), u64(bytes.length), bytes);
}
function confirmationData(role) { return encoder.encode('farshift/confirm/v2' + role); }
async function hmacKey(shared, context, purpose, role) {
  const raw = await hkdf(shared, DOMAIN, `${context}/${purpose}/${role}`, 32);
  try { return await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
  finally { raw.fill(0); }
}

export class Session {
  static async create(role, context, shared) {
    const session = new Session();
    const [txKey, rxKey, txProof, rxProof] = await Promise.all([
      hmacKey(shared, context, 'signal', role),
      hmacKey(shared, context, 'signal', opposite(role)),
      hmacKey(shared, context, 'confirmation', role),
      hmacKey(shared, context, 'confirmation', opposite(role)),
    ]);
    Object.assign(session, { role, txKey, rxKey, txProof, rxProof, confirmed: false, closed: false, txSequence: 0, rxSequence: 0, txTail: Promise.resolve(), rxTail: Promise.resolve() });
    return session;
  }
  async confirmation() {
    if (this.closed) throw new Error('Session closed');
    return new Uint8Array(await crypto.subtle.sign('HMAC', this.txProof, confirmationData(this.role)));
  }
  async verifyConfirmation(bytes) {
    this.confirmed = false;
    if (this.closed || !(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error('Invalid confirmation');
    if (!await crypto.subtle.verify('HMAC', this.rxProof, bytes, confirmationData(opposite(this.role))) || this.closed) throw new Error('Message authentication failed');
    this.confirmed = true;
  }
  seal(payload) {
    const job = this.txTail.then(async () => {
      if (!this.confirmed || this.closed) throw new Error('Peer key is not confirmed');
      if (typeof payload !== 'string') throw new Error('Invalid signal');
      const bytes = textBytes(payload);
      if (bytes.length > MAX_SIGNAL) throw new Error('Message exceeds protocol limit');
      const sequence = this.txSequence + 1;
      if (!Number.isSafeInteger(sequence)) throw new Error('Message sequence exhausted');
      const tag = await crypto.subtle.sign('HMAC', this.txKey, signalData(this.role, sequence, bytes));
      if (this.closed) throw new Error('Session closed');
      this.txSequence = sequence;
      return JSON.stringify({ role: this.role, sequence, payload, tag: bytesBase64(new Uint8Array(tag)) });
    });
    this.txTail = job.catch(() => {});
    return job;
  }
  open(envelope) {
    const job = this.rxTail.then(async () => {
      if (!this.confirmed || this.closed) throw new Error('Peer key is not confirmed');
      if (typeof envelope !== 'string' || encoder.encode(envelope).length > MAX_SIGNAL * 6 + 256) throw new Error('Invalid signal envelope');
      const message = JSON.parse(envelope);
      if (!message || Array.isArray(message) || Object.keys(message).sort().join(',') !== 'payload,role,sequence,tag' || typeof message.payload !== 'string' || typeof message.tag !== 'string') throw new Error('Invalid signal envelope');
      // Both clients emit this fixed form; reject duplicate fields and aliases.
      if (JSON.stringify({ role: message.role, sequence: message.sequence, payload: message.payload, tag: message.tag }) !== envelope) throw new Error('Noncanonical signal envelope');
      const bytes = textBytes(message.payload);
      if (bytes.length > MAX_SIGNAL) throw new Error('Message exceeds protocol limit');
      if (message.role !== opposite(this.role)) throw new Error('Message authentication failed');
      const expected = this.rxSequence + 1;
      if (!Number.isSafeInteger(expected) || message.sequence !== expected) throw new Error('Unexpected message sequence');
      const tag = unbase64(message.tag);
      if (tag.length !== 32 || !await crypto.subtle.verify('HMAC', this.rxKey, tag, signalData(message.role, message.sequence, bytes)) || this.closed) throw new Error('Message authentication failed');
      this.rxSequence = expected;
      return message.payload;
    });
    this.rxTail = job.catch(() => {});
    return job;
  }
  destroy() {
    this.closed = true;
    this.confirmed = false;
    this.txKey = this.rxKey = this.txProof = this.rxProof = null;
  }
}
