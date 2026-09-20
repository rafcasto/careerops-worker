// Shared plumbing for the CareerOps portal tasks (deep, contacto, advise,
// interview_prep, followup, apply, patterns): load the member's context, pick the
// agent config, run the model, save a careerOpsNote.
import { getSetup, getAgentsConfig, getReport, saveNote } from '../lib/firestore.js';
import { ensureUserRoot } from '../lib/user-root.js';
import { DEFAULT_AGENTS_CONFIG } from '../lib/prompts.js';
import { runAgent } from '../lib/llm.js';

export const str = (v, max = 4000) => (v == null ? '' : String(v).trim().slice(0, max));

export async function loadContext({ job, env, agent, reportJobId, needCv = true }) {
  const { uid, payload } = job;
  const [setup, config] = await Promise.all([getSetup(uid), getAgentsConfig(DEFAULT_AGENTS_CONFIG)]);
  const cfg = { ...(config.agents[agent] ?? DEFAULT_AGENTS_CONFIG.agents[agent]), ...(payload.model ? { model: String(payload.model) } : {}) };
  if (!cfg.enabled) throw new Error(`The ${agent} agent is switched off by the admin`);
  if (needCv) await ensureUserRoot(env, uid, setup);
  let report = null;
  if (reportJobId) {
    report = await getReport(uid, reportJobId);
    if (!report) throw new Error('report not found — score the posting first');
  }
  return { uid, setup: setup ?? {}, cfg, report, config };
}

// Run the agent with a task-specific system prompt (the admin-configured model still applies).
export async function runTask({ env, agent, cfg, system, messages, log, progress, cancelled, format = null, numPredict }) {
  const out = await runAgent({ env, agent, cfg: { ...cfg, systemPrompt: system }, messages, log, progress, cancelled, format, optionOverrides: numPredict ? { num_predict: numPredict } : {} });
  return out;
}

export async function finish({ job, kind, title, markdown, data = null, sources = null, agent, cfg, out, report = null, extra = {} }) {
  const note = {
    kind, title, company: report?.company ?? extra.company ?? null, role: report?.role ?? extra.role ?? null,
    reportJobId: report?.jobId ?? null, opportunityId: extra.opportunityId ?? null,
    markdown, ...(data ? { data } : {}), ...(sources ? { sources } : {}),
    agent, model: out.via === 'claude' ? out.model : cfg.model, via: out.via, durationMs: out.durationMs, usage: out.usage ?? null,
  };
  await saveNote(job.uid, job.id, note);
  return { kind, title, via: out.via, durationMs: out.durationMs };
}
