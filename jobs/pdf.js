// pdf — the Tailor agent: JD-tailored CV → career-ops HTML template → PDF.
//   payload { reportJobId, template?: "cv-template.html" | "cv-template.modern.html" | … }
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSetup, getAgentsConfig, getReport, saveDoc, getProfile } from '../lib/firestore.js';
import { ensureUserRoot, slug } from '../lib/user-root.js';
import { DEFAULT_AGENTS_CONFIG, buildTailorMessages, parseJsonObject, reportExcerpt } from '../lib/prompts.js';
import { runAgent } from '../lib/llm.js';
import { parseProfile, kebab } from '../lib/profile.js';
import { buildCvHtml, renderPdf, writeJson } from '../lib/render.js';
import { savePdf } from '../lib/storage.js';

const TEMPLATES = new Set(['cv-template.html', 'cv-template.modern.html', 'cv-template.compact.html', 'cv-template.executive.html', 'cv-template.leadership.html', 'cv-template.jake.html']);
const str = (v) => (v == null ? '' : String(v).trim());
const arr = (v) => (Array.isArray(v) ? v : []);

export async function run({ job, env, log, progress, cancelled }) {
  const { uid, payload } = job;
  const reportJobId = str(payload.reportJobId);
  if (!reportJobId) throw new Error('pdf needs a reportJobId');
  const template = TEMPLATES.has(payload.template) ? payload.template : 'cv-template.html';

  await progress('loading your CV, profile and the report');
  const [setup, config, report] = await Promise.all([getSetup(uid), getAgentsConfig(DEFAULT_AGENTS_CONFIG), getReport(uid, reportJobId)]);
  if (!report) throw new Error('report not found — evaluate the job first');
  if (!report.jd) throw new Error('this report has no saved job description — re-run the evaluation');
  const cfg = { ...config.agents.tailor, ...(payload.model ? { model: String(payload.model) } : {}) };
  if (!cfg.enabled) throw new Error('The Tailor agent is switched off by the admin');
  const root = await ensureUserRoot(env, uid, setup);
  const prof = parseProfile(setup.profileYaml);
  await log(`tailoring for ${report.company} — ${report.role} · model ${cfg.model} · template ${template}`);

  await progress(`tailoring with ${cfg.model}`);
  const messages = buildTailorMessages({ system: cfg.systemPrompt, cv: setup.cvMarkdown, profileYaml: setup.profileYaml ?? '', jd: report.jd, reportExcerpt: reportExcerpt(report.markdown ?? ''), numCtx: cfg.numCtx });
  const out = await runAgent({ env, agent: 'tailor', cfg, messages, log, progress, cancelled, format: 'json' });
  if (await cancelled()) return null;
  const j = parseJsonObject(out.content);

  // Assemble the career-ops payload: identity from profile.yml, content from the model.
  const exp = arr(j.experience).map((e) => ({ company: str(e.company), role: str(e.role), location: str(e.location), dates: str(e.dates), bullets: arr(e.bullets).map(str).filter(Boolean) })).filter((e) => e.company && e.role);
  if (!str(j.summary) || exp.length === 0) throw new Error('the model did not return a usable CV (no summary or experience) — try again or pick a larger model in Admin → Agents');
  const cvPayload = {
    lang: 'en', page_format: 'a4',
    candidate: {
      name: prof.name || 'Candidate', email: prof.email, phone: prof.phone, location: prof.location,
      ...(prof.linkedin ? { linkedin: { url: prof.linkedin.startsWith('http') ? prof.linkedin : `https://${prof.linkedin}`, display: prof.linkedin.replace(/^https?:\/\//, '') } } : {}),
      ...(prof.github ? { github: { url: prof.github.startsWith('http') ? prof.github : `https://${prof.github}`, display: prof.github.replace(/^https?:\/\//, '') } } : {}),
      ...(prof.portfolio ? { portfolio: { url: prof.portfolio, display: prof.portfolio.replace(/^https?:\/\//, '') } } : {}),
    },
    sections: { summary: 'Professional Summary', competencies: 'Core Competencies', experience: 'Professional Experience', projects: 'Projects', education: 'Education', certifications: 'Certifications', skills: 'Skills' },
    summary: str(j.summary),
    competencies: arr(j.competencies).map(str).filter(Boolean).slice(0, 8),
    experience: exp,
    projects: arr(j.projects).map((p) => ({ name: str(p.name), url: str(p.url), tech: str(p.tech), description: str(p.description) })).filter((p) => p.name),
    education: arr(j.education).map((e) => ({ title: str(e.title), org: str(e.org), location: str(e.location), year: str(e.year) })).filter((e) => e.title),
    certifications: arr(j.certifications).map((c) => ({ title: str(c.title), org: str(c.org), year: str(c.year) })).filter((c) => c.title),
    skills: arr(j.skills).map((k) => ({ category: str(k.category), items: Array.isArray(k.items) ? k.items.map(str).join(', ') : str(k.items) })).filter((k) => k.items),
  };
  for (const k of ['projects', 'education', 'certifications', 'skills']) if (!cvPayload[k].length) delete cvPayload[k];
  if (!cvPayload.competencies.length) delete cvPayload.competencies;

  await progress('rendering the PDF');
  const date = new Date().toISOString().slice(0, 10);
  const base = `cv-${kebab(prof.name)}-${slug(report.company)}-${date}`;
  const payloadPath = join(root, 'output', `${base}.json`);
  const htmlPath = join(root, 'output', `${base}.html`);
  const pdfPath = join(root, 'output', `${base}.pdf`);
  await writeJson(payloadPath, cvPayload);
  await buildCvHtml(env, root, payloadPath, htmlPath, template);
  const html = await readFile(htmlPath, 'utf8');
  const r = await renderPdf(env, html, pdfPath, { format: 'a4', maxPages: 2, workspaceRoot: root });
  await log(`PDF rendered: output/${base}.pdf (${r.pageCount} page${r.pageCount === 1 ? '' : 's'}, ${Math.round(r.size / 1024)} kB)`);

  const memberLabel = (await getProfile(uid))?.email || uid;
  const stored = await savePdf(uid, `${base}.pdf`, await readFile(pdfPath), { log, memberLabel });
  const doc = {
    kind: 'cv', jobId: job.id, reportJobId, company: report.company, role: report.role, file: `${base}.pdf`, template,
    ...stored, pageCount: r.pageCount,
    keywordsUsed: arr(j.keywords_used).map(str).filter(Boolean).slice(0, 30), keywordsMissing: arr(j.keywords_missing).map(str).filter(Boolean).slice(0, 15),
    payload: cvPayload, agent: 'tailor', model: cfg.model, promptVersion: cfg.promptVersion, via: out.via, usage: out.usage, durationMs: out.durationMs,
  };
  await saveDoc(uid, job.id, doc);
  await progress(`done — ${base}.pdf`);
  return { file: `${base}.pdf`, pages: r.pageCount, size: r.size, storage: stored.storage, via: out.via, durationMs: out.durationMs };
}
