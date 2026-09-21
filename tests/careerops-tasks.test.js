import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats } from '../jobs/patterns.js';
import { parseDelimited, buildTaskMessages } from '../lib/prompts.js';
import { MEMBER_JOB_TYPES, AGENT_KEYS } from '../lib/keys.js';
import { HANDLERS } from '../jobs/index.js';

const stages = [{ id: 'wishlist', label: 'Wishlist' }, { id: 'application', label: 'Application' }, { id: 'job_interview', label: 'Job interview' }, { id: 'rejected', label: '❌ Rejected' }];
const md = (rem, missing) => `## Block A — Role summary\n| Remote | ${rem} |\n| Seniority | Senior |\n## Block B — Match\n| Requirement | Importance | Match |\n| ${missing} | critical | ❌ Missing |\n## Verdict\n`;

test('computeStats separates rejected / positive / in-flight and finds common missing requirements', () => {
  const reports = [
    { jobId: 'a', company: 'A', score: 4.2, archetype: 'Other: PM', legitimacy: 'High Confidence', addedOpportunityId: 'o1', markdown: md('hybrid', 'Kubernetes') },
    { jobId: 'b', company: 'B', score: 3.1, archetype: 'Other: PM', legitimacy: 'Proceed with Caution', addedOpportunityId: 'o2', markdown: md('onsite', 'Kubernetes') },
    { jobId: 'c', company: 'C', score: 4.6, archetype: 'Technical AI PM', legitimacy: 'High Confidence', addedOpportunityId: 'o3', markdown: md('remote', 'Go') },
    { jobId: 'd', company: 'D', score: 2.5, archetype: 'Other: BA', legitimacy: 'Suspicious', markdown: md('onsite', 'SAP') },
  ];
  const opps = [{ id: 'o1', stage: 'rejected', company: 'A' }, { id: 'o2', stage: 'rejected', company: 'B' }, { id: 'o3', stage: 'job_interview', company: 'C' }];
  const s = computeStats(reports, opps, stages);
  assert.equal(s.totals.rejected, 2); assert.equal(s.totals.positive, 1); assert.equal(s.totals.notOnBoard, 1);
  assert.equal(s.totals.sufficientSample, false);
  assert.deepEqual(s.rejected.missingRequirements[0], ['kubernetes', 2]);
  assert.equal(s.rejected.archetypes[0][0], 'PM');
  assert.equal(s.scoreThreshold.observedMinimumThatConverted, 4.6);
  assert.equal(s.rejectedCards.length, 2);
});

test('parseDelimited pulls the DM block and tolerates a missing terminator', () => {
  assert.equal(parseDelimited('## Message\nhi\n---DM---\nHello there\n---END---', '---DM---', '---END---'), 'Hello there');
  assert.equal(parseDelimited('x ---DM--- Hello', '---DM---', '---END---'), 'Hello');
  assert.equal(parseDelimited('no block', '---DM---', '---END---'), '');
});

test('buildTaskMessages keeps the user turn inside the context budget', () => {
  const m = buildTaskMessages({ system: 'S'.repeat(2000), cv: 'c'.repeat(100000), profileYaml: 'p', jd: 'j'.repeat(100000), report: 'r'.repeat(100000), instruction: 'Go.', numCtx: 8192 });
  assert.equal(m[0].role, 'system'); assert.equal(m[1].role, 'user');
  assert.ok(m[1].content.length < 8192 * 3.5);
  assert.ok(m[1].content.endsWith('Go.'));
});

test('every member job type has a handler and the six agents are named', () => {
  for (const t of MEMBER_JOB_TYPES) assert.equal(typeof HANDLERS[t], 'function', t);
  assert.deepEqual(AGENT_KEYS, ['scout', 'extractor', 'evaluator', 'tailor', 'writer', 'researcher']);
});

test('claude-cli model tags are recognised and the pinned model is extracted', async () => {
  const { isClaudeCliTag, cliModelFromTag } = await import('../lib/claude-cli.js');
  assert.equal(isClaudeCliTag('claude-cli'), true);
  assert.equal(isClaudeCliTag('claude-cli:opus'), true);
  assert.equal(isClaudeCliTag('llama3.2:3b'), false);
  assert.equal(cliModelFromTag('claude-cli:sonnet'), 'sonnet');
  const { researcherMode } = await import('../lib/researcher.js');
  assert.equal(await researcherMode({ model: 'qwen2.5:1.5b' }), 'local');
});

