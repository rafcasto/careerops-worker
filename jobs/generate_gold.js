// generate_gold — Claude as the teacher. For N synthetic cases: invent a
// candidate (CV + profile) and a JD in the target market, then evaluate it
// with the FULL career-ops rubric, producing the exact report format the Pi
// student is trained to emit. Every case is stored as an approved example.
//   payload { agent: 'evaluator', count (1–20), roles: string[], market: string,
//             cvSource: 'synthetic' | 'setup', fitMix?: 'balanced' }
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeConfigured, teach, TEACHER_MODEL } from '../lib/claude.js';
import { getSetup, getAgentsConfig } from '../lib/firestore.js';
import { DEFAULT_AGENTS_CONFIG, buildEvaluatorMessages, parseScoreSummary, parseJsonObject } from '../lib/prompts.js';
import { saveExample, exampleId, EXAM_SHARE } from '../lib/training.js';

const CASE_SYSTEM = `You create realistic, varied synthetic training cases for a job-search evaluator used in the given market. Output ONLY a JSON object, no prose, no fences.

Each case is one candidate and one job posting. Make them feel real: concrete employers (invented but plausible), dates, numbers, tools, sector jargon, salary in local currency, location and remote policy, and the occasional flaw (vague JD, missing salary, a requirement contradiction, an unrealistic ask). Vary seniority, sector, company type and — above all — FIT: the case must land on the requested fit level.

JSON shape:
{
  "company": "string",
  "roleTitle": "string",
  "jd": "the full job posting text, 250–600 words, as it would appear on a careers page",
  "cvMarkdown": "the candidate's CV in Markdown, 350–700 words: name line, contact line, summary, experience with dated roles and quantified bullets, skills, education",
  "profileYaml": "career-ops config/profile.yml for this candidate: candidate{full_name,email,location}, target_roles{primary[]}, compensation{target_range,minimum}, location{country,city,authorized_in[]}",
  "intendedFit": "strong | good | borderline | poor",
  "notes": "one line on what makes this case interesting"
}`;

const FITS = ['strong', 'good', 'borderline', 'poor', 'good', 'borderline'];

export async function run({ job, env, log, progress, cancelled }) {
  if (!claudeConfigured()) throw new Error('ANTHROPIC_API_KEY is not set on the Pi — add it to careerops-worker/.env');
  const { payload } = job;
  const agent = payload.agent === 'evaluator' ? 'evaluator' : null;
  if (!agent) throw new Error('only the evaluator agent can be trained in this version');
  const count = Math.min(20, Math.max(1, Math.round(Number(payload.count) || 5)));
  const roles = Array.isArray(payload.roles) && payload.roles.length ? payload.roles.map(String).slice(0, 10) : ['Product Owner', 'Product Manager'];
  const market = String(payload.market || 'New Zealand');
  const cvSource = payload.cvSource === 'setup' ? 'setup' : 'synthetic';

  const config = await getAgentsConfig(DEFAULT_AGENTS_CONFIG);
  const studentPrompt = config.agents.evaluator.systemPrompt;
  const rubric = [
    await readFile(join(env.repo, 'modes', '_shared.md'), 'utf8'),
    await readFile(join(env.repo, 'modes', 'oferta.md'), 'utf8'),
  ].join('\n\n');
  // The student's prompt first (that is the format we want back), then the full
  // upstream rubric as reference material — cached across every case of the job.
  const teacherSystem = [
    { type: 'text', text: studentPrompt },
    { type: 'text', text: `\n\n══════ REFERENCE: the full career-ops rubric (modes/_shared.md + modes/oferta.md). Use it to JUDGE; but WRITE the report in exactly the format specified above (Blocks A–G, Verdict, SCORE_SUMMARY). You have no web access: label compensation figures as estimates and judge legitimacy from the JD text only.\n\n${rubric}`, cache_control: { type: 'ephemeral' } },
  ];

  let setupCv = null, setupProfile = '';
  if (cvSource === 'setup') {
    const setup = await getSetup(job.uid);
    if (!setup?.cvMarkdown) throw new Error('cvSource=setup but the admin account has no CV in Agents → Setup');
    setupCv = setup.cvMarkdown; setupProfile = setup.profileYaml ?? '';
  }

  const made = [];
  let totalUsage = { input: 0, output: 0, cacheRead: 0 };
  for (let i = 0; i < count; i++) {
    if (await cancelled()) break;
    const role = roles[i % roles.length];
    const fit = FITS[i % FITS.length];
    await progress(`case ${i + 1}/${count} — inventing a ${fit}-fit ${role} posting`);
    const caseReq = cvSource === 'setup'
      ? `Market: ${market}. Role family: ${role}. Requested fit: ${fit}.\nThe candidate is FIXED — do not invent one. Return cvMarkdown and profileYaml EXACTLY as given below, and invent only the company, roleTitle and jd so that this candidate is a ${fit} fit.\n\nCV:\n${setupCv}\n\nprofile.yml:\n${setupProfile}`
      : `Market: ${market}. Role family: ${role}. Requested fit: ${fit}. Case number ${i + 1} of ${count} — make it different from typical cases (sector, company size, seniority).`;
    const c = await teach({ system: CASE_SYSTEM, user: caseReq, maxTokens: 8000, effort: 'medium', log });
    const cs = parseJsonObject(c.text);
    const jd = String(cs.jd ?? '').trim(), cv = String(cs.cvMarkdown ?? '').trim(), profileYaml = String(cs.profileYaml ?? '').trim();
    if (jd.length < 300 || cv.length < 300) { await log(`case ${i + 1}: generator returned too little text — skipped`); continue; }

    await progress(`case ${i + 1}/${count} — teacher evaluating ${cs.company ?? role}`);
    const msgs = buildEvaluatorMessages({ system: studentPrompt, cv, profileYaml, jd, url: null, numCtx: 32768 });
    const t = await teach({ system: teacherSystem, user: msgs[1].content, maxTokens: 16000, effort: 'high', log });
    const s = parseScoreSummary(t.text);
    if (!s.found || s.score == null) { await log(`case ${i + 1}: teacher report had no SCORE_SUMMARY — skipped`); continue; }

    const id = exampleId(jd, cv);
    const split = Math.random() < EXAM_SHARE ? 'exam' : 'train';
    await saveExample({
      id, agent, source: 'claude', split, approved: true,
      company: String(cs.company ?? s.company), role: String(cs.roleTitle ?? s.role), market, intendedFit: String(cs.intendedFit ?? fit), notes: String(cs.notes ?? ''),
      cv, profileYaml, jd, report: t.text.trim(),
      summary: { company: s.company, role: s.role, score: s.score, archetype: s.archetype, legitimacy: s.legitimacy },
      teacherModel: t.servedBy || TEACHER_MODEL, studentPromptVersion: config.agents.evaluator.promptVersion,
      usage: { case: c.usage, teacher: t.usage }, jobId: job.id, createdBy: job.createdBy,
    });
    for (const u of [c.usage, t.usage]) { totalUsage.input += u.input; totalUsage.output += u.output; totalUsage.cacheRead += u.cacheRead; }
    made.push({ id, company: cs.company, role: cs.roleTitle, fit, score: s.score, split });
    await log(`case ${i + 1}: ${cs.company} — ${cs.roleTitle} · intended ${fit} → teacher score ${s.score} (${s.archetype}) · ${split}`);
  }
  await progress(`done — ${made.length} gold example${made.length === 1 ? '' : 's'}`);
  return { made: made.length, examples: made, usage: totalUsage, teacher: TEACHER_MODEL };
}
