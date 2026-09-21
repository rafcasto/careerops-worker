// apply_fill — type the application into the portal (Tailoring → apply → "Fill it in the portal").
//   payload { reportJobId, answers: [{question, answer}], applyUrl?, cvFile? }
// Signs in with the member's vault account, walks the wizard in 'fill' mode — identity from the
// profile, standard answers, the drafted answers, the tailored CV — up to the Review page, and
// stops. The application is left as a saved draft in the member's own candidate account for them
// to review and submit. The worker never presses Submit.
import { join } from 'node:path';
import { getReport, saveNote, getSetup, listAnswers } from '../lib/firestore.js';
import { readApplyForm, openBrowser } from '../lib/form-read.js';
import { signIn, walkWizard, portalFor } from '../lib/form-login.js';
import { getVaultAccount, updateVaultAccount, decryptSecret, vaultHost } from '../lib/vault.js';
import { parseProfile } from '../lib/profile.js';
import { userRoot } from '../lib/user-root.js';
import { str } from './_task.js';

export async function run({ job, env, log, progress, cancelled }) {
  const { uid, payload } = job;
  const reportJobId = str(payload.reportJobId, 40);
  const report = reportJobId ? await getReport(uid, reportJobId) : null;
  if (!report) throw new Error('report not found — score the posting first');
  const answers = (Array.isArray(payload.answers) ? payload.answers : []).map((a) => ({ question: str(a?.question, 600), answer: str(a?.answer, 4000) })).filter((a) => a.question && a.answer).slice(0, 40);
  if (!answers.length) throw new Error('nothing to fill — answer the questions first');
  const url = /^https?:\/\//.test(str(payload.applyUrl, 600)) ? str(payload.applyUrl, 600) : report.url;
  if (!url) throw new Error('this report has no posting URL — paste the application form URL');
  const t0 = Date.now();
  await progress(`opening ${url}`);
  const probe = await readApplyForm(env, url, { log });
  if (await cancelled()) return null;
  const host = vaultHost(probe.finalUrl || url);
  const account = probe.needsAccount ? await getVaultAccount(uid, host) : null;
  if (probe.needsAccount && !account?.passwordEnc) throw new Error(`${host} needs an account before the form can be filled — save it under Portal accounts first`);
  if (!probe.needsAccount) {
    // No account → the portal keeps no draft; typing here would vanish when the browser closes.
    const md = `# Fill in the portal: ${report.company} — ${report.role}\n\n> ${probe.atsHint ?? 'This'} form has no candidate account, so the portal keeps no draft — anything the Pi typed would be lost when its browser closed. Copy the answers in from the Apply screen (they are already in the form's order).`;
    await saveNote(uid, job.id, { kind: 'apply_fill', title: `Fill in the portal: ${report.company} — ${report.role} (not possible here)`, company: report.company, role: report.role, reportJobId, opportunityId: null, markdown: md, data: { url, finalUrl: probe.finalUrl, atsHint: probe.atsHint, possible: false, filled: [], skipped: [], pages: [] }, agent: 'extractor', model: 'browser', via: 'script', durationMs: Date.now() - t0, usage: null });
    await progress('done — this portal keeps no draft; copy the answers in');
    return { possible: false, atsHint: probe.atsHint };
  }
  const setup = await getSetup(uid);
  const prof = parseProfile(setup?.profileYaml);
  const [firstName, ...rest] = prof.name.split(/\s+/);
  const standard = {}; for (const a of await listAnswers(uid)) if (a.source === 'standard' && a.standardKey && a.answer) standard[a.standardKey] = a.answer;
  const facts = { name: prof.name, firstName, lastName: rest.join(' '), email: prof.email, phone: prof.phone || standard.phone || '', linkedin: prof.linkedin, github: prof.github, portfolio: prof.portfolio, city: prof.location, region: prof.location, country: prof.country, address: standard.street_address || '', postcode: standard.postcode || '', standard };
  const cvPath = payload.cvFile ? join(userRoot(env, uid), 'output', String(payload.cvFile).replace(/[^\w.-]/g, '')) : null;

  const { browser, page } = await openBrowser(env);
  let walk;
  try {
    await progress(`signing in to ${host}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2500);
    await signIn(page, portalFor(probe.finalUrl || url), { email: account.email, password: decryptSecret(env.vault.privateKey, account.passwordEnc), log });
    await updateVaultAccount(uid, host, { status: 'ok', lastLoginAt: Date.now(), lastError: null });
    await progress('filling the application');
    walk = await walkWizard(page, { facts, cvPath, answers, mode: 'fill', log, maxPages: 10 });
  } catch (e) {
    await updateVaultAccount(uid, host, { status: 'failed', lastError: String(e.message).slice(0, 200), lastLoginAt: Date.now() }).catch(() => {});
    throw e;
  } finally { await browser.close().catch(() => {}); }
  if (await cancelled()) return null;
  const filled = walk.pages.flatMap((p) => p.filled), skipped = walk.pages.flatMap((p) => p.skipped);
  const outcome = walk.stoppedAt === 'review' ? `Filled up to the Review page — sign in to ${host}, check every answer, and press Submit yourself.` : walk.stoppedAt.startsWith('blocked') ? `Stopped on "${walk.pages.at(-1)?.title || 'a page'}" — ${walk.stoppedAt.slice(9)}. What was filled is saved as a draft; finish that page in the portal.` : `Stopped (${walk.stoppedAt}) after ${walk.pages.length} page(s); what was filled is saved as a draft in your account.`;
  const md = [`# Fill in the portal: ${report.company} — ${report.role}`, '', `**Where:** ${walk.finalUrl}`, `\n> ${outcome}`, `\n## Filled (${filled.length})`, ...filled.map((f) => `- ${f}`), skipped.length ? `\n## Left for you (${skipped.length})\n${skipped.map((s) => `- ${s}`).join('\n')}` : '', `\n## Pages\n${walk.pages.map((p, i) => `${i + 1}. ${p.title || p.url}`).join('\n')}`].join('\n');
  await saveNote(uid, job.id, { kind: 'apply_fill', title: `Filled in the portal: ${report.company} — ${report.role} (${filled.length} field${filled.length === 1 ? '' : 's'})`, company: report.company, role: report.role, reportJobId, opportunityId: null, markdown: md,
    data: { url, finalUrl: walk.finalUrl, draftUrl: probe.draftUrl ?? walk.finalUrl, host, atsHint: probe.atsHint, possible: true, stoppedAt: walk.stoppedAt, outcome, filled, skipped, pages: walk.pages.map((p) => ({ title: p.title, url: p.url, filled: p.filled.length, skipped: p.skipped.length })) },
    agent: 'extractor', model: 'browser', via: 'script', durationMs: Date.now() - t0, usage: null });
  await progress(`done — ${filled.length} filled, ${skipped.length} left for you (${walk.stoppedAt})`);
  return { filled: filled.length, skipped: skipped.length, stoppedAt: walk.stoppedAt, finalUrl: walk.finalUrl, durationMs: Date.now() - t0 };
}