test('scan title filter follows career-ops semantics (substring positive, word: negative)', async () => {
  const { titleMatches } = await import('../jobs/scan.js');
  const f = { positive: ['Test Lead', 'QA Manager'], negative: ['Junior', 'word:Intern'] };
  assert.equal(titleMatches('Senior Test Lead — Payments', f), true);
  assert.equal(titleMatches('Junior QA Manager', f), false);
  assert.equal(titleMatches('QA Manager (Internal Systems)', f), true);   // "Intern" only as a whole word
  assert.equal(titleMatches('QA Manager Intern', f), false);
  assert.equal(titleMatches('Product Owner', f), false);
  assert.equal(titleMatches('Anything', { positive: [], negative: [] }), true);
});

test('classifyCompanies tells job boards from plain careers pages', async () => {
  const { classifyCompanies } = await import('../jobs/scan.js');
  const out = await classifyCompanies('/home/rafcasto/career-ops', [{ name: 'Xero', careersUrl: 'https://jobs.lever.co/xero' }, { name: 'ASB', careersUrl: 'https://careers.asbgroup.co.nz/home' }]);
  assert.deepEqual(out.map((c) => [c.name, c.method, c.provider]), [['Xero', 'board', 'lever'], ['ASB', 'page', null]]);
  // Setup → Advanced: an explicit provider (branded SuccessFactors host) is a board; an unknown id is reported and falls back to the page.
  const adv = await classifyCompanies('/home/rafcasto/career-ops', [
    { name: 'ANZ', careersUrl: 'https://careers.anz.com', provider: 'successfactors', api: 'https://careers.anz.com' },
    { name: 'Kiwibank', careersUrl: 'https://www.kiwibank.co.nz/about-us/careers/', api: 'https://kiwibankpeople.csod.com/ux/ats/careersite/1/home?c=kiwibankpeople' },
    { name: 'Nope', careersUrl: 'https://example.com/jobs', provider: 'not-a-provider' },
  ]);
  assert.deepEqual(adv.map((c) => [c.name, c.method, c.provider, !!c.error]), [['ANZ', 'board', 'successfactors', false], ['Kiwibank', 'board', 'csod', false], ['Nope', 'page', null, true]]);
  assert.match(adv[2].error, /unknown provider/);
});

test('cleanTitle strips Eightfold-style location and posted-date suffixes', async () => {
  const { cleanTitle } = await import('../jobs/scan.js');
  assert.equal(cleanTitle('Senior Systems Test Analyst Auckland, Auckland, NZ Posted 12 days ago'), 'Senior Systems Test Analyst');
  assert.equal(cleanTitle('Technology Graduate Programme 2027 (Auckland and Wellington) Auckland, Auckland, NZ + 1 more Posted 2 days ago'), 'Technology Graduate Programme 2027 (Auckland and Wellington)');
  assert.equal(cleanTitle('Platform Lead'), 'Platform Lead');
});

test('resolveReportJd recovers a pre-phase-3 report JD from disk and backfills it', async () => {
  const { resolveReportJd, jdFileFor } = await import('../lib/report-jd.js');
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'careerops-jd-'));
  await mkdir(join(root, 'jds'), { recursive: true });
  const report = { n: 1, company: 'ASB Group', role: 'Analyst', url: null, jdChars: 500 };
  assert.equal(jdFileFor(report), '001-asb-group.txt');
  const text = 'Senior Analyst wanted. '.repeat(30);
  await writeFile(join(root, 'jds', '001-asb-group.txt'), text, 'utf8');
  const persisted = [];
  const jd = await resolveReportJd({ env: {}, uid: 'u1', root, report, reportJobId: 'j1', persist: async (uid, id, patch) => persisted.push({ uid, id, patch }) });
  assert.equal(jd, text.trim());
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].id, 'j1');
  assert.equal(persisted[0].patch.jd, text.trim());
  assert.equal(persisted[0].patch.jdRecoveredFrom, 'jds/001-asb-group.txt');
  // A report that already carries its JD is returned as-is, nothing persisted.
  const same = await resolveReportJd({ env: {}, uid: 'u1', root, report: { ...report, jd: 'inline JD' }, reportJobId: 'j1', persist: async () => persisted.push('no') });
  assert.equal(same, 'inline JD'); assert.equal(persisted.length, 1);
  // Nothing on disk, no URL → a clear error naming the company.
  await assert.rejects(() => resolveReportJd({ env: {}, uid: 'u1', root, report: { n: 9, company: 'Nowhere', url: null }, reportJobId: 'j2', persist: async () => {} }), /re-run the evaluation for Nowhere/);
});

