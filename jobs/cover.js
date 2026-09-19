// cover — the Writer agent: cover letter (JSON) → career-ops letter template → PDF.
//   payload { reportJobId, angle?: string }   (angle = the member's own "why this role")
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSetup, getAgentsConfig, getReport, saveDoc, getProfile } from '../lib/firestore.js';
import { ensureUserRoot, slug } from '../lib/user-root.js';
import { DEFAULT_AGENTS_CONFIG, buildWriterMessages, parseJsonObject, reportExcerpt } from '../lib/prompts.js';
import { runAgent } from '../lib/llm.js';
import { parseProfile, kebab } from '../lib/profile.js';
import { buildCoverHtml, renderPdf, writeJson } from '../lib/render.js';
import { savePdf } from '../lib/storage.js';

const str = (v) => (v == null ? '' : String(v).trim());
const arr = (v) => (Array.isArray(v) ? v : []);

export async function run({ job, env, log, progress, cancelled }) {
  const { uid, payload } = job;
  const reportJobId = str(payload.reportJobId);
  if (!reportJobId) throw new Error('cover needs a reportJobId');
  const angle = str(payload.angle).slice(0, 1500);

  await progress('loading your CV, profile and the report');
  const [setup, config, report] = await Promise.all([getSetup(uid), getAgentsConfig(DEFAULT_AGENTS_CONFIG), getReport(uid, reportJobId)]);
  if (!report) throw new Error('report not found — evaluate the job first');
  if (!report.jd) throw new Error('this report has no saved job description — re-run the evaluation');
  const cfg = { ...config.agents.writer, ...(payload.model ? { model: String(payload.model) } : {}) };
  if (!cfg.enabled) throw new Error('The Writer agent is switched off by the admin');
  const root = await ensureUserRoot(env, uid, setup);
  const prof = parseProfile(setup.profileYaml);

  await progress(`drafting with ${cfg.model}`);
  const messages = buildWriterMessages({ system: cfg.systemPrompt, cv: setup.cvMarkdown, profileYaml: setup.profileYaml ?? '', jd: report.jd, reportExcerpt: reportExcerpt(report.markdown ?? ''), angle, numCtx: cfg.numCtx });
  const out = await runAgent({ env, agent: 'writer', cfg, messages, log, progress, cancelled, format: 'json' });
  if (await cancelled()) return null;
  const j = parseJsonObject(out.content);
  const letter = {
    role_title: str(j.role_title) || report.role, company: str(j.company) || report.company, city: str(j.city),
    date: new Date().toISOString().slice(0, 10), greeting: str(j.greeting) || 'Dear Hiring Manager,',
    opening: str(j.opening), profile_intro: str(j.profile_intro),
    achievements: arr(j.achievements).map((a) => ({ lead: str(a.lead).replace(/[,.;:]\s*$/, ''), impact: str(a.impact) })).filter((a) => a.lead && a.impact).slice(0, 3),
    problems_section: str(j.problems_section), closing: str(j.closing),
    signature: { valediction: 'Kind regards,', name: prof.name || '' },
  };
  if (!letter.opening || !letter.profile_intro) throw new Error('the model did not return a usable letter — try again or pick a larger model in Admin → Agents');
  const words = [letter.opening, letter.profile_intro, ...letter.achievements.map((a) => `${a.lead} ${a.impact}`), letter.problems_section, letter.closing].join(' ').split(/\s+/).filter(Boolean).length;
  await log(`letter drafted: ${words} words, ${letter.achievements.length} achievements`);

  await progress('rendering the PDF');
  const coverPayload = {
    candidate: { name: prof.name || 'Candidate', email: prof.email, phone: prof.phone || undefined, location: prof.location, linkedin: prof.linkedin || undefined, github: prof.github || undefined },
    letter,
  };
  const date = letter.date;
  const base = `cover-${kebab(prof.name)}-${slug(report.company)}-${date}`;
  await writeJson(join(root, 'output', `${base}.json`), coverPayload);
  const html = await buildCoverHtml(env, coverPayload);
  const pdfPath = join(root, 'output', `${base}.pdf`);
  const r = await renderPdf(env, html, pdfPath, { format: 'a4', maxPages: 1, workspaceRoot: root });
  const memberLabel = (await getProfile(uid))?.email || uid;
  const stored = await savePdf(uid, `${base}.pdf`, await readFile(pdfPath), { log, memberLabel });

  const text = [letter.greeting, '', letter.opening, '', letter.profile_intro, '', ...letter.achievements.map((a) => `• ${a.lead}, ${a.impact}`), '', letter.problems_section, '', letter.closing, '', 'Kind regards,', prof.name].join('\n');
  const doc = {
    kind: 'cover', jobId: job.id, reportJobId, company: report.company, role: report.role, file: `${base}.pdf`,
    ...stored, pageCount: r.pageCount, words, letter, text, angle: angle || null,
    keywordsUsed: arr(j.keywords_used).map(str).filter(Boolean).slice(0, 30),
    agent: 'writer', model: cfg.model, promptVersion: cfg.promptVersion, via: out.via, usage: out.usage, durationMs: out.durationMs,
  };
  await saveDoc(uid, job.id, doc);
  await progress(`done — ${base}.pdf`);
  return { file: `${base}.pdf`, words, storage: stored.storage, via: out.via, durationMs: out.durationMs };
}
