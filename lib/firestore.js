// Firebase Admin on the Pi: reads member setup + agents config, mirrors results.
// Same service account as the site (FIREBASE_SERVICE_ACCOUNT_B64).
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

let db = null;
export function firestore() {
  if (db) return db;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 is not set');
  const sa = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  if (!getApps().length) initializeApp({ credential: cert(sa), storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined });
  db = getFirestore();
  return db;
}

// users/{uid}/careerOps/setup — written by the member from the Agents → Setup screen.
export async function getSetup(uid) {
  const snap = await firestore().doc(`users/${uid}/careerOps/setup`).get();
  return snap.exists ? snap.data() : null;
}

// users/{uid} — name/email for the report header when setup lacks them.
export async function getProfile(uid) {
  const snap = await firestore().doc(`users/${uid}`).get();
  return snap.exists ? snap.data() : null;
}

// config/agentsDefaults — the worker's built-in prompts/settings, published on
// boot so Admin → Agents → Prompts can offer "Reset to default".
export async function publishAgentDefaults(defaults) {
  await firestore().doc('config/agentsDefaults').set({ agents: defaults.agents, workerVersion: process.env.npm_package_version ?? null, updatedAt: Date.now() });
}

// config/agents — admin-editable model + prompt per agent. Seeded on first run.
export async function getAgentsConfig(defaults) {
  const ref = firestore().doc('config/agents');
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({ ...defaults, updatedAt: Date.now(), updatedBy: 'careerops-worker (seed)' });
    return defaults;
  }
  const d = snap.data();
  const agents = {};
  const reseed = {};
  for (const k of Object.keys(defaults.agents)) {
    const stored = d.agents?.[k] ?? {};
    // A newer default prompt replaces the stored one unless an admin edited it
    // (Admin → Agents → Prompts sets promptEditedBy). Admin model choices stay.
    const upgrade = !stored.promptEditedBy && (stored.promptVersion ?? 0) < defaults.agents[k].promptVersion;
    agents[k] = { ...defaults.agents[k], ...stored, ...(upgrade ? { systemPrompt: defaults.agents[k].systemPrompt, promptVersion: defaults.agents[k].promptVersion } : {}) };
    if (upgrade) reseed[`agents.${k}.systemPrompt`] = agents[k].systemPrompt, reseed[`agents.${k}.promptVersion`] = agents[k].promptVersion;
  }
  if (Object.keys(reseed).length) await ref.update({ ...reseed, updatedAt: Date.now(), updatedBy: 'careerops-worker (prompt upgrade)' }).catch(() => {});
  return { ...defaults, ...d, agents };
}

// users/{uid}/careerOpsReports/{jobId} — the A–G report the member sees live.
export async function saveReport(uid, jobId, report) {
  await firestore().doc(`users/${uid}/careerOpsReports/${jobId}`).set({ ...report, createdAt: Date.now() });
}

export { FieldValue };
