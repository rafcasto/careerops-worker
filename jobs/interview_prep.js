// interview_prep — company- and role-specific prep for whoever is in the room
// (modes/interview-prep.md). Uses the report, the JD, the CV and the latest deep-dive.
//   payload { reportJobId, audience: recruiter|hiring_manager|peer|panel, extra? }
import { latestNote } from '../lib/firestore.js';
import { INTERVIEW_PREP_SYSTEM_PROMPT, buildTaskMessages } from '../lib/prompts.js';
import { loadContext, runTask, finish, str } from './_task.js';

const AUDIENCES = { recruiter: 'Recruiter / HR screen', hiring_manager: 'Hiring manager', peer: 'Peer / technical interviewer', panel: 'Panel (recruiter + hiring manager + peers)' };

export async function run({ job, env, log, progress, cancelled }) {
  const audience = AUDIENCES[job.payload.audience] ? job.payload.audience : 'recruiter';
  await progress('loading the report and your research');
  const { uid, setup, cfg, report } = await loadContext({ job, env, agent: 'evaluator', reportJobId: str(job.payload.reportJobId, 40) });
  const deep = await latestNote(uid, 'deep', report.jobId) ?? await latestNote(uid, 'deep').then((n) => (n && n.company && report.company && n.company.toLowerCase() === report.company.toLowerCase() ? n : null));
  if (deep) await log(`using deep-dive from ${new Date(deep.createdAt).toISOString().slice(0, 10)}`);
  const messages = buildTaskMessages({
    system: INTERVIEW_PREP_SYSTEM_PROMPT, cv: setup.cvMarkdown, profileYaml: setup.profileYaml, jd: report.jd, report: report.markdown,
    extra: [['COMPANY RESEARCH (deep-dive)', deep?.markdown ?? '', 5000], ['WHAT THE CANDIDATE KNOWS ABOUT THE INTERVIEW', str(job.payload.extra, 2000), 2000]],
    instruction: `Audience: **${AUDIENCES[audience]}**. Role: **${report.role}** at **${report.company}**. Write the prep document.`, numCtx: cfg.numCtx, cvShare: 0.35,
  });
  await progress(`preparing with ${cfg.model}`);
  const out = await runTask({ env, agent: 'evaluator', cfg, system: INTERVIEW_PREP_SYSTEM_PROMPT, messages, log, progress, cancelled, numPredict: 3000 });
  if (await cancelled()) return null;
  await progress('done');
  return finish({ job, kind: 'interview_prep', title: `Interview prep — ${AUDIENCES[audience].split(' (')[0]}: ${report.company} — ${report.role}`, markdown: out.content, data: { audience, usedDeep: !!deep }, agent: 'evaluator', cfg, out, report });
}
