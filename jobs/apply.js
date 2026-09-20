// apply — the Writer as form assistant (modes/apply.md): one drafted answer per pasted
// question, knock-out questions flagged against the profile. The member edits and submits.
//   payload { reportJobId, questions: string[] }
import { APPLY_SYSTEM_PROMPT, buildTaskMessages, parseJsonObject } from '../lib/prompts.js';
import { loadContext, runTask, finish, str } from './_task.js';

export async function run({ job, env, log, progress, cancelled }) {
  const questions = (Array.isArray(job.payload.questions) ? job.payload.questions : []).map((q) => str(q, 600)).filter(Boolean).slice(0, 25);
  if (!questions.length) throw new Error('apply needs at least one question');
  await progress('loading the report');
  const { setup, cfg, report } = await loadContext({ job, env, agent: 'writer', reportJobId: str(job.payload.reportJobId, 40) });
  const messages = buildTaskMessages({
    system: APPLY_SYSTEM_PROMPT, cv: setup.cvMarkdown, profileYaml: setup.profileYaml, jd: report.jd, report: report.markdown,
    extra: [['THE FORM QUESTIONS (one per line, answer every one, keep the wording verbatim)', questions.map((q, i) => `${i + 1}. ${q}`).join('\n'), 12000]],
    instruction: `Role: **${report.role}** at **${report.company}**. Return the JSON object with ${questions.length} answers.`, numCtx: cfg.numCtx, cvShare: 0.4,
  });
  await progress(`drafting ${questions.length} answer${questions.length === 1 ? '' : 's'} with ${cfg.model}`);
  const out = await runTask({ env, agent: 'writer', cfg, system: APPLY_SYSTEM_PROMPT, messages, log, progress, cancelled, format: 'json', numPredict: Math.min(6000, 400 + questions.length * 260) });
  if (await cancelled()) return null;
  let answers = [];
  try {
    const j = parseJsonObject(out.content);
    answers = (Array.isArray(j.answers) ? j.answers : []).map((a, i) => ({ question: str(a.question, 600) || questions[i] || '', answer: str(a.answer, 4000), knockout: a.knockout ? str(a.knockout, 400) : null })).filter((a) => a.answer);
  } catch (e) { await log(`model did not return clean JSON (${e.message}) — keeping the raw text`); }
  // Every question gets a slot even when the model skipped it.
  const byQ = new Map(answers.map((a) => [a.question.toLowerCase(), a]));
  const full = questions.map((q, i) => byQ.get(q.toLowerCase()) ?? answers[i] ?? { question: q, answer: '', knockout: null });
  const knock = full.filter((a) => a.knockout).length;
  const markdown = full.map((a, i) => `### ${i + 1}. ${a.question}\n${a.knockout ? `> ⚠️ Knock-out check: ${a.knockout}\n\n` : ''}${a.answer || '_(no draft — answer this one yourself)_'}`).join('\n\n');
  await progress(`done — ${full.length} answers${knock ? `, ${knock} knock-out flag${knock === 1 ? '' : 's'}` : ''}`);
  return finish({ job, kind: 'apply', title: `Application answers: ${report.company} — ${report.role} (${full.length})`, markdown, data: { answers: full, knockouts: knock }, agent: 'writer', cfg, out, report });
}
