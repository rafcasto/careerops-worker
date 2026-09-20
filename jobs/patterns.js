// patterns — rejection-pattern detector (modes/patterns.md). The numbers are computed
// here (zero tokens); the model only turns them into a targeting analysis.
//   payload {}
import { listReports, listOpportunities, getStages } from '../lib/firestore.js';
import { PATTERNS_SYSTEM_PROMPT, buildTaskMessages } from '../lib/prompts.js';
import { loadContext, runTask, finish } from './_task.js';

const band = (s) => (s == null ? 'unknown' : s >= 4.5 ? '4.5+' : s >= 4 ? '4.0–4.4' : s >= 3.5 ? '3.5–3.9' : '<3.5');
const count = (map, k) => map.set(k, (map.get(k) ?? 0) + 1);
const top = (map, n = 8) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const grab = (md, name) => md.match(new RegExp(`## Block ${name}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`))?.[1] ?? '';

export function computeStats(reports, opps, stages) {
  const rejectedStages = new Set(stages.filter((s) => /reject|discard|closed|declin/i.test(s.id + ' ' + s.label)).map((s) => s.id));
  const positiveStages = new Set(stages.filter((s) => /interview|offer|negotiat|accept/i.test(s.id + ' ' + s.label)).map((s) => s.id));
  const oppById = new Map(opps.map((o) => [o.id, o]));
  const outcome = (r) => { const o = r.addedOpportunityId ? oppById.get(r.addedOpportunityId) : null; return !o ? 'not_on_board' : rejectedStages.has(o.stage) ? 'rejected' : positiveStages.has(o.stage) ? 'positive' : 'in_flight'; };
  const groups = { rejected: [], positive: [], in_flight: [], not_on_board: [] };
  for (const r of reports) groups[outcome(r)].push(r);
  const agg = (list) => {
    const arch = new Map(), legit = new Map(), bands = new Map(), remote = new Map(), seniority = new Map(), missing = new Map(), domain = new Map();
    let sum = 0, n = 0;
    for (const r of list) {
      count(arch, (r.archetype || 'Unknown').replace(/^Other:\s*/i, '')); count(legit, r.legitimacy || 'Unknown'); count(bands, band(r.score));
      if (r.score != null) { sum += r.score; n++; }
      const a = grab(r.markdown || '', 'A');
      const rem = a.match(/remote[^|\n]*\|\s*([^|\n]+)/i)?.[1]?.trim(); if (rem) count(remote, rem.toLowerCase().slice(0, 20));
      const sen = a.match(/seniority[^|\n]*\|\s*([^|\n]+)/i)?.[1]?.trim(); if (sen) count(seniority, sen.toLowerCase().slice(0, 24));
      const dom = a.match(/domain[^|\n]*\|\s*([^|\n]+)/i)?.[1]?.trim(); if (dom) count(domain, dom.toLowerCase().slice(0, 30));
      for (const line of grab(r.markdown || '', 'B').split('\n')) if (/❌|Missing/.test(line)) { const req = line.split('|')[1]?.trim(); if (req && req.length < 80) count(missing, req.toLowerCase()); }
    }
    return { n: list.length, avgScore: n ? +(sum / n).toFixed(2) : null, archetypes: top(arch), legitimacy: top(legit), scoreBands: top(bands), remote: top(remote), seniority: top(seniority), domains: top(domain), missingRequirements: top(missing, 10), companies: list.slice(0, 40).map((r) => `${r.company} (${r.score ?? '?'})`) };
  };
  const decided = groups.rejected.length + groups.positive.length;
  const rejectedCards = opps.filter((o) => rejectedStages.has(o.stage)).map((o) => ({ company: o.company, role: o.role ?? '', source: o.source ?? '', notes: String(o.notes ?? '').slice(0, 160), lastNote: (o.log ?? []).slice(-1)[0]?.text?.slice(0, 160) ?? '' }));
  const positiveScores = groups.positive.map((r) => r.score).filter((s) => s != null);
  return {
    totals: { reports: reports.length, boardCards: opps.length, rejected: groups.rejected.length, positive: groups.positive.length, inFlight: groups.in_flight.length, notOnBoard: groups.not_on_board.length, decided, sufficientSample: decided >= 5 },
    all: agg(reports), rejected: agg(groups.rejected), positive: agg(groups.positive), inFlight: agg(groups.in_flight),
    rejectedCards: rejectedCards.slice(0, 40),
    scoreThreshold: positiveScores.length ? { observedMinimumThatConverted: Math.min(...positiveScores), sampleSize: positiveScores.length } : null,
    boardByStage: stages.map((s) => ({ stage: s.label, n: opps.filter((o) => o.stage === s.id).length })).filter((x) => x.n),
  };
}

export async function run({ job, env, log, progress, cancelled }) {
  await progress('reading your reports and your Progress board');
  const { uid, setup, cfg } = await loadContext({ job, env, agent: 'evaluator', needCv: false });
  const [reports, opps, stages] = await Promise.all([listReports(uid), listOpportunities(uid), getStages()]);
  if (reports.length < 3) throw new Error(`Only ${reports.length} scored posting${reports.length === 1 ? '' : 's'} — score at least 3 before looking for patterns`);
  const stats = computeStats(reports, opps, stages);
  await log(`stats: ${stats.totals.reports} reports · ${stats.totals.rejected} rejected · ${stats.totals.positive} positive · decided ${stats.totals.decided}${stats.totals.sufficientSample ? '' : ' (small sample)'}`);
  if (await cancelled()) return null;
  const messages = buildTaskMessages({
    system: PATTERNS_SYSTEM_PROMPT, cv: '', profileYaml: setup.profileYaml ?? '', extra: [['COMPUTED STATISTICS (JSON)', JSON.stringify(stats, null, 1), 14000]],
    instruction: 'Write the targeting analysis from these statistics only.', numCtx: cfg.numCtx,
  });
  await progress(`analysing with ${cfg.model}`);
  const out = await runTask({ env, agent: 'evaluator', cfg, system: PATTERNS_SYSTEM_PROMPT, messages, log, progress, cancelled, numPredict: 2200 });
  if (await cancelled()) return null;
  await progress('done');
  const t = stats.totals;
  return finish({ job, kind: 'patterns', title: `Patterns — ${t.reports} scored · ${t.rejected} rejected · ${t.positive} advancing (${new Date().toISOString().slice(0, 10)})`, markdown: out.content, data: { stats }, agent: 'evaluator', cfg, out });
}
