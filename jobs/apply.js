// apply — the Writer as form assistant (modes/apply.md): one drafted answer per question,
// knock-out questions flagged against the profile. The member edits and submits.
//   payload { reportJobId, questions: string[] }
// Before the model sees anything, the answer bank is consulted (lib/answers.js): a question
// the member already answered is reused verbatim; a standard-answer question (salary, right to
// work …) with no stored value is handed back as "needs you" instead of being guessed.
import { APPLY_SYSTEM_PROMPT, buildTaskMessages, parseJsonObject } from '../lib/prompts.js';
import { loadContext, runTask, finish, str } from './_task.js';
import { listAnswers, touchAnswers } from '../lib/firestore.js';
import { matchAnswers, STANDARD_ANSWERS } from '../lib/answers.js';
import { parseProfile } from '../lib/profile.js';

const labelOf = (key) => STANDARD_ANSWERS.find((s) => s.key === key)?.label ?? key;

export async function run({ job, env, log, progress, cancelled }) {
  const questions = (Array.isArray(job.payload.questions) ? job.payload.questions : []).map((q) => str(q, 600)).filter(Boolean).slice(0, 25);
  if (!questions.length) throw new Error('apply needs at least one question');
  await progress('loading the report and your answer bank');
  const { uid, setup, cfg, report } = await loadContext({ job, env, agent: 'writer', reportJobId: str(job.payload.reportJobId, 40) });
  const bank = await listAnswers(uid);
  const matched = matchAnswers(questions, bank, parseProfile(setup.profileYaml));
  const reused = matched.filter((m) => m.hit);
  const needsYou = matched.filter((m) => !m.hit && m.standardKey);
  const toDraft = matched.filter((m) => !m.hit && !m.standardKey).map((m) => m.question);
  await log(`${questions.length} question(s): ${reused.length} from your answer bank, ${needsYou.length} need a fact only you have, ${toDraft.length} to draft`);

  let drafted = new Map(); let out = { via: 'bank', model: 'answer bank', durationMs: 0, usage: null };
  if (toDraft.length) {
    const messages = buildTaskMessages({
      system: APPLY_SYSTEM_PROMPT, cv: setup.cvMarkdown, profileYaml: setup.profileYaml, jd: report.jd, report: report.markdown,
      extra: [['THE FORM QUESTIONS (one per line, answer every one, keep the wording verbatim)', toDraft.map((q, i) => `${i + 1}. ${q}`).join('\n'), 12000]],
      instruction: `Role: **${report.role}** at **${report.company}**. Return the JSON object with ${toDraft.length} answers.`, numCtx: cfg.numCtx, cvShare: 0.4,
    });
    await progress(`drafting ${toDraft.length} answer${toDraft.length === 1 ? '' : 's'} with ${cfg.model}`);
    out = await runTask({ env, agent: 'writer', cfg, system: APPLY_SYSTEM_PROMPT, messages, log, progress, cancelled, format: 'json', numPredict: Math.min(6000, 400 + toDraft.length * 260) });
    if (await cancelled()) return null;
    try {
      const j = parseJsonObject(out.content);
      const answers = (Array.isArray(j.answers) ? j.answers : []).map((a, i) => ({ question: str(a.question, 600) || toDraft[i] || '', answer: str(a.answer, 4000), knockout: a.knockout ? str(a.knockout, 400) : null })).filter((a) => a.answer);
      drafted = new Map(answers.map((a) => [a.question.toLowerCase(), a]));
      toDraft.forEach((q, i) => { if (!drafted.has(q.toLowerCase()) && answers[i]) drafted.set(q.toLowerCase(), answers[i]); });
    } catch (e) { await log(`model did not return clean JSON (${e.message}) — keeping the raw text`); }
  }

  const full = matched.map((m) => {
    if (m.hit) return { question: m.question, answer: m.hit.answer, knockout: null, from: { source: m.hit.source, company: m.hit.company ?? null, at: m.hit.at ?? null }, ...(m.standardKey ? { standardKey: m.standardKey, standardLabel: labelOf(m.standardKey) } : {}) };
    if (m.standardKey) return { question: m.question, answer: '', knockout: null, needsYou: true, standardKey: m.standardKey, standardLabel: labelOf(m.standardKey) };
    const d = drafted.get(m.question.toLowerCase());
    return { question: m.question, answer: d?.answer ?? '', knockout: d?.knockout ?? null, from: d ? { source: 'drafted' } : null };
  });
  const knock = full.filter((a) => a.knockout).length;
  const markdown = full.map((a, i) => `### ${i + 1}. ${a.question}\n${a.knockout ? `> ⚠️ Knock-out check: ${a.knockout}\n\n` : ''}${a.needsYou ? `> ✋ Needs you — save it once as your standard answer for "${a.standardLabel}" and it's reused everywhere.\n\n` : ''}${a.from?.source === 'you' || a.from?.source === 'standard' ? `> ♻️ Reused from your answer bank${a.from.company ? ` (${a.from.company})` : ''}\n\n` : ''}${a.answer || '_(no draft — answer this one yourself)_'}`).join('\n\n');
  try { await touchAnswers(uid, reused.map((m) => m.hit.id).filter(Boolean)); } catch (e) { await log(`could not mark bank answers as used: ${e.message}`); }
  await progress(`done — ${full.length} answers · ${reused.length} reused${needsYou.length ? `, ${needsYou.length} need you` : ''}${knock ? `, ${knock} knock-out flag${knock === 1 ? '' : 's'}` : ''}`);
  return finish({ job, kind: 'apply', title: `Application answers: ${report.company} — ${report.role} (${full.length})`, markdown, data: { answers: full, knockouts: knock, reused: reused.length, needsYou: needsYou.length }, agent: 'writer', cfg, out, report });
}
