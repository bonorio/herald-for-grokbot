// Web Push encryption (RFC 8291, aes128gcm) and VAPID signing (RFC 8292) on WebCrypto.
import { base64url, fromBase64url } from "./util";

const text = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: ArrayBuffer, info: Uint8Array<ArrayBuffer>, length: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Encrypts `payload` for one subscription as a single aes128gcm record. */
export async function encryptPayload(target: PushTarget, payload: string): Promise<Uint8Array<ArrayBuffer>> {
  const clientPublic = fromBase64url(target.p256dh);
  const authSecret = fromBase64url(target.auth);
  const server = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const serverPublic = new Uint8Array((await crypto.subtle.exportKey("raw", server.publicKey)) as ArrayBuffer);
  const clientKey = await crypto.subtle.importKey("raw", clientPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey }, server.privateKey, 256);

  const ikm = await hkdf(authSecret, shared, concat(text.encode("WebPush: info\0"), clientPublic, serverPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, text.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text.encode("Content-Encoding: nonce\0"), 12);

  // One record: the payload, then the 0x02 delimiter that marks the last record.
  const plaintext = concat(text.encode(payload), new Uint8Array([2]));
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext));

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([serverPublic.length]), serverPublic, ciphertext);
}

/** `Authorization: vapid t=…, k=…` for the push service at `endpoint`. */
export async function vapidAuthorization(endpoint: string, privateJwk: JsonWebKey, publicKey: string, subject: string) {
  const header = base64url(text.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64url(
    text.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })),
  );
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto's ECDSA signature is already the raw r||s form JWS wants.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, text.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${base64url(new Uint8Array(signature))}, k=${publicKey}`;
}