test('ats-resolve finds the board behind a marketing careers page (links, then branded fingerprint)', async () => {
  const { extractAtsLinks, extractCareerHosts, fingerprintHtml, knownNoProvider, resolveCompany, loadCareerOpsTools } = await import('../lib/ats-resolve.js');
  const westpac = '<a href="https://westpacnz.wd105.myworkdayjobs.com/Westpac_Careers">Search jobs</a> <a href="https://westpacnz.wd105.myworkdayjobs.com/en-US/Westpac_Careers/introduceYourself">Join</a> <a href="/privacy">x</a>';
  assert.deepEqual(extractAtsLinks(westpac, 'https://www.westpac.co.nz/about-us/careers/'), ['https://westpacnz.wd105.myworkdayjobs.com/Westpac_Careers']);
  const anz = '<a href="https://careers.anz.com/go/ANZ-Jobs-List/4739210/">See all jobs</a>';
  assert.deepEqual(extractCareerHosts(anz, 'https://www.anz.co.nz/careers/'), ['https://careers.anz.com']);
  assert.equal(fingerprintHtml('<script src="https://performancemanager.successfactors.eu/x.js">'), 'successfactors');
  assert.equal(fingerprintHtml('<div class="ph-page">'), 'phenom');
  assert.equal(fingerprintHtml('<p>hello</p>'), null);
  assert.equal(knownNoProvider('powered by SnapHire'), 'SnapHire');

  const { resolve } = await loadCareerOpsTools('/home/rafcasto/career-ops');
  const probed = [];
  const probe = async (entry, p) => { probed.push([p.id, entry.careers_url]); return { provider: p.id, status: 'live', jobCount: 20 }; };
  const pages = {
    'https://www.westpac.co.nz/about-us/careers/': { url: 'https://www.westpac.co.nz/about-us/careers/', html: westpac },
    'https://www.anz.co.nz/careers/': { url: 'https://www.anz.co.nz/careers/', html: anz },
    'https://careers.anz.com': { url: 'https://careers.anz.com/', html: '<link href="https://career2.successfactors.eu/a.css">' },
    'https://careers.asbgroup.co.nz/home': { url: 'https://careers.asbgroup.co.nz/home', html: '<div>powered by snaphire</div>' },
  };
  const fetchPage = async (u) => { if (!pages[u]) throw new Error('404'); return pages[u]; };
  const w = await resolveCompany({ name: 'Westpac', careersUrl: 'https://www.westpac.co.nz/about-us/careers/' }, { resolve, probe, fetchPage });
  assert.deepEqual(w, { careersUrl: 'https://westpacnz.wd105.myworkdayjobs.com/Westpac_Careers', provider: 'workday', apiUrl: null, live: 20, via: 'link' });
  const a = await resolveCompany({ name: 'ANZ', careersUrl: 'https://www.anz.co.nz/careers/' }, { resolve, probe, fetchPage });
  assert.deepEqual(a, { careersUrl: 'https://careers.anz.com', provider: 'successfactors', apiUrl: 'https://careers.anz.com', live: 20, via: 'fingerprint' });
  const asb = await resolveCompany({ name: 'ASB', careersUrl: 'https://careers.asbgroup.co.nz/home' }, { resolve, probe, fetchPage });
  assert.deepEqual(asb, { hint: 'runs on SnapHire, which has no board API — read in the browser' });
  assert.equal(await resolveCompany({ name: 'Gone', careersUrl: 'https://nowhere.example/' }, { resolve, probe, fetchPage }), null);

  const { applyResolvedToPortalsYaml } = await import('../jobs/scan.js');
  const y = applyResolvedToPortalsYaml('title_filter:\n  positive: ["Test"]\n  negative: []\ntracked_companies:\n  - name: "ANZ"\n    careers_url: "https://www.anz.co.nz/careers/"\n    enabled: true\n', [{ name: 'anz', suggested: a }]);
  assert.match(y, /careers_url: https:\/\/careers\.anz\.com\n\s+enabled: true\n\s+provider: successfactors\n\s+api: https:\/\/careers\.anz\.com/);
  assert.match(y, /positive:\n\s+- Test/);
});

