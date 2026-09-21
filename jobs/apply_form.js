// apply_form — read the application form for a scored posting (Tailoring → apply → "Read the form").
//   payload { reportJobId, applyUrl? }   (applyUrl = the form's URL when it differs from the posting)
// Script job: no model. Writes a careerOpsNote kind "apply_form" whose data drives the Apply screen:
//   questions[] (label, type, options, required, maxLength) · identity[] · files[] · needsAccount · atsHint
// When the portal hides the form behind an account and the member has saved one for that host in
// their vault, the worker signs in and walks the wizard (lib/form-login.js) — reading, filling only
// what it has facts for, pressing only Continue/Next, never Submit.
import { join } from 'node:path';
import { getReport, saveNote, getSetup, listAnswers } from '../lib/firestore.js';
import { readApplyForm, openBrowser, classifyFields, collectFieldsInPage } from '../lib/form-read.js';
import { signIn, walkWizard, portalFor } from '../lib/form-login.js';
import { getVaultAccount, updateVaultAccount, decryptSecret, vaultHost } from '../lib/vault.js';
import { parseProfile } from '../lib/profile.js';
import { userRoot } from '../lib/user-root.js';
import { str } from './_task.js';

async function factsFor(uid, setup) {
  const prof = parseProfile(setup?.profileYaml);
  const [firstName, ...rest] = prof.name.split(/\s+/); const lastName = rest.join(' ');
  const standard = {};
  for (const a of await listAnswers(uid)) if (a.source === 'standard' && a.standardKey && a.answer) standard[a.standardKey] = a.answer;
  return { name: prof.name, firstName, lastName, email: prof.email, phone: prof.phone || standard.phone || '', linkedin: prof.linkedin, github: prof.github, portfolio: prof.portfolio, city: prof.location, region: prof.location, country: prof.country, address: standard.street_address || '', postcode: standard.postcode || '', standard };
}

export async function run({ job, env, log, progress, cancelled }) {
  const { uid, payload } = job;
  const reportJobId = str(payload.reportJobId, 40);
  const report = reportJobId ? await getReport(uid, reportJobId) : null;
  if (!report) throw new Error('report not found — score the posting first');
  const url = /^https?:\/\//.test(str(payload.applyUrl, 600)) ? str(payload.applyUrl, 600) : report.url;
  if (!url) throw new Error('this report came from pasted text, so there is no posting URL — paste the application form URL');
  await progress(`opening ${url}`);
  const t0 = Date.now();
  let form = await readApplyForm(env, url, { log });
  if (await cancelled()) return null;

  let signedIn = null;
  if (form.needsAccount) {
    const host = vaultHost(form.finalUrl || url);
    const account = await getVaultAccount(uid, host);
    if (account?.passwordEnc && env.vault?.privateKey) {
      await progress(`signing in to ${host}`);
      const { browser, page } = await openBrowser(env);
      try {
        const password = decryptSecret(env.vault.privateKey, account.passwordEnc);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2500);
        await signIn(page, portalFor(form.finalUrl || url), { email: account.email, password, log });
        await updateVaultAccount(uid, host, { status: 'ok', lastLoginAt: Date.now(), lastError: null });
        const setup = await getSetup(uid);
        const facts = await factsFor(uid, setup);
        const cvPath = payload.cvFile ? join(userRoot(env, uid), 'output', String(payload.cvFile).replace(/[^\w.-]/g, '')) : null;
        await progress('reading the application wizard');
        const walk = await walkWizard(page, { facts, cvPath, log });
        const first = await page.evaluate(collectFieldsInPage).catch(() => null);
        const cls = first ? classifyFields(first, page.url()) : null;
        signedIn = { host, email: account.email, pages: walk.pages, stoppedAt: walk.stoppedAt };
        form = { ...form, needsAccount: false, questions: walk.questions, identity: cls?.identity ?? form.identity, files: cls?.files ?? form.files, finalUrl: page.url(),
          note: walk.stoppedAt === 'review' ? `signed in and read the whole wizard (${walk.pages.length} pages) up to the review page — nothing was submitted.` : walk.stoppedAt.startsWith('blocked') ? `signed in and read ${walk.pages.length} page(s); stopped — ${walk.stoppedAt.slice(9)}. Complete that page once yourself in the portal (it remembers) and read again.` : `signed in and read ${walk.pages.length} page(s) (${walk.stoppedAt}).` };
      } catch (e) {
        await updateVaultAccount(uid, host, { status: 'failed', lastError: String(e.message).slice(0, 200), lastLoginAt: Date.now() });
        await log(`sign-in to ${host} failed: ${e.message}`);
        form = { ...form, note: `${form.note} Sign-in with your saved ${host} account failed: ${String(e.message).slice(0, 160)}` };
      } finally { await browser.close().catch(() => {}); }
    } else if (!account) await log(`${host} needs an account and none is saved in your portal accounts`);
    else await log(`${host}: account saved but the worker has no vault key — restart the worker`);
  }
  if (await cancelled()) return null;

  const md = [
    `# Application form: ${report.company} — ${report.role}`, '', `**URL:** ${form.finalUrl}${form.atsHint ? ` (${form.atsHint})` : ''}`, form.note ? `\n> ${form.note}` : '',
    signedIn ? `\n## Pages read (signed in as ${signedIn.email})\n${signedIn.pages.map((p, i) => `${i + 1}. ${p.title || p.url} — ${p.questions} question(s)${p.filled.length ? `, filled: ${p.filled.join('; ')}` : ''}${p.skipped.length ? `, could not fill: ${p.skipped.join('; ')}` : ''}`).join('\n')}` : '',
    form.files.length ? `\n## Files\n${form.files.map((f) => `- ${f.label}${f.required ? ' *' : ''}`).join('\n')}` : '',
    form.questions.length ? `\n## Questions (${form.questions.length})\n${form.questions.map((q, i) => `${i + 1}. ${q.label}${q.required ? ' *' : ''}${q.options?.length ? ` — options: ${q.options.slice(0, 8).join(' / ')}${q.options.length > 8 ? ' …' : ''}` : ''}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
  await saveNote(uid, job.id, {
    kind: 'apply_form', title: `Application form: ${report.company} — ${report.role} (${form.questions.length} question${form.questions.length === 1 ? '' : 's'})`,
    company: report.company, role: report.role, reportJobId, opportunityId: null, markdown: md,
    data: { url, finalUrl: form.finalUrl, draftUrl: form.draftUrl ?? form.finalUrl, atsHint: form.atsHint, needsAccount: form.needsAccount, note: form.note, questions: form.questions, identity: form.identity, files: form.files, host: vaultHost(form.finalUrl || url), signedIn },
    agent: 'extractor', model: 'browser', via: 'script', durationMs: Date.now() - t0, usage: null,
  });
  await log(`${form.questions.length} question(s), ${form.files.length} file slot(s), ${form.identity.length} identity field(s)${form.needsAccount ? ' · account gate' : ''} on ${form.finalUrl}`);
  await progress(`done — ${form.questions.length} question${form.questions.length === 1 ? '' : 's'}${form.needsAccount ? ' (account needed)' : signedIn ? ' (signed in)' : ''}`);
  return { questions: form.questions.length, files: form.files.length, needsAccount: form.needsAccount, atsHint: form.atsHint, signedIn: !!signedIn, durationMs: Date.now() - t0 };
}
