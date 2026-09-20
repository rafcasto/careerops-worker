// apply_form — read the application form for a scored posting (Tailoring → apply → "Read the form").
//   payload { reportJobId, applyUrl? }   (applyUrl = the form's URL when it differs from the posting)
// Script job: no model. Writes a careerOpsNote kind "apply_form" whose data drives the Apply screen:
//   questions[] (label, type, options, required, maxLength) · identity[] · files[] · needsAccount · atsHint
import { getReport, saveNote } from '../lib/firestore.js';
import { readApplyForm } from '../lib/form-read.js';
import { str } from './_task.js';

export async function run({ job, env, log, progress, cancelled }) {
  const { uid, payload } = job;
  const reportJobId = str(payload.reportJobId, 40);
  const report = reportJobId ? await getReport(uid, reportJobId) : null;
  if (!report) throw new Error('report not found — score the posting first');
  const url = /^https?:\/\//.test(str(payload.applyUrl, 600)) ? str(payload.applyUrl, 600) : report.url;
  if (!url) throw new Error('this report came from pasted text, so there is no posting URL — paste the application form URL');
  await progress(`opening ${url}`);
  const t0 = Date.now();
  const form = await readApplyForm(env, url, { log });
  if (await cancelled()) return null;
  const md = [
    `# Application form: ${report.company} — ${report.role}`, '', `**URL:** ${form.finalUrl}${form.atsHint ? ` (${form.atsHint})` : ''}`, form.note ? `\n> ${form.note}` : '',
    form.files.length ? `\n## Files\n${form.files.map((f) => `- ${f.label}${f.required ? ' *' : ''}`).join('\n')}` : '',
    form.questions.length ? `\n## Questions (${form.questions.length})\n${form.questions.map((q, i) => `${i + 1}. ${q.label}${q.required ? ' *' : ''}${q.options?.length ? ` — options: ${q.options.slice(0, 8).join(' / ')}${q.options.length > 8 ? ' …' : ''}` : ''}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
  await saveNote(uid, job.id, {
    kind: 'apply_form', title: `Application form: ${report.company} — ${report.role} (${form.questions.length} question${form.questions.length === 1 ? '' : 's'})`,
    company: report.company, role: report.role, reportJobId, opportunityId: null, markdown: md,
    data: { url, finalUrl: form.finalUrl, atsHint: form.atsHint, needsAccount: form.needsAccount, note: form.note, questions: form.questions, identity: form.identity, files: form.files },
    agent: 'extractor', model: 'browser', via: 'script', durationMs: Date.now() - t0, usage: null,
  });
  await log(`${form.questions.length} question(s), ${form.files.length} file slot(s), ${form.identity.length} identity field(s)${form.needsAccount ? ' · account gate' : ''} on ${form.finalUrl}`);
  await progress(`done — ${form.questions.length} question${form.questions.length === 1 ? '' : 's'}${form.needsAccount ? ' (account needed)' : ''}`);
  return { questions: form.questions.length, files: form.files.length, needsAccount: form.needsAccount, atsHint: form.atsHint, durationMs: Date.now() - t0 };
}