test('answer bank: normalises questions, finds the standard family, reuses exact / standard / profile answers', async () => {
  const { normalizeQuestion, standardKeyFor, matchAnswers, questionId } = await import('../lib/answers.js');
  assert.equal(normalizeQuestion('3. Why do you want to work at Xero? *'), 'why do you want to work at xero');
  assert.equal(normalizeQuestion('What are your salary expectations? (required)'), 'what are your salary expectations');
  assert.equal(questionId('Why Xero?'), questionId('  why xero '));
  assert.equal(standardKeyFor('Are you legally entitled to work in New Zealand?'), 'right_to_work');
  assert.equal(standardKeyFor('What is your notice period?'), 'notice_period');
  assert.equal(standardKeyFor('Do you require visa sponsorship?'), 'sponsorship');
  assert.equal(standardKeyFor('Describe a time you influenced without authority.'), null);
  const bank = [
    { id: 'a', question: 'Why do you want to work at Xero?', key: 'why do you want to work at xero', answer: 'Because ledgers.', source: 'you', company: 'Xero', updatedAt: 2 },
    { id: 's', question: 'Salary expectation', key: 'salary expectation', answer: '$150–170k', source: 'standard', standardKey: 'salary', updatedAt: 1 },
  ];
  const m = matchAnswers(['Why do you want to work at Xero?', 'What are your salary expectations?', 'Are you entitled to work in NZ?', 'Your LinkedIn profile URL', 'Tell us about a hard bug.'], bank, { linkedin: 'linkedin.com/in/raf' });
  assert.deepEqual(m.map((x) => [x.standardKey, x.hit?.source ?? null, x.hit?.answer ?? null]), [
    [null, 'you', 'Because ledgers.'], ['salary', 'standard', '$150–170k'], ['right_to_work', null, null], [null, 'profile', 'linkedin.com/in/raf'], [null, null, null],
  ]);
});

test('form reader: collects fields from a real page and classifies questions / identity / files / account gate', async () => {
  const { collectFieldsInPage, classifyFields } = await import('../lib/form-read.js');
  const html = `<html><body><h1>Apply</h1><form>
    <label for="fn">First name *</label><input id="fn" required>
    <label for="em">Email</label><input id="em" type="email">
    <label for="cv">Resume/CV</label><input id="cv" type="file" accept=".pdf">
    <div class="field"><label for="q1">Why do you want to work at Xero?</label><textarea id="q1" maxlength="1000"></textarea></div>
    <div class="field"><label for="q2">Are you legally entitled to work in New Zealand?</label><select id="q2"><option>Yes</option><option>No</option></select></div>
    <fieldset><legend>Work arrangement</legend><label><input type="radio" name="wa" value="r">Remote</label><label><input type="radio" name="wa" value="h">Hybrid</label></fieldset>
    <a href="/apply">Apply now</a></form></body></html>`;
  const { pathToFileURL } = await import('node:url'); const { join } = await import('node:path');
  const { chromium } = await import(pathToFileURL(join('/home/rafcasto/career-ops', 'node_modules', 'playwright', 'index.mjs')).href);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage(); await page.setContent(html);
    const collected = await page.evaluate(collectFieldsInPage);
    const c = classifyFields(collected, 'https://jobs.example.com/x');
    assert.deepEqual(c.identity.map((i) => i.label), ['First name', 'Email']);
    assert.deepEqual(c.files.map((f) => [f.label, f.kind]), [['Resume/CV', 'cv']]);
    assert.deepEqual(c.questions.map((q) => [q.label, q.type, q.options.length]), [['Why do you want to work at Xero?', 'textarea', 0], ['Are you legally entitled to work in New Zealand?', 'select', 2], ['Work arrangement', 'radio', 2]]);
    assert.equal(c.questions[0].maxLength, 1000);
    assert.equal(c.needsAccount, false);
    assert.match(collected.applyHref, /\/apply$/);
    const gate = classifyFields({ fields: [{ type: 'email', label: 'Email' }, { type: 'password', label: 'Password' }], password: true, text: 'Sign in to apply', url: 'https://x.wd3.myworkdayjobs.com/a' }, '');
    assert.equal(gate.needsAccount, true); assert.equal(gate.atsHint, 'Workday'); assert.match(gate.note, /account/);
    const long = classifyFields({ fields: [{ type: 'text', label: 'What is the address from which you plan on working? If you would need to relocate, please type "relocating".' }, { type: 'text', label: 'Country' }], password: false, text: '', url: 'https://x' }, '');
    assert.deepEqual([long.questions.length, long.identity.map((i) => i.label)], [1, ['Country']]);
  } finally { await browser.close(); }
});

