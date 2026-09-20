// contacto — the Researcher as outreach helper (modes/contacto.md): the one person to
// contact for a scored role + a DM under 300 characters in the persona framework.
//   payload { reportJobId, target: hiring_manager|recruiter|peer|interviewer, personName?, personRole? }
import { claudeConfigured, research, TEACHER_MODEL } from '../lib/claude.js';
import { CONTACTO_SYSTEM_PROMPT, buildTaskMessages, parseDelimited } from '../lib/prompts.js';
import { loadContext, runTask, finish, str } from './_task.js';

const TARGETS = { hiring_manager: 'Hiring manager', recruiter: 'Recruiter', peer: 'Team peer (indirect referral — never ask for a job)', interviewer: 'Interviewer (pre-interview)' };

export async function run({ job, env, log, progress, cancelled }) {
  const target = TARGETS[job.payload.target] ? job.payload.target : 'hiring_manager';
  const personName = str(job.payload.personName, 120), personRole = str(job.payload.personRole, 120);
  await progress('loading the report');
  const { setup, cfg, report } = await loadContext({ job, env, agent: 'researcher', reportJobId: str(job.payload.reportJobId, 40) });
  const system = cfg.systemPrompt && cfg.promptVersion > 1 ? cfg.systemPrompt : CONTACTO_SYSTEM_PROMPT; // the admin prompt is the deep-dive one; contacto keeps its own unless edited past v1
  const known = personName || personRole ? `The candidate already has a target in mind: ${[personName, personRole].filter(Boolean).join(' — ')}. Write the message for them.` : '';
  const instruction = `Role: **${report.role}** at **${report.company}**${report.url ? ` (${report.url})` : ''}. Contact type: **${TARGETS[target]}**. ${known} Pick the target and draft the DM (under 300 characters).`;

  let out, sources = null;
  if (claudeConfigured() && !personName) {
    await progress(`finding the ${TARGETS[target].toLowerCase()} at ${report.company}`);
    const [{ content: user }] = buildTaskMessages({ system, cv: setup.cvMarkdown, profileYaml: setup.profileYaml, jd: report.jd, report: report.markdown, instruction: instruction + ' Use at most three web searches; stop at the first confirmed person.', numCtx: 60000 }).slice(1);
    const r = await research({ system, user, log, maxSearches: 3, maxTokens: 3000 });
    out = { content: r.text, via: 'claude', model: r.servedBy || TEACHER_MODEL, durationMs: r.durationMs, usage: r.usage };
    sources = r.sources;
  } else {
    await progress(`drafting with ${cfg.model}`);
    const messages = buildTaskMessages({ system, cv: setup.cvMarkdown, profileYaml: setup.profileYaml, jd: report.jd, report: report.markdown, instruction: instruction + (personName ? '' : ' You have no web access: do not name anyone — describe the exact title to search for on LinkedIn.'), numCtx: cfg.numCtx });
    out = await runTask({ env, agent: 'researcher', cfg, system, messages, log, progress, cancelled, numPredict: 900 });
  }
  if (await cancelled()) return null;
  let dm = parseDelimited(out.content, '---DM---', '---END---').replace(/^["“]|["”]$/g, '').trim();
  if (!dm) { const m = out.content.match(/## Message\s*\n+([\s\S]*?)\n(?:\(|##)/); dm = m ? m[1].trim().split('\n')[0] : ''; }
  if (dm.length > 300) await log(`warning: DM is ${dm.length} characters (limit 300) — trim before sending`);
  const markdown = out.content.replace(/---DM---[\s\S]*$/, '').trim();
  await progress(`done — ${dm.length} character DM`);
  return finish({ job, kind: 'contacto', title: `Outreach: ${TARGETS[target].split(' (')[0]} at ${report.company} — ${report.role}`, markdown, data: { dm, dmChars: dm.length, target, personName, personRole }, sources, agent: 'researcher', cfg, out, report });
}
