// Portal-account vault. The member types a portal password in the browser; it is encrypted there
// with THIS worker's RSA public key (published in careerops:state) and written to
// users/{uid}/careerOpsVault/{host} as ciphertext. Only the Pi holds the private key
// (.vault-key.pem, mode 600, gitignored) — Vercel, Redis and Firestore only ever see ciphertext.
import { generateKeyPairSync, privateDecrypt, publicEncrypt, constants, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { firestore } from './firestore.js';

export function ensureVaultKey(dir) {
  const file = join(dir, '.vault-key.pem');
  let pem;
  if (existsSync(file)) pem = readFileSync(file, 'utf8');
  else {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    writeFileSync(file, pem, { mode: 0o600 }); chmodSync(file, 0o600);
  }
  const privateKey = createPrivateKey(pem);
  const publicKeySpkiB64 = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
  return { privateKey, publicKeySpkiB64, file };
}
const OAEP = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };
export const decryptSecret = (privateKey, b64) => privateDecrypt({ key: privateKey, ...OAEP }, Buffer.from(b64, 'base64')).toString('utf8');
// Used by tests and scripts only — the browser does the real encryption with WebCrypto.
export const encryptSecret = (publicKeySpkiB64, text) => publicEncrypt({ key: createPublicKey({ key: Buffer.from(publicKeySpkiB64, 'base64'), type: 'spki', format: 'der' }), ...OAEP }, Buffer.from(text, 'utf8')).toString('base64');

export const vaultHost = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return String(url ?? '').toLowerCase(); } };
export async function getVaultAccount(uid, host) {
  const snap = await firestore().doc(`users/${uid}/careerOpsVault/${host}`).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}
export async function updateVaultAccount(uid, host, patch) {
  await firestore().doc(`users/${uid}/careerOpsVault/${host}`).set({ ...patch, updatedAt: Date.now() }, { merge: true });
}