test('vault: browser-side RSA-OAEP ciphertext round-trips through the Pi private key; key file is 0600', async () => {
  const { ensureVaultKey, encryptSecret, decryptSecret, vaultHost } = await import('../lib/vault.js');
  const { mkdtemp, stat } = await import('node:fs/promises'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'vault-'));
  const k1 = ensureVaultKey(dir); const k2 = ensureVaultKey(dir);
  assert.equal(k1.publicKeySpkiB64, k2.publicKeySpkiB64);                       // stable across restarts
  assert.equal(((await stat(k1.file)).mode & 0o777), 0o600);
  const enc = encryptSecret(k1.publicKeySpkiB64, 'Tr0ub4dor&3 — pässwörd');
  assert.equal(decryptSecret(k1.privateKey, enc), 'Tr0ub4dor&3 — pässwörd');
  assert.equal(vaultHost('https://westpacnz.wd105.myworkdayjobs.com/en-US/Westpac_Careers/job/x'), 'westpacnz.wd105.myworkdayjobs.com');
});

test('form-login: only Continue/Next-style buttons are ever pressed; facts map onto labels', async () => {
  const { nextButtonAllowed, portalFor, factFor, pickOption } = await import('../lib/form-login.js');
  for (const ok of ['Save and Continue', 'Continue', 'Next', 'next step']) assert.equal(nextButtonAllowed(ok), true, ok);
  for (const no of ['Submit', 'Apply', 'Apply Now', 'Send application', 'Continue and submit', 'Finish', 'Cancel', 'Sign In']) assert.equal(nextButtonAllowed(no), false, no);
  assert.equal(portalFor('https://westpacnz.wd105.myworkdayjobs.com/x'), 'workday');
  assert.equal(portalFor('https://careers.anz.com/job/1'), 'generic');
  const facts = { firstName: 'Rafael', lastName: 'Castro', email: 'r@x.nz', phone: '021', standard: { how_heard: 'Company careers page', right_to_work: 'Yes — NZ citizen' } };
  assert.equal(factFor('First Name', facts), 'Rafael'); assert.equal(factFor('Email Address', facts), 'r@x.nz');
  assert.equal(factFor('How did you hear about us?', facts), 'Company careers page');
  assert.equal(factFor('Why do you want this role?', facts), null);
  const { isPlaceholder, answerFor } = await import('../lib/form-login.js');
  assert.equal(isPlaceholder('[Add: your legal middle name, or enter N/A]'), true); assert.equal(isPlaceholder('Because payments.'), false);
  assert.equal(answerFor('Middle name', [{ question: 'Middle name', answer: '[Add: your legal middle name]' }]), null);
  const { cleanAnswer, numberFrom } = await import('../lib/form-login.js');
  assert.equal(cleanAnswer('I am currently contracting at Foodstuffs North Island. [Add: your actual notice period]'), 'I am currently contracting at Foodstuffs North Island.');
  assert.equal(cleanAnswer('[Add: your Auckland postcode — my CV lists only the city]'), null);
  assert.equal(cleanAnswer('Yes — CV attached.'), 'Yes — CV attached.');
  assert.equal(numberFrom('$150–170k base'), 150000); assert.equal(numberFrom('85,000'), 85000); assert.equal(numberFrom('negotiable'), null);
  const { classifyFields, draftUrlFor } = await import('../lib/form-read.js');
  const id = classifyFields({ fields: [{ type: 'text', label: 'Legal first name' }, { type: 'text', label: 'Postal code' }, { type: 'tel', label: 'Mobile Phone' }, { type: 'text', label: 'Region / State' }, { type: 'switch', label: 'Privacy setting', required: false }, { type: 'text', label: 'Where did you hear about us?', combobox: true }], password: false, text: '', url: 'https://careers.asbgroup.co.nz/candidate/application/1-personal-details' }, '');
  assert.deepEqual(id.identity.map((i) => i.label), ['Legal first name', 'Postal code', 'Mobile Phone', 'Region / State']);
  assert.deepEqual(id.questions.map((q) => q.label), ['Where did you hear about us?']);
  assert.equal(id.atsHint, 'SnapHire'); assert.equal(id.draftUrl, 'https://careers.asbgroup.co.nz/candidate');
  assert.equal(draftUrlFor('https://westpacnz.wd105.myworkdayjobs.com/en-US/Westpac_Careers/job/x', 'Workday'), 'https://westpacnz.wd105.myworkdayjobs.com/en-US/Westpac_Careers/userHome');
  assert.equal(pickOption(['Select one', 'Yes', 'No'], 'Yes — NZ citizen'), 'Yes');
  assert.equal(pickOption(['LinkedIn', 'Company careers page', 'Other'], 'company careers page'), 'Company careers page');
  assert.equal(pickOption(['Please select an option...', 'I agree', 'I do not agree'], 'I declare that the information I have provided is true.'), 'I agree');
  assert.equal(pickOption(['Yes', 'No'], 'I do not hold a formal financial services accreditation.'), 'No');
  assert.equal(pickOption(['No experience', '1-2 years', '3-5 years', '5+ years'], 'Yes — about 6 years with Selenium and Playwright'), '5+ years');
  assert.equal(pickOption(['Less than 1 year', '1-3 years', '3+ years'], '2 years'), '1-3 years');
  assert.equal(pickOption(['No current entitlement', 'I am a New Zealand Citizen', 'I am a New Zealand Permanent Resident', 'I hold a work visa'], 'NZ citizen — no restrictions'), 'I am a New Zealand Citizen');
  assert.equal(pickOption(['Yes', 'No'], 'It depends'), null);
});

