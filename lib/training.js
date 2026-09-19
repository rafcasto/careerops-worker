// Training data in Firestore (admin-only collections, Admin SDK writes):
//   trainingExamples/{id}   one (cv, profile, jd) → report pair, with source + split + approved
//   trainingDatasets/{name} a built train/exam jsonl on the Pi
//   trainingModels/{tag}    fine-tuned / imported models and their exam results
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { firestore } from './firestore.js';
import { buildEvaluatorMessages } from './prompts.js';

export const EXAM_SHARE = 0.15;

export const exampleId = (jd, cv) => createHash('sha1').update(jd.trim() + '\n---\n' + cv.trim()).digest('hex').slice(0, 20);
export const safeTag = (tag) => String(tag).replace(/[^A-Za-z0-9._:-]/g, '-');
export const tagDocId = (tag) => safeTag(tag).replace(/:/g, '__');

export async function saveExample(ex) {
  const id = ex.id || exampleId(ex.jd, ex.cv);
  await firestore().doc(`trainingExamples/${id}`).set({ ...ex, id, createdAt: ex.createdAt ?? Date.now() });
  return id;
}

export async function listExamples({ agent = 'evaluator', approvedOnly = true, split = null, sources = null } = {}) {
  let q = firestore().collection('trainingExamples').where('agent', '==', agent);
  if (approvedOnly) q = q.where('approved', '==', true);
  const snap = await q.get();
  return snap.docs.map((d) => d.data()).filter((e) => (!split || e.split === split) && (!sources || sources.includes(e.source)));
}

export async function saveDataset(name, doc) { await firestore().doc(`trainingDatasets/${name}`).set({ ...doc, name, updatedAt: Date.now() }, { merge: true }); }
export async function getDataset(name) { const s = await firestore().doc(`trainingDatasets/${name}`).get(); return s.exists ? s.data() : null; }
export async function saveModel(tag, doc) { await firestore().doc(`trainingModels/${tagDocId(tag)}`).set({ ...doc, tag, updatedAt: Date.now() }, { merge: true }); }
export async function getModel(tag) { const s = await firestore().doc(`trainingModels/${tagDocId(tag)}`).get(); return s.exists ? s.data() : null; }

// Strip direct identifiers before a live member's data enters a dataset.
export function pseudonymise(text, { name = '', email = '' } = {}) {
  let t = String(text ?? '');
  const parts = name.split(/\s+/).filter((p) => p.length > 1);
  if (name.trim()) t = t.replace(new RegExp(name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'Alex Candidate');
  for (const p of parts) t = t.replace(new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), p === parts[0] ? 'Alex' : 'Candidate');
  if (email) t = t.split(email).join('candidate@example.com');
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'candidate@example.com');
  t = t.replace(/\+?\d[\d\s().-]{7,}\d/g, '+64 21 000 0000');
  t = t.replace(/https?:\/\/\S+|(?:www\.|linkedin\.com\/|github\.com\/)\S+/gi, 'https://example.com/profile');
  return t;
}

// SFT lines in the chat format train_lora.py expects. The system prompt is the
// CURRENT agent prompt so the student learns to answer the prompt it will be served.
export function toSftLine(ex, systemPrompt, numCtx = 8192) {
  const messages = buildEvaluatorMessages({ system: systemPrompt, cv: ex.cv, profileYaml: ex.profileYaml ?? '', jd: ex.jd, url: null, numCtx });
  return JSON.stringify({ messages: [...messages, { role: 'assistant', content: ex.report }] });
}

export async function writeDataset(dir, name, { train, exam, systemPrompt, numCtx }) {
  const d = join(dir, 'datasets', name);
  await mkdir(d, { recursive: true });
  await writeFile(join(d, 'train.jsonl'), train.map((e) => toSftLine(e, systemPrompt, numCtx)).join('\n') + '\n', 'utf8');
  await writeFile(join(d, 'exam.jsonl'), exam.map((e) => JSON.stringify({ id: e.id, cv: e.cv, profileYaml: e.profileYaml ?? '', jd: e.jd, summary: e.summary })).join('\n') + '\n', 'utf8');
  return d;
}
