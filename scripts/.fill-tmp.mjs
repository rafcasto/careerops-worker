import { config } from 'dotenv'; config();
import { Redis } from '@upstash/redis';
import { KEYS } from '../lib/keys.js';
import { firestore } from '../lib/firestore.js';
const uid = 'HlFK0jvOj1MztAhKGVrBljG1ckk1', reportJobId = '20260919T104240-e9613125';
const db = firestore();
const notes = (await db.collection(`users/${uid}/careerOpsNotes`).where('kind', '==', 'apply').where('reportJobId', '==', reportJobId).get()).docs.map((d) => d.data()).sort((a, b) => b.createdAt - a.createdAt);
const answers = (notes[0]?.data?.answers ?? []).map((a) => ({ question: a.question, answer: a.answer })).filter((a) => a.answer);
const cv = (await db.collection(`users/${uid}/careerOpsDocs`).where('kind', '==', 'cv').where('reportJobId', '==', reportJobId).get()).docs.map((d) => d.data()).sort((a, b) => b.createdAt - a.createdAt)[0];
console.log(`answers: ${answers.length} (from ${new Date(notes[0]?.createdAt).toISOString()}) · cv: ${cv?.file ?? 'none'}`);
const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
const createdAt = Date.now(); const id = `${new Date(createdAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '')}-${Math.random().toString(16).slice(2, 10)}`;
const payload = JSON.stringify({ reportJobId, answers, ...(cv?.file ? { cvFile: cv.file } : {}) });
const p = redis.pipeline(); p.hset(KEYS.job(id), { id, type: 'apply_fill', status: 'queued', uid, payload, createdAt, createdBy: 'rafael@digitalpathways.io (claude, fill check)' }); p.zadd(KEYS.jobs, { score: createdAt, member: id }); p.zadd(KEYS.userJobs(uid), { score: createdAt, member: id }); p.lpush(KEYS.queue, id); await p.exec();
console.log('queued apply_fill', id);
const t0 = Date.now(); let last = '';
for (;;) { await new Promise((r) => setTimeout(r, 8000)); const j = await redis.hgetall(KEYS.job(id)); if (j.progress !== last) { last = j.progress; console.log(`${Math.round((Date.now() - t0) / 1000)}s ${j.status} · ${j.progress ?? ''}`); } if (['done', 'failed', 'cancelled'].includes(j.status)) { console.log('--- log:\n' + String(j.log ?? '').split('\n').filter(Boolean).slice(-20).join('\n')); console.log('--- result:', JSON.stringify(j.result ?? j.error)); process.exit(0); } if (Date.now() - t0 > 8 * 60 * 1000) process.exit(2); }
