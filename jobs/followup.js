// followup — the Writer drafts the nudge for one quiet card (modes/followup.md).
//   payload { opportunityId, company, role, stage, daysSince, channel: email|linkedin, lastNote?, reportJobId? }
import { FOLLOWUP_SYSTEM_PROMPT, buildTaskMessages, parseJsonObject } from '../lib/prompts.js';
import { loadContext, runTask, finish, str } from './_task.js';

export async function run({ job, env, log, progress, cancelled }) {
  const p = job.payload;
  const company = str(p.company, 120); if (!company) throw new Error('followup needs a company');
  const channel = p.channel === 'linkedin' ? 'linkedin' : 'email';
  const days = Math.max(0, Math.round(Number(p.daysSince) || 0));
  await progress('loading your CV');
  const { setup, cfg, report } = await loadContext({ job, env, agent: 'writer', reportJobId: str(p.reportJobId, 40) });
  const card = [`Company: ${company}`, p.role ? `Role: ${str(p.role, 160)}` : '', `Stage on the board: ${str(p.stage, 60)}`, `Days since the last activity: ${days}`, p.lastNote ? `Last note on the card: ${str(p.lastNote, 600)}` : ''].filter(Boolean).join('\n');
  const messages = buildTaskMessages({
    system: FOLLOWUP_SYSTEM_PROMPT, cv: setup.cvMarkdown, profileYaml: setup.profileYaml, jd: report?.jd, report: report?.markdown,
    extra: [['THE CARD', card, 1500]],
    instruction: `Channel: **${channel === 'email' ? 'email (under 120 words, with a subject)' : 'LinkedIn message (under 300 characters, no subject)'}**. Return the JSON object.`, numCtx: cfg.numCtx, cvShare: 0.4,
  });
  await progress(`drafting with ${cfg.model}`);
  const out = await runTask({ env, agent: 'writer', cfg, system: FOLLOWUP_SYSTEM_PROMPT, messages, log, progress, cancelled, format: 'json', numPredict: 600 });
  if (await cancelled()) return null;
  let subject = '', body = '', note = '';
  try { const j = parseJsonObject(out.content); subject = str(j.subject, 200); body = str(j.body, 2000); note = str(j.note, 400); }
  catch { body = out.content.trim(); }
  if (channel === 'linkedin' && body.length > 300) await log(`warning: LinkedIn message is ${body.length} characters — trim before sending`);
  const markdown = [subject ? `**Subject:** ${subject}\n` : '', body, note ? `\n\n---\n_If there's still no reply:_ ${note}` : ''].join('\n');
  await progress('done');
  return finish({ job, kind: 'followup', title: `Follow-up (${channel}): ${company}${p.role ? ` — ${str(p.role, 160)}` : ''} · ${days}d quiet`, markdown, data: { subject, body, note, channel, daysSince: days, stage: str(p.stage, 60) }, agent: 'writer', cfg, out, report, extra: { company, role: str(p.role, 160), opportunityId: str(p.opportunityId, 40) } });
}
