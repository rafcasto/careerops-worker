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