test('form-login: walks a two-page wizard, fills known required fields, reads the question, never presses Submit', async () => {
  const { walkWizard } = await import('../lib/form-login.js');
  const html = `<html><body><script>window.submitted=false;</script>
    <div id="p1"><h1>My Information</h1><label for="fn">First Name *</label><input id="fn" required>
      <label for="src">How did you hear about us? *</label><select id="src" required><option value="">Select one</option><option>LinkedIn</option><option>Company careers page</option></select>
      <button type="button" onclick="if(!fn.value||!src.value){err.textContent='This field is required'}else{p1.style.display='none';p2.style.display='block'}">Save and Continue</button><p id="err"></p></div>
    <div id="p2" style="display:none"><h1>Application Questions</h1><label for="q">Why do you want to work at Westpac?</label><textarea id="q"></textarea>
      <button type="button" onclick="p2.style.display='none';p3.style.display='block'">Next</button></div>
    <div id="p3" style="display:none"><h1>Review your application</h1><p>Review</p><button type="button" onclick="window.submitted=true">Submit</button></div>
  </body></html>`;
  const { pathToFileURL } = await import('node:url'); const { join } = await import('node:path');
  const { chromium } = await import(pathToFileURL(join('/home/rafcasto/career-ops', 'node_modules', 'playwright', 'index.mjs')).href);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage(); await page.setContent(html);
    const w = await walkWizard(page, { facts: { firstName: 'Rafael', standard: { how_heard: 'Company careers page' } } });
    assert.equal(w.stoppedAt, 'review');
    assert.equal(w.pages.length, 3);
    assert.deepEqual(w.pages[0].filled, ['First Name ← Rafael', 'How did you hear about us? ← Company careers page']);
    // The filled standard question stays in the list — the apply step reuses the standard answer for it.
    assert.deepEqual(w.questions.map((q) => q.label), ['How did you hear about us?', 'Why do you want to work at Westpac?']);
    assert.equal(await page.evaluate(() => window.submitted), false);
    // 'fill' mode: the drafted answer lands in the tenant question, the radio gets ticked, still no Submit.
    const html2 = html.replace('<label for="q">Why do you want to work at Westpac?</label><textarea id="q"></textarea>', '<label for="q">Why do you want to work at Westpac?</label><textarea id="q"></textarea><fieldset><legend>Are you entitled to work in New Zealand?</legend><label><input type="radio" name="rtw" value="y">Yes</label><label><input type="radio" name="rtw" value="n">No</label></fieldset>');
    await page.setContent(html2);
    const w2 = await walkWizard(page, { mode: 'fill', facts: { firstName: 'Rafael', standard: { how_heard: 'Company careers page', right_to_work: 'Yes — NZ citizen' } }, answers: [{ question: 'Why do you want to work at Westpac?', answer: 'Because payments.' }] });
    assert.equal(w2.stoppedAt, 'review');
    assert.deepEqual(w2.pages[1].filled, ['Why do you want to work at Westpac? ← Because payments.', 'Are you entitled to work in New Zealand? ← Yes']);
    assert.equal(await page.evaluate(() => window.submitted), false);
  } finally { await browser.close(); }
});
