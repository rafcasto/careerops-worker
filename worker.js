#!/usr/bin/env node
// careerops-worker — the Raspberry Pi side of JHG Compass → Agents.
//
//   site  --LPUSH-->  careerops:queue  --RPOP-->  this worker  --HSET-->  careerops:job:<id>  <--HGETALL--  site
//
// The site never runs a model. This process polls Upstash over HTTPS (no inbound
// port on the Pi), runs one job at a time through n8n/Ollama/career-ops scripts,
// and publishes a heartbeat (careerops:worker) + a state snapshot (careerops:state:
// Ollama models, n8n agent workflows, GPU reachability) the admin tab reads.

import os from 'node:os';
import { Redis } from '@upstash/redis';
import { KEYS, AGENT_KEYS, HEARTBEAT_TTL_S, LOG_TAIL_BYTES } from './lib/keys.js';
import { ollamaModels, n8nUp, n8nAgentWorkflows, gpuReachable, careerOpsVersion } from './lib/probes.js';
import { HANDLERS } from './jobs/index.js';
import { getAgentsConfig, publishAgentDefaults } from './lib/firestore.js';
import { DEFAULT_AGENTS_CONFIG } from './lib/prompts.js';

const VERSION = '0.1.0';
for (const v of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) if (!process.env[v]) { console.error(`Missing ${v}`); process.exit(2); }

const env = {
  repo: process.env.CAREER_OPS_REPO || `${process.env.HOME}/career-ops`,
  dataBase: process.env.CAREEROPS_DATA_BASE || `${process.env.HOME}/careerops-data`,
  trainingDir: process.env.CAREEROPS_TRAINING_DIR || `${process.env.HOME}/careerops-training`,
  n8n: process.env.N8N_URL || 'http://127.0.0.1:5678',
  ollama: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  scraper: process.env.JOB_SCRAPER_URL || 'http://127.0.0.1:3010',
  gpuHost: process.env.GPU_SSH_HOST || null,
  pollMs: Math.max(1000, Number(process.env.POLL_MS) || 3000),
};
// How this worker introduces itself in the admin tab. The Pi's OS hostname is
// shared with other services, so both are overridable from .env.
const WORKER_HOST = process.env.WORKER_HOST || os.hostname();
const WORKER_ID = process.env.WORKER_ID || `careerops-${WORKER_HOST}-${process.pid}`;
const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
const now = () => Date.now();
const say = (...a) => console.log(new Date().toISOString(), ...a);

let current = null;            // job id in flight
let probes = { n8n: false, ollama: false };
const startedAt = now();

// ---------------- heartbeat + state ----------------
async function heartbeat() {
  const hb = { id: WORKER_ID, host: WORKER_HOST, pid: process.pid, version: VERSION, startedAt, at: now(), current, pollMs: env.pollMs, n8n: probes.n8n, ollama: probes.ollama };
  try { await redis.set(KEYS.worker, JSON.stringify(hb), { ex: HEARTBEAT_TTL_S }); } catch (e) { say('heartbeat failed', e.message); }
}

async function publishState() {
  const [models, n8nOk, agents, gpu, version] = await Promise.all([
    ollamaModels(env.ollama), n8nUp(env.n8n), n8nAgentWorkflows(AGENT_KEYS), gpuReachable(env.gpuHost), careerOpsVersion(env.repo),
  ]);
  probes = { n8n: n8nOk, ollama: models !== null };
  const state = {
    models: models ?? [], agents, datasets: [],
    gpu: { host: env.gpuHost, reachable: gpu, checkedAt: now() },
    careerOpsVersion: version, updatedAt: now(),
  };
  try { await redis.set(KEYS.state, JSON.stringify(state)); } catch (e) { say('state publish failed', e.message); }
}

// ---------------- job plumbing ----------------
const patchJob = (id, fields) => redis.hset(KEYS.job(id), fields);

async function runJob(id) {
  const raw = await redis.hgetall(KEYS.job(id));
  if (!raw || !raw.type) { say('job vanished', id); return; }
  if (String(raw.cancel) === '1' || raw.status === 'cancelled') { say('job cancelled before start', id); return; }
  const job = { ...raw, payload: typeof raw.payload === 'string' ? JSON.parse(raw.payload) : raw.payload ?? {} };
  const handler = HANDLERS[job.type];
  current = id;
  let logBuf = '';
  const log = (line) => { logBuf = (logBuf + line + '\n').slice(-LOG_TAIL_BYTES); say(`[${id}]`, line); return patchJob(id, { log: logBuf }).catch(() => {}); };
  const progress = (text) => patchJob(id, { progress: text }).catch(() => {});
  const cancelled = async () => String((await redis.hget(KEYS.job(id), 'cancel')) ?? '') === '1';

  await patchJob(id, { status: 'running', startedAt: now(), worker: WORKER_ID, log: '' });
  await heartbeat();
  try {
    if (!handler) throw new Error(`unknown job type ${job.type}`);
    const result = await handler({ job, env, log, progress, cancelled, redis });
    if (await cancelled()) await patchJob(id, { status: 'cancelled', endedAt: now(), progress: 'cancelled' });
    else await patchJob(id, { status: 'done', endedAt: now(), progress: 'done', result: JSON.stringify(result ?? null) });
  } catch (e) {
    await log(`ERROR ${e.message}`);
    await patchJob(id, { status: (await cancelled()) ? 'cancelled' : 'failed', endedAt: now(), error: e.message });
  } finally {
    current = null;
    await heartbeat();
  }
}

// ---------------- main loop ----------------
async function main() {
  say(`careerops-worker v${VERSION} as ${WORKER_ID} · repo ${env.repo} · data ${env.dataBase}`);
  try { await publishAgentDefaults(DEFAULT_AGENTS_CONFIG); await getAgentsConfig(DEFAULT_AGENTS_CONFIG); say('config/agents ready'); } catch (e) { say('config/agents unavailable:', e.message); }
  await publishState(); await heartbeat();
  let lastBeat = now(), lastState = now();
  for (;;) {
    try {
      if (now() - lastBeat > 30_000) { await heartbeat(); lastBeat = now(); }
      if (now() - lastState > 60_000) { await publishState(); lastState = now(); }
      const id = await redis.rpop(KEYS.queue);
      if (id) { await runJob(id); continue; }
    } catch (e) { say('loop error', e.message); }
    await new Promise((r) => setTimeout(r, env.pollMs));
  }
}

process.on('SIGTERM', async () => { say('SIGTERM'); try { await redis.del(KEYS.worker); } catch {} process.exit(0); });
main();
