// Smoke: pdf (Tailor) + cover (Writer) against a fixture report — skips the 4-min evaluate.
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
const jd = `Product Owner — Payments Platform (Wellington or remote NZ)\nKiwiPay is a Series B fintech (120 people). We're hiring a Product Owner for our payments platform squad.\nYou will: own the backlog for two squads, run discovery with merchants, define OKRs, work with engineering leads on delivery.\nMust have: 4+ years product ownership in SaaS or fintech; experience with agile delivery; strong stakeholder management; comfortable with data (SQL a plus).\nNice to have: payments/fintech domain; Figma.\nSalary: NZ$140,000–165,000 + equity. Hybrid: 2 days/week in Wellington preferred, remote within NZ considered. Must have the right to work in New Zealand.`;
await db.doc(`users/${uid}`).set({ email: 'smoke@example.com' }, { merge: true });
await db.doc(`users/${uid}/careerOps/setup`).set({
  cvMarkdown: `# Ada Lovelace\nSenior Product Owner · Auckland, NZ · ada@example.com · +64 21 000 0000 · linkedin.com/in/adalovelace\n\n## Professional Summary\nProduct owner with 8 years in SaaS and banking. Ships fast, measures everything.\n\n## Professional Experience\n**Acme SaaS — Senior Product Owner (2021–2025), Auckland**\n- Owned the climate-reporting product line (NZ$4M ARR); shipped 14 releases/year with a squad of 7.\n- Cut onboarding time from 21 to 6 days by redesigning the activation flow (measured on 1,200 accounts).\n- Ran discovery with 60+ customer interviews; wrote PRDs, roadmaps, OKRs.\n**Beta Bank — Business Analyst (2017–2021), Wellington**\n- Led requirements for a core-banking migration (Jira, Confluence, SQL); 40 user stories/sprint.\n\n## Skills\nProduct discovery, roadmaps, OKRs, Jira, SQL, Figma basics, stakeholder management, agile/Scrum.\n\n## Education\nBCom (Information Systems), University of Auckland, 2016`,
  profileYaml: `candidate:\n  full_name: "Ada Lovelace"\n  email: "ada@example.com"\n  phone: "+64 21 000 0000"\n  location: "Auckland, New Zealand"\n  linkedin: "linkedin.com/in/adalovelace"\ntarget_roles:\n  primary:\n    - "Senior Product Owner"\ncompensation:\n  target_range: "NZ$150k-180k"\n  minimum: "NZ$140k"\n`,
  updatedAt: Date.now(),
});
const reportId = '20260919T000000-f1x7ure0';
await db.doc(`users/${uid}/careerOpsReports/${reportId}`).set({ jobId: reportId, n: 1, file: '001-kiwipay.md', company: 'KiwiPay', role: 'Product Owner - Payments Platform', url: null, score: 3.4, archetype: 'Other: Product Owner', legitimacy: 'High Confidence', summaryFound: true, jd,
  markdown: `## Block B — Match with CV\n| Requirement | Importance | Match | JD signal | Evidence / gap |\n|---|---|---|---|---|\n| 4+ years product ownership | critical | ✅ Strong | Must have: 4+ years | Senior Product Owner 2021–2025 |\n| Discovery with merchants | high | ✅ Strong | run discovery with merchants | 60+ customer interviews |\n| SQL | meaningful | ⚠️ Partial | SQL a plus | Core-banking migration (SQL) |\n| Payments domain | meaningful | ❌ Missing | Nice to have: payments | — |\n\n## Block E — Personalisation\n- Lead with the NZ$4M ARR product line and 14 releases/year.\n- Mirror: backlog, discovery, OKRs, stakeholder management, agile delivery.\n`, agent: 'evaluator', model, createdAt: Date.now() });

async function runJob(type, payload) {
  const createdAt = Date.now();
  const id = `${new Date(createdAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '')}-5m0ke${type.slice(0, 3)}`;
  const p = redis.pipeline();
  p.hset(KEYS.job(id), { id, type, status: 'queued', uid, payload: JSON.stringify(payload), createdAt, createdBy: 'smoke-test' });
  p.zadd(KEYS.jobs, { score: createdAt, member: id }); p.lpush(KEYS.queue, id);
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
await mkdir(OUT, { recursive: true });
for (const [type, payload] of [['pdf', { reportJobId: reportId, model }], ['cover', { reportJobId: reportId, angle: 'I want to move from climate SaaS into payments because merchants feel every hour of downtime.', model }]]) {
  const j = await runJob(type, payload);
  const d = (await db.doc(`users/${uid}/careerOpsDocs/${j.id}`).get()).data();
  if (d) { console.log(`--- doc ${d.kind}: ${d.file} · ${d.pageCount}p · storage=${d.storage} · drive=${d.driveLink ?? '-'} · ${d.words ?? ''}${d.words ? ' words' : ''}`); await copyFile(`/home/rafcasto/careerops-data/${uid}/output/${d.file}`, `${OUT}/${d.file}`).catch(() => {}); if (d.text) console.log(d.text); }
  await db.doc(`users/${uid}/careerOpsDocs/${j.id}`).delete().catch(() => {});
}
await db.doc(`users/${uid}/careerOpsReports/${reportId}`).delete().catch(() => {});
await db.doc(`users/${uid}/careerOps/setup`).delete().catch(() => {});
await db.doc(`users/${uid}`).delete().catch(() => {});
console.log('\ncleaned up (PDF copies in ' + OUT + ')');
process.exit(0);
