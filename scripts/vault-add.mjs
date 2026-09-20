// Put a portal account in a member's vault from the Pi (no Vercel needed).
//   node scripts/vault-add.mjs <uid|email> <portal-host-or-url> <portal-email>
// Prompts for the password (no echo), encrypts it with THIS Pi's vault public key — the same
// ciphertext the browser would write — and stores users/{uid}/careerOpsVault/{host}.
import { config } from 'dotenv'; config();
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { ensureVaultKey, encryptSecret, vaultHost } from '../lib/vault.js';
import { firestore } from '../lib/firestore.js';

const [who, hostArg, email] = process.argv.slice(2);
if (!who || !hostArg || !email) { console.error('usage: node scripts/vault-add.mjs <uid|email> <portal-host-or-url> <portal-email>'); process.exit(2); }
const db = firestore();
let uid = who;
if (who.includes('@')) { const q = await db.collection('users').where('email', '==', who).limit(1).get(); if (q.empty) { console.error(`no user with email ${who}`); process.exit(1); } uid = q.docs[0].id; }
const host = vaultHost(hostArg.includes('://') ? hostArg : `https://${hostArg}`);
const password = await new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  process.stdout.write(`password for ${email} on ${host}: `);
  rl._writeToOutput = () => {};                         // no echo
  rl.question('', (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
});
if (!password) { console.error('empty password — nothing saved'); process.exit(1); }
const { publicKeySpkiB64 } = ensureVaultKey(dirname(dirname(fileURLToPath(import.meta.url))));
const portal = /myworkdayjobs\.com$/.test(host) ? 'workday' : /successfactors\.(eu|com)$|jobs2web/.test(host) ? 'successfactors' : /\.csod\.com$/.test(host) ? 'csod' : 'generic';
const now = Date.now();
await db.doc(`users/${uid}/careerOpsVault/${host}`).set({ host, portal, email, passwordEnc: encryptSecret(publicKeySpkiB64, password), status: 'pending', lastError: null, createdAt: now, updatedAt: now, addedBy: 'pi-cli' }, { merge: true });
console.log(`saved users/${uid}/careerOpsVault/${host} (${portal}) for ${email} — encrypted for this Pi's key`);
process.exit(0);
