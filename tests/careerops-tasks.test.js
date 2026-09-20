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
});
