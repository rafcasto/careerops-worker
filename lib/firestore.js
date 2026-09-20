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

export async function getReport(uid, jobId) {
  const snap = await firestore().doc(`users/${uid}/careerOpsReports/${jobId}`).get();
  return snap.exists ? snap.data() : null;
}

// users/{uid}/careerOpsDocs/{jobId} — a tailored CV or a cover letter tied to a report.
export async function saveDoc(uid, jobId, doc) {
  await firestore().doc(`users/${uid}/careerOpsDocs/${jobId}`).set({ ...doc, createdAt: Date.now() });
}

// users/{uid}/careerOpsPipeline/{id} — postings the Scout found; id = hash of the URL.
export async function upsertPipeline(uid, items) {
  const db = firestore();
  let added = 0;
  for (let i = 0; i < items.length; i += 400) {
    const chunk = items.slice(i, i + 400);
    const refs = chunk.map((it) => db.doc(`users/${uid}/careerOpsPipeline/${it.id}`));
    const snaps = await db.getAll(...refs);
    const batch = db.batch();
    snaps.forEach((snap, j) => {
      const it = chunk[j];
      if (snap.exists) batch.set(refs[j], { lastSeenAt: Date.now(), company: it.company, title: it.title, location: it.location ?? null }, { merge: true });
      else { batch.set(refs[j], { ...it, status: 'pending', foundAt: Date.now(), lastSeenAt: Date.now() }); added++; }
    });
    await batch.commit();
  }
  return added;
}

export async function setPipelineStatus(uid, id, patch) {
  await firestore().doc(`users/${uid}/careerOpsPipeline/${id}`).set({ ...patch, updatedAt: Date.now() }, { merge: true }).catch(() => {});
}

// ---- CareerOps portal ----

// users/{uid}/careerOpsNotes/{jobId} — every non-report agent output (deep-dive, DM,
// application answers, interview prep, follow-up, training/project verdict, patterns).
export async function saveNote(uid, jobId, note) {
  await firestore().doc(`users/${uid}/careerOpsNotes/${jobId}`).set({ ...note, jobId, createdAt: Date.now() });
}
export async function latestNote(uid, kind, reportJobId) {
  let q = firestore().collection(`users/${uid}/careerOpsNotes`).where('kind', '==', kind);
  if (reportJobId) q = q.where('reportJobId', '==', reportJobId);
  const snap = await q.get();
  const docs = snap.docs.map((d) => d.data()).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return docs[0] ?? null;
}
// Reports without the heavy fields, for the patterns job.
export async function listReports(uid) {
  const snap = await firestore().collection(`users/${uid}/careerOpsReports`).get();
  return snap.docs.map((d) => { const { markdown, jd, ...rest } = d.data(); return { ...rest, markdown: String(markdown ?? '').slice(0, 6000) }; });
}
export async function listOpportunities(uid) {
  const snap = await firestore().collection(`users/${uid}/opportunities`).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
// config/content.stages — the admin-editable Progress-board columns; first column is where new cards land.
export async function getStages() {
  const snap = await firestore().doc('config/content').get();
  const stages = snap.exists ? snap.data().stages : null;
  return Array.isArray(stages) && stages.length ? stages : [{ id: 'wishlist', label: 'Wishlist' }, { id: 'outreach', label: 'Outreach' }, { id: 'info_interview', label: 'Information interview' }, { id: 'application', label: 'Application' }, { id: 'job_interview', label: 'Job interview' }, { id: 'offer', label: 'Offer' }, { id: 'negotiation', label: 'Negotiation' }, { id: 'accepted', label: 'Accepted' }, { id: 'rejected', label: 'Rejected' }];
}
// Auto-pipeline: log the posting on the member's Progress board (tracker of record) as a
// pending card in the first column, and stamp the report with the card id.
export async function addOpportunityForReport(uid, jobId, report) {
  const db = firestore();
  const stages = await getStages();
  const ref = db.collection(`users/${uid}/opportunities`).doc();
  await ref.set({
    company: report.company, role: report.role, market: 'visible', stage: stages[0].id, contactIds: [], log: [],
    source: 'CareerOps · auto-pipeline', url: report.url ?? '', notes: `Evaluator score ${report.score ?? '?'}/5 · ${report.archetype} · ${report.legitimacy} · pending`,
    createdAt: Date.now(),
  });
  await db.doc(`users/${uid}/careerOpsReports/${jobId}`).set({ addedOpportunityId: ref.id }, { merge: true });
  return ref.id;
}
