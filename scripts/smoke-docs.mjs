// Smoke: evaluate → pdf (Tailor) → cover (Writer) for a throw-away member, then clean up.
// Copies the PDFs to /tmp scratch so they can be inspected. Usage: node scripts/smoke-docs.mjs [model]
import { Redis } from '@upstash/redis';
import { copyFile, mkdir } from 'node:fs/promises';
import { firestore } from '../lib/firestore.js';
import { KEYS } from '../lib/keys.js';
import { config } from 'dotenv'; config();

const model = process.argv[2] || 'llama3.2:3b';
const uid = '_smoke';
const OUT = process.env.SMOKE_OUT || '/tmp/smoke-docs';
const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
const db = firestore();

await db.doc(`users/${uid}/careerOps/setup`).set({
  cvMarkdown: `# Ada Lovelace\nSenior Product Owner · Auckland, NZ · ada@example.com · +64 21 000 0000 · linkedin.com/in/adalovelace\n\n## Professional Summary\nProduct owner with 8 years in SaaS and banking. Ships fast, measures everything.\n\n## Professional Experience\n**Acme SaaS — Senior Product Owner (2021–2025), Auckland**\n- Owned the climate-reporting product line (NZ$4M ARR); shipped 14 releases/year with a squad of 7.\n- Cut onboarding time from 21 to 6 days by redesigning the activation flow (measured on 1,200 accounts).\n- Ran discovery with 60+ customer interviews; wrote PRDs, roadmaps, OKRs.\n**Beta Bank — Business Analyst (2017–2021), Wellington**\n- Led requirements for a core-banking migration (Jira, Confluence, SQL); 40 user stories/sprint.\n\n## Skills\nProduct discovery, roadmaps, OKRs, Jira, SQL, Figma basics, stakeholder management, agile/Scrum.\n\n## Education\nBCom (Information Systems), University of Auckland, 2016`,
  profileYaml: `candidate:\n  full_name: "Ada Lovelace"\n  email: "ada@example.com"\n  phone: "+64 21 000 0000"\n  location: "Auckland, New Zealand"\n  linkedin: "linkedin.com/in/adalovelace"\ntarget_roles:\n  primary:\n    - "Senior Product Owner"\ncompensation:\n  target_range: "NZ$150k-180k"\n  minimum: "NZ$140k"\nlocation:\n  country: "New Zealand"\n  authorized_in:\n    - "New Zealand"\n`,
  updatedAt: Date.now(),
});
const jd = `Product Owner — Payments Platform (Wellington or remote NZ)\nKiwiPay is a Series B fintech (120 people). We're hiring a Product Owner for our payments platform squad.\nYou will: own the backlog for two squads, run discovery with merchants, define OKRs, work with engineering leads on delivery.\nMust have: 4+ years product ownership in SaaS or fintech; experience with agile delivery; strong stakeholder management; comfortable with data (SQL a plus).\nNice to have: payments/fintech domain; Figma.\nSalary: NZ$140,000–165,000 + equity. Hybrid: 2 days/week in Wellington preferred, remote within NZ considered. Must have the right to work in New Zealand.`;

async function runJob(type, payload) {
  const createdAt = Date.now();
  const id = `${new Date(createdAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '')}-5m0ke${type.slice(0, 3)}`;
  const p = redis.pipeline();
  p.hset(KEYS.job(id), { id, type, status: 'queued', uid, payload: JSON.stringify(payload), createdAt, createdBy: 'smoke-test' });
  p.zadd(KEYS.jobs, { score: createdAt, member: id }); p.zadd(KEYS.userJobs(uid), { score: createdAt, member: id }); p.lpush(KEYS.queue, id);
  await p.exec();
  console.log(`\n▶ ${type} queued ${id}`);
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const j = await redis.hgetall(KEYS.job(id));
    process.stdout.write(`\r  ${Math.round((Date.now() - t0) / 1000)}s ${j.status} · ${j.progress ?? ''}        `);
    if (['done', 'failed', 'cancelled'].includes(j.status)) { console.log('\n--- log:\n' + (j.log ?? '')); console.log('--- result:', j.result); await redis.del(KEYS.job(id)); await redis.zrem(KEYS.jobs, id); return { id, status: j.status }; }
  }
}

const ev = await runJob('evaluate', { jd, model });
if (ev.status === 'done') {
  await mkdir(OUT, { recursive: true });
  const pdf = await runJob('pdf', { reportJobId: ev.id, model });
  const cov = await runJob('cover', { reportJobId: ev.id, angle: 'I want to move from climate SaaS into payments because merchants feel every hour of downtime; I like products where the stakes are that clear.', model });
  for (const j of [pdf, cov]) {
    const d = (await db.doc(`users/${uid}/careerOpsDocs/${j.id}`).get()).data();
    if (d) { console.log(`--- doc ${d.kind}: ${d.file} · ${d.pageCount}p · ${d.storage} · ${d.words ?? ''}${d.words ? ' words' : ''}`); await copyFile(`/home/rafcasto/careerops-data/${uid}/output/${d.file}`, `${OUT}/${d.file}`).catch(() => {}); if (d.text) console.log(d.text); }
    await db.doc(`users/${uid}/careerOpsDocs/${j.id}`).delete().catch(() => {});
  }
  await db.doc(`users/${uid}/careerOpsReports/${ev.id}`).delete().catch(() => {});
}
await db.doc(`users/${uid}/careerOps/setup`).delete().catch(() => {});
await redis.del(KEYS.userJobs(uid));
console.log('\ncleaned up (PDF copies in ' + OUT + ')');
process.exit(0);
