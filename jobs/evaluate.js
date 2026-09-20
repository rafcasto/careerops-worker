// evaluate — the Evaluator agent, end to end:
//   payload { jd?: string, url?: string, model?: string, autoPipeline?: boolean }
//   autoPipeline (Sourcing → pipeline): after the report, log a pending card on the
//   member's Progress board and, when the score clears 4.0, run the Tailor for the PDF.
//   → member setup (cv + profile) → JD → n8n/Ollama → A–G report
//   → reports/NNN-company-date.md in the member's root → Firestore mirror.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSetup, getAgentsConfig, saveReport } from '../lib/firestore.js';
import { ensureUserRoot, nextReportNumber, slug } from '../lib/user-root.js';
import { DEFAULT_AGENTS_CONFIG, buildEvaluatorMessages, buildSummaryMessages, parseScoreSummary, collapseRepeats } from '../lib/prompts.js';
import { runAgent } from '../lib/llm.js';
import { extractJd } from '../lib/extract.js';
import { setPipelineStatus, addOpportunityForReport } from '../lib/firestore.js';
import { run as runPdf } from './pdf.js';

export async function run({ job, env, log, progress, cancelled }) {
  const { uid, payload } = job;
  const url = typeof payload.url === 'string' && payload.url.trim() ? payload.url.trim() : null;
  let jd = typeof payload.jd === 'string' ? payload.jd.trim() : '';
  if (!jd && !url) throw new Error('Nothing to evaluate — paste a job description or a URL');

  await progress('loading your CV and profile');
  const [setup, config] = await Promise.all([getSetup(uid), getAgentsConfig(DEFAULT_AGENTS_CONFIG)]);
  const cfg = { ...config.agents.evaluator, ...(payload.model ? { model: String(payload.model) } : {}) };
  if (!cfg.enabled) throw new Error('The Evaluator agent is switched off by the admin');
  const root = await ensureUserRoot(env, uid, setup);
  await log(`member root ${root} · model ${cfg.model} · ctx ${cfg.numCtx} · prompt v${cfg.promptVersion}`);

  let title = '';
  if (!jd) {
    await progress('reading the posting');
    const ex = await extractJd(env, url, { log });
    jd = ex.text; title = ex.title;
    await log(`extracted ${jd.length} chars from ${url}${title ? ` — "${title}"` : ''}`);
  }
  if (await cancelled()) return null;

  await progress(`evaluating with ${cfg.model}`);
  const messages = buildEvaluatorMessages({ system: cfg.systemPrompt, cv: setup.cvMarkdown, profileYaml: setup.profileYaml ?? '', jd, url, numCtx: cfg.numCtx });
  const out = await runAgent({ env, agent: 'evaluator', cfg, messages, log, progress, cancelled });
  if (await cancelled()) return null;

  const cleaned = collapseRepeats(out.content);
  if (cleaned.length < out.content.length * 0.8) await log(`collapsed repeated blocks: ${out.content.length} → ${cleaned.length} chars`);
  let s = parseScoreSummary(cleaned);
  if (out.doneReason === 'length') await log('warning: answer hit the output cap (num_predict) — the report may be cut short');
  if (!s.found) {
    // Small models often forget the machine block. A short second pass over the
    // report is cheap (≈150 tokens out) and gives us company / score reliably.
    await progress('extracting the score');
    await log('model did not emit SCORE_SUMMARY — running the summary pass');
    try {
      const sum = await runAgent({ env, agent: 'evaluator', cfg: { ...cfg, temperature: 0 }, messages: buildSummaryMessages(cleaned), log, progress, cancelled, optionOverrides: { num_predict: 160, num_ctx: 8192 } });
      const s2 = parseScoreSummary(sum.content);
      if (s2.found) s = { ...s2, body: s.body, found: true, viaSummaryPass: true };
      else await log(`summary pass produced no block either — score unknown. Output: ${JSON.stringify(sum.content.slice(0, 200))}`);
    } catch (e) { if (e.message === 'cancelled') throw e; await log(`summary pass failed: ${e.message}`); }
  }
  // Last resort: Block A often carries company/role as bold labels.
  if (s.company === 'Unknown') { const m = cleaned.match(/\*\*COMPANY:?\*\*:?\s*([^\n|]+)/i) || cleaned.match(/\|\s*Company\s*\|\s*([^|\n]+)/i); if (m) s.company = m[1].trim(); }
  if (s.role === 'Unknown') { const m = cleaned.match(/\*\*ROLE:?\*\*:?\s*([^\n|]+)/i) || cleaned.match(/\|\s*Role\s*\|\s*([^|\n]+)/i); if (m) s.role = m[1].trim(); }
  const today = new Date().toISOString().slice(0, 10);
  const n = await nextReportNumber(root);
  const num = String(n).padStart(3, '0');
  const filename = `${num}-${slug(s.company)}-${today}.md`;
  const markdown = `# Evaluation: ${s.company} — ${s.role}

**Date:** ${today}
**Archetype:** ${s.archetype}
**Score:** ${s.score ?? '?'}/5
**URL:** ${url ?? '(pasted)'}
**Legitimacy:** ${s.legitimacy}
**Tool:** ${out.via === 'n8n' ? 'n8n careerops/evaluator' : 'Ollama'} (${cfg.model})

---

${s.body}
`;
  await writeFile(join(root, 'reports', filename), markdown, 'utf8');
  await writeFile(join(root, 'jds', `${num}-${slug(s.company)}.txt`), jd, 'utf8');
  await log(`report saved: reports/${filename}`);

  const report = {
    jobId: job.id, n, file: filename, company: s.company, role: s.role, url, title: title || null,
    score: s.score, archetype: s.archetype, legitimacy: s.legitimacy, summaryFound: s.found,
    markdown, agent: 'evaluator', model: cfg.model, promptVersion: cfg.promptVersion, via: out.via,
    usage: out.usage, doneReason: out.doneReason ?? null, viaSummaryPass: !!s.viaSummaryPass, durationMs: out.durationMs, jdChars: jd.length,
    jd: jd.slice(0, 20000), pipelineId: typeof payload.pipelineId === 'string' ? payload.pipelineId : null,
  };
  await saveReport(uid, job.id, report);
  if (report.pipelineId) await setPipelineStatus(uid, report.pipelineId, { status: 'evaluated', reportJobId: job.id, score: s.score });
  let auto = null;
  if (payload.autoPipeline === true) {
    auto = { opportunityId: null, pdf: null };
    try { auto.opportunityId = await addOpportunityForReport(uid, job.id, report); await log(`auto-pipeline: pending card ${auto.opportunityId} on the Progress board`); }
    catch (e) { await log(`auto-pipeline: could not add the board card — ${e.message}`); }
    if (s.score != null && s.score >= 4.0) {
      await progress('auto-pipeline: tailoring the CV');
      try { auto.pdf = await runPdf({ job: { ...job, payload: { reportJobId: job.id } }, env, log, progress, cancelled }); }
      catch (e) { if (e.message === 'cancelled') throw e; await log(`auto-pipeline: tailor failed — ${e.message}`); }
    } else await log(`auto-pipeline: score ${s.score ?? '?'} < 4.0 — no CV tailored (career-ops: don't spend time below 4.0)`);
  }
  await progress(`done — ${s.company} · ${s.score ?? '?'}/5`);
  return { company: s.company, role: s.role, score: s.score, archetype: s.archetype, legitimacy: s.legitimacy, file: filename, via: out.via, durationMs: out.durationMs, ...(auto ? { auto } : {}) };
}
