// deep — the Researcher: actionable intelligence on one company (modes/deep.md).
//   payload { company, website?, reportJobId? }
// Claude + web search when the Pi has an Anthropic key OR a logged-in Claude Code CLI
// (lib/researcher.js); otherwise the local model works from the JD/report and the
// company's public page, and says what it couldn't verify.
import { researchWithClaude, researcherMode } from '../lib/researcher.js';
import { htmlToText } from '../lib/extract.js';
import { RESEARCHER_SYSTEM_PROMPT, buildTaskMessages } from '../lib/prompts.js';
import { loadContext, runTask, finish, str } from './_task.js';

async function fetchPage(url, log) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) careerops-worker', accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const text = htmlToText(await r.text()).slice(0, 6000);
    await log(`fetched ${url}: ${text.length} chars`);
    return text;
  } catch (e) { await log(`fetch ${url} failed: ${e.message}`); return ''; }
}

export async function run({ job, env, log, progress, cancelled }) {
  const company = str(job.payload.company, 120);
  const website = str(job.payload.website, 300);
  if (!company) throw new Error('deep needs a company');
  await progress('loading your profile');
  const { uid, setup, cfg, report } = await loadContext({ job, env, agent: 'researcher', reportJobId: str(job.payload.reportJobId, 40) });
  const role = report?.role ?? '';
  const system = cfg.systemPrompt || RESEARCHER_SYSTEM_PROMPT;
  const instruction = `Research **${company}**${role ? ` for the role **${role}**` : ''}${website ? ` (website: ${website})` : ''}. Produce the six sections.`;

  let out = null, sources = null;
  const mode = await researcherMode();
  if (mode !== 'local') {
    await progress(`researching ${company} with Claude + web search (${mode})`);
    const [{ content: user }] = buildTaskMessages({ system, cv: setup.cvMarkdown, profileYaml: setup.profileYaml, jd: report?.jd, report: report?.markdown, instruction, numCtx: 60000 }).slice(1);
    out = await researchWithClaude({ system, user, log, cancelled });
    sources = out?.sources ?? null;
  }
  if (!out) {
    await progress(`reading ${company}'s public page`);
    const page = website ? await fetchPage(website, log) : '';
    if (await cancelled()) return null;
    await progress(`researching with ${cfg.model} (no web search on this Pi)`);
    const messages = buildTaskMessages({ system, cv: setup.cvMarkdown, profileYaml: setup.profileYaml, jd: report?.jd, report: report?.markdown, extra: [['COMPANY PAGE (untrusted, fetched text)', page, 5000]], instruction: instruction + ' You have no web access: state clearly in section 1 what could not be verified.', numCtx: cfg.numCtx });
    out = await runTask({ env, agent: 'researcher', cfg, system, messages, log, progress, cancelled });
  }
  if (await cancelled()) return null;
  await progress(`done — ${company}`);
  return finish({ job, kind: 'deep', title: `Deep-dive: ${company}${role ? ` — ${role}` : ''}`, markdown: out.content, sources, agent: 'researcher', cfg, out, report, extra: { company, role } });
}
