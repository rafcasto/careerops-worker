// Smoke test: seeds a throw-away member (_smoke), queues one evaluate job the
// way the site does, waits for it, prints the result, and cleans up.
// Usage: node scripts/smoke-evaluate.mjs [model]
import { Redis } from '@upstash/redis';
import { firestore } from '../lib/firestore.js';
import { KEYS } from '../lib/keys.js';
import { config } from 'dotenv'; config();

const model = process.argv[2] || 'qwen2.5:1.5b-instruct';
const uid = '_smoke';
const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
const db = firestore();

await db.doc(`users/${uid}/careerOps/setup`).set({
  cvMarkdown: `# Ada Lovelace\nSenior Product Owner · Auckland, NZ\n\n## Experience\n**Acme SaaS — Senior Product Owner (2021–2025)**\n- Owned the climate-reporting product line (NZ$4M ARR); shipped 14 releases/year with a squad of 7.\n- Cut onboarding time from 21 to 6 days by redesigning the activation flow (measured on 1,200 accounts).\n- Ran discovery with 60+ customer interviews; wrote PRDs, roadmaps, OKRs.\n**Beta Bank — Business Analyst (2017–2021)**\n- Led requirements for a core-banking migration (Jira, Confluence, SQL).\n\n## Skills\nProduct discovery, roadmaps, OKRs, Jira, SQL, Figma basics, stakeholder management, agile/Scrum.\n\n## Education\nBCom, University of Auckland`,
  profileYaml: `candidate:\n  full_name: "Ada Lovelace"\n  email: "ada@example.com"\n  location: "Auckland, New Zealand"\ntarget_roles:\n  primary:\n    - "Senior Product Owner"\ncompensation:\n  target_range: "NZ$150k-180k"\n  minimum: "NZ$140k"\nlocation:\n  country: "New Zealand"\n  authorized_in:\n    - "New Zealand"\n`,
  updatedAt: Date.now(),
});
const jd = `Product Owner — Payments Platform (Wellington or remote NZ)\nKiwiPay is a Series B fintech (120 people). We're hiring a Product Owner for our payments platform squad.\nYou will: own the backlog for two squads, run discovery with merchants, define OKRs, work with engineering leads on delivery.\nMust have: 4+ years product ownership in SaaS or fintech; experience with agile delivery; strong stakeholder management; comfortable with data (SQL a plus).\nNice to have: payments/fintech domain; Figma.\nSalary: NZ$140,000–165,000 + equity. Hybrid: 2 days/week in Wellington preferred, remote within NZ considered. Must have the right to work in New Zealand.`;

const createdAt = Date.now();
const id = `${new Date(createdAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '')}-5m0ke000`;
const p = redis.pipeline();
p.hset(KEYS.job(id), { id, type: 'evaluate', status: 'queued', uid, payload: JSON.stringify({ jd, model }), createdAt, createdBy: 'smoke-test' });
p.zadd(KEYS.jobs, { score: createdAt, member: id }); p.zadd(KEYS.userJobs(uid), { score: createdAt, member: id }); p.lpush(KEYS.queue, id);
await p.exec();
console.log('queued', id, 'model', model);

const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 5000));
  const j = await redis.hgetall(KEYS.job(id));
  process.stdout.write(`\r${Math.round((Date.now() - t0) / 1000)}s ${j.status} · ${j.progress ?? ''}        `);
  if (['done', 'failed', 'cancelled'].includes(j.status)) {
    console.log('\n--- log:\n' + (j.log ?? ''));
    console.log('--- result:', j.result);
    break;
  }
}
const rep = await db.doc(`users/${uid}/careerOpsReports/${id}`).get();
if (rep.exists) { const r = rep.data(); console.log(`--- firestore report: ${r.company} — ${r.role} · ${r.score}/5 · ${r.archetype} · ${r.legitimacy} · via ${r.via} · ${Math.round(r.durationMs / 1000)}s`); console.log(r.markdown.slice(0, 1500)); }
// cleanup
await db.doc(`users/${uid}/careerOpsReports/${id}`).delete().catch(() => {});
await db.doc(`users/${uid}/careerOps/setup`).delete().catch(() => {});
await redis.del(KEYS.job(id)); await redis.zrem(KEYS.jobs, id); await redis.del(KEYS.userJobs(uid));
console.log('cleaned up');
process.exit(0);
