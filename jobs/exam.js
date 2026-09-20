// exam — run a model on the held-out examples and measure agreement with the
// teacher: score MAE, share within ±0.5, archetype + legitimacy agreement.
//   payload { tag, agent: 'evaluator', limit (1–20) }
import { getAgentsConfig } from '../lib/firestore.js';
import { DEFAULT_AGENTS_CONFIG, buildEvaluatorMessages, buildSummaryMessages, parseScoreSummary, collapseRepeats, normalizeLegitimacy } from '../lib/prompts.js';
import { runAgent } from '../lib/llm.js';
import { listExamples, saveModel, getModel } from '../lib/training.js';

// Archetype agreement: normalise both, then accept containment either way so
// "Other: Business Analyst / Product Owner" agrees with "Other: Product Owner".
const archNorm = (a) => String(a ?? '').toLowerCase().replace(/^other:\s*/, '').replace(/[^a-z]+/g, ' ').trim();
const archMatch = (gold, got) => { const g = archNorm(gold), h = archNorm(got); return !!g && !!h && (g.includes(h) || h.includes(g)); };

export async function run({ job, env, log, progress, cancelled }) {
  const { payload } = job;
  const tag = String(payload.tag || '').trim();
  if (!tag) throw new Error('exam needs a model tag');
  const limit = Math.min(20, Math.max(1, Math.round(Number(payload.limit) || 6)));
  const config = await getAgentsConfig(DEFAULT_AGENTS_CONFIG);
  const cfg = { ...config.agents.evaluator, model: tag };
  const exam = (await listExamples({ agent: 'evaluator', approvedOnly: true, split: 'exam' })).slice(0, limit);
  if (!exam.length) throw new Error('no exam examples yet — generate gold first (15% are held out)');

  const cases = [];
  const t0 = Date.now();
  for (let i = 0; i < exam.length; i++) {
    if (await cancelled()) break;
    const ex = exam[i];
    await progress(`case ${i + 1}/${exam.length} — ${ex.company} (${tag})`);
    const messages = buildEvaluatorMessages({ system: cfg.systemPrompt, cv: ex.cv, profileYaml: ex.profileYaml ?? '', jd: ex.jd, url: null, numCtx: cfg.numCtx });
    const c0 = Date.now();
    let out;
    try { out = await runAgent({ env, agent: 'evaluator', cfg, messages, log: async () => {}, progress: async () => {}, cancelled }); }
    catch (e) { if (e.message === 'cancelled') throw e; cases.push({ id: ex.id, company: ex.company, error: e.message }); await log(`case ${i + 1}: failed — ${e.message}`); continue; }
    const cleaned = collapseRepeats(out.content);
    let s = parseScoreSummary(cleaned);
    let viaSummaryPass = false;
    // Same fallback production uses (jobs/evaluate.js): a short second pass that extracts the block.
    if (!s.found || s.score == null) {
      try {
        const sum = await runAgent({ env, agent: 'evaluator', cfg: { ...cfg, temperature: 0 }, messages: buildSummaryMessages(cleaned), log: async () => {}, progress: async () => {}, cancelled, optionOverrides: { num_predict: 160, num_ctx: 8192 } });
        const s2 = parseScoreSummary(sum.content);
        if (s2.found && s2.score != null) { s = { ...s2, found: true }; viaSummaryPass = true; }
      } catch (e) { if (e.message === 'cancelled') throw e; }
    }
    const gold = ex.summary ?? {};
    const c = {
      id: ex.id, company: ex.company, role: ex.role, seconds: Math.round((Date.now() - c0) / 1000),
      gold: { score: gold.score, archetype: gold.archetype, legitimacy: gold.legitimacy },
      got: { score: s.score, archetype: s.archetype, legitimacy: s.legitimacy, summaryFound: s.found, viaSummaryPass, raw: s.raw, tail: out.content.slice(-1200), doneReason: out.doneReason ?? null, tokens: out.usage?.completion ?? null },
      scoreDiff: s.score != null && gold.score != null ? Math.round(Math.abs(s.score - gold.score) * 100) / 100 : null,
      archetypeMatch: archMatch(gold.archetype, s.archetype),
      legitimacyMatch: normalizeLegitimacy(gold.legitimacy) === normalizeLegitimacy(s.legitimacy),
    };
    cases.push(c);
    await log(`case ${i + 1}: ${ex.company} · gold ${gold.score} vs ${s.score ?? '?'}${viaSummaryPass ? ' (2nd pass)' : ''} · archetype ${c.archetypeMatch ? '✓' : '✗'} · ${c.seconds}s`);
  }
  const scored = cases.filter((c) => c.scoreDiff != null);
  const result = {
    tag, n: cases.length, scored: scored.length,
    scoreMae: scored.length ? Math.round((scored.reduce((a, c) => a + c.scoreDiff, 0) / scored.length) * 100) / 100 : null,
    within05: scored.length ? Math.round((scored.filter((c) => c.scoreDiff <= 0.5).length / scored.length) * 100) : null,
    archetypeAgreement: cases.length ? Math.round((cases.filter((c) => c.archetypeMatch).length / cases.length) * 100) : null,
    legitimacyAgreement: cases.length ? Math.round((cases.filter((c) => c.legitimacyMatch).length / cases.length) * 100) : null,
    summaryRate: cases.length ? Math.round((cases.filter((c) => c.got?.summaryFound && !c.got?.viaSummaryPass).length / cases.length) * 100) : null,
    summaryPassRate: cases.length ? Math.round((cases.filter((c) => c.got?.viaSummaryPass).length / cases.length) * 100) : null,
    avgSeconds: cases.length ? Math.round(cases.reduce((a, c) => a + (c.seconds ?? 0), 0) / cases.length) : null,
    at: Date.now(), promptVersion: cfg.promptVersion, cases,
  };
  const existing = await getModel(tag);
  await saveModel(tag, { ...(existing ?? { source: 'ollama', agent: 'evaluator', createdAt: Date.now() }), exam: result, status: existing?.status ?? 'ready' });
  await log(`exam ${tag}: score MAE ${result.scoreMae} · within ±0.5 ${result.within05}% · archetype ${result.archetypeAgreement}% · summary block ${result.summaryRate}% · ${Math.round((Date.now() - t0) / 60000)} min`);
  await progress(`done — MAE ${result.scoreMae}, archetype ${result.archetypeAgreement}%`);
  return { ...result, cases: undefined };
}
