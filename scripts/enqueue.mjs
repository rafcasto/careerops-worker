// Queue an admin job from the Pi and wait for it. Usage: node scripts/enqueue.mjs <type> '<payload json>'
import { Redis } from '@upstash/redis';
import { KEYS } from '../lib/keys.js';
import { config } from 'dotenv'; config();
const [type, payloadJson] = process.argv.slice(2);
const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
const createdAt = Date.now();
const id = `${new Date(createdAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '')}-${Math.random().toString(16).slice(2, 10)}`;
const p = redis.pipeline();
p.hset(KEYS.job(id), { id, type, status: 'queued', uid: 'admin-cli', payload: payloadJson || '{}', createdAt, createdBy: 'rafcasto@gmail.com' });
p.zadd(KEYS.jobs, { score: createdAt, member: id }); p.lpush(KEYS.queue, id);
await p.exec();
console.log(`queued ${type} ${id}`);
const t0 = Date.now(); let lastP = '';
for (;;) {
  await new Promise((r) => setTimeout(r, 10000));
  const j = await redis.hgetall(KEYS.job(id));
  if (j.progress !== lastP) { lastP = j.progress; console.log(`${Math.round((Date.now() - t0) / 1000)}s ${j.status} · ${j.progress ?? ''}`); }
  if (['done', 'failed', 'cancelled'].includes(j.status)) { console.log('--- log:\n' + (j.log ?? '')); console.log('--- result:', j.result ?? j.error); process.exit(j.status === 'done' ? 0 : 1); }
}
