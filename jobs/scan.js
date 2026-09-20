// scan — the Scout, in two passes:
//   1. career-ops scan.mjs over the member's portals.yml — companies whose careers URL is a
//      known job board (Greenhouse, Lever, Workday, Eightfold, … 80+ providers) are read
//      through the board API. Zero LLM tokens.
//   2. Every enabled company scan.mjs could NOT read (no provider matched — most bank and
//      corporate career sites — or the board answered with an error such as a WAF 403) goes
//      to the Pi's Playwright job-scraper (JOB_SCRAPER_URL), which finds the job list on the
//      page. Titles are filtered with the same positive/negative keywords.
// Both passes land in users/{uid}/careerOpsPipeline; per-company outcomes are written to
// users/{uid}/careerOps/portalsStatus so Setup can show what worked.
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getSetup, upsertPipeline, savePortalsStatus } from '../lib/firestore.js';
import { ensureUserRoot } from '../lib/user-root.js';

const idFor = (url) => createHash('sha1').update(url).digest('hex').slice(0, 20);

export function parsePending(md) {
  const pend = md.split(/^## Pending\s*$/m)[1]?.split(/^## /m)[0] ?? '';
  const items = [];
  for (const line of pend.split('\n')) {
    const m = line.match(/^- \[ \] (\S+)\s*\|\s*([^|]*)\|\s*([^|]*)(?:\|\s*([^|]*))?/);
    if (!m) continue;
    const url = m[1].trim();
    if (!/^https?:\/\//.test(url)) continue;
    items.push({ id: idFor(url), url, company: m[2].trim(), title: m[3].trim(), location: (m[4] ?? '').trim() || null });
  }
  return items;
}

// career-ops title_filter semantics: positive = any case-insensitive substring (empty list
// = everything passes); negative = substring, or whole word when prefixed "word:".
export function titleMatches(title, { positive = [], negative = [] } = {}) {
  const t = String(title ?? '').toLowerCase();
  if (!t) return false;
  for (const raw of negative) {
    const k = String(raw).trim(); if (!k) continue;
    if (k.toLowerCase().startsWith('word:')) { const w = k.slice(5).trim().toLowerCase(); if (w && new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(t)) return false; }
    else if (t.includes(k.toLowerCase())) return false;
  }
  return positive.length === 0 || positive.some((k) => String(k).trim() && t.includes(String(k).trim().toLowerCase()));
}

// Which companies career-ops can read through a board API (uses its own provider registry).
export async function classifyCompanies(repo, companies, log) {
  let providers = null;
  try { const reg = await import(join(repo, 'providers', '_registry.mjs')); providers = await reg.loadProviders(join(repo, 'providers')); var resolve = reg.resolveProvider; } catch (e) { await log?.(`provider registry unavailable (${e.message}) — treating every company as a page`); }
  return companies.map((c) => {
    if (!providers) return { ...c, method: 'page', provider: null };
    let r = null; try { r = resolve({ name: c.name, careers_url: c.careersUrl, enabled: true }, providers); } catch {}
    const id = r?.provider?.id ?? null;
    return { ...c, method: id ? 'board' : 'page', provider: id };
  });
}

async function scrapeCompany(env, c, log) {
  const t0 = Date.now();
  const r = await fetch(`${env.scraper}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: c.careersUrl }), signal: AbortSignal.timeout(4 * 60 * 1000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `scraper HTTP ${r.status}`);
  const jobs = Array.isArray(j.jobs) ? j.jobs.filter((x) => x && /^https?:\/\//.test(x.url) && x.title) : [];
  await log(`${c.name}: browser found ${jobs.length} posting${jobs.length === 1 ? '' : 's'} on ${j.careers_url ?? c.careersUrl} in ${Math.round((Date.now() - t0) / 1000)}s${j.note ? ` — ${j.note}` : ''}`);
  return { jobs, ms: Date.now() - t0, note: j.note ?? '' };
}

export async function run({ job, env, log, progress, cancelled }) {
  const { uid } = job;
  const setup = await getSetup(uid);
  const root = await ensureUserRoot(env, uid, setup);
  const portals = String(setup?.portalsYaml ?? '').trim();
  const companies = (setup?.portals?.companies ?? []).filter((c) => c && c.enabled !== false && c.name?.trim() && /^https?:\/\//.test(String(c.careersUrl ?? '').trim())).map((c) => ({ name: c.name.trim(), careersUrl: c.careersUrl.trim() }));
  if (!portals || companies.length === 0) throw new Error('No watchlist yet — add companies in CareerOps → Setup');
  await writeFile(join(root, 'portals.yml'), portals + '\n', 'utf8');
  const filter = { positive: setup?.portals?.positive ?? [], negative: setup?.portals?.negative ?? [] };
  const classified = await classifyCompanies(env.repo, companies, log);
  const boards = classified.filter((c) => c.method === 'board');
  await log(`${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}: ${boards.length} on a job board (${boards.map((c) => `${c.name}:${c.provider}`).join(', ') || '—'}), ${classified.length - boards.length} via browser`);

  // ---- pass 1: career-ops scan.mjs (board APIs) ----
  const t0 = Date.now();
  const status = new Map(classified.map((c) => [c.careersUrl, { name: c.name, careersUrl: c.careersUrl, method: c.method, provider: c.provider, found: 0, matched: 0, error: null }]));
  let receipt = null, boardItems = [];
  if (boards.length) {
    await progress(`reading ${boards.length} job board${boards.length === 1 ? '' : 's'}`);
    const { stdout, stderr, code } = await new Promise((resolve) => {
      const child = execFile(process.execPath, [join(env.repo, 'scan.mjs'), '--quiet', '--json'], { cwd: env.repo, timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_PORTALS: join(root, 'portals.yml') } },
        (err, stdout, stderr) => resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: err ? (err.code ?? 1) : 0 }));
      const t = setInterval(async () => { if (await cancelled()) { clearInterval(t); child.kill('SIGTERM'); } }, 5000);
      child.on('exit', () => clearInterval(t));
    });
    try { receipt = JSON.parse(stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? 'null'); } catch {}
    const tail = stderr.trim().split('\n').filter((l) => l.trim() && !/^[━→]/.test(l)).slice(-12).join('\n');
    await log(`scan.mjs exit ${code} in ${Math.round((Date.now() - t0) / 1000)}s${receipt ? ` · found ${receipt.found}, added ${receipt.added}, ${receipt.errors?.length ?? 0} error(s)` : ''}\n${tail}`);
    if (await cancelled()) return null;
    const md = await readFile(join(root, 'data', 'pipeline.md'), 'utf8').catch(() => '');
    boardItems = parsePending(md);
    for (const c of boards) { const st = status.get(c.careersUrl); st.found = boardItems.filter((i) => i.company.toLowerCase() === c.name.toLowerCase()).length; st.matched = st.found; }
    for (const e of receipt?.errors ?? []) { const c = boards.find((b) => b.name.toLowerCase() === String(e.company).toLowerCase()); if (c) status.get(c.careersUrl).error = String(e.error).slice(0, 160); }
  }

  // ---- pass 2: browser scraper for pages + boards that errored ----
  const toScrape = classified.filter((c) => c.method === 'page' || status.get(c.careersUrl).error);
  const pageItems = [];
  for (const [i, c] of toScrape.entries()) {
    if (await cancelled()) return null;
    const st = status.get(c.careersUrl);
    await progress(`browsing ${c.name} (${i + 1}/${toScrape.length})`);
    try {
      const { jobs, ms } = await scrapeCompany(env, c, log);
      const matched = jobs.filter((x) => titleMatches(x.title, filter));
      pageItems.push(...matched.map((x) => ({ id: idFor(x.url), url: x.url, company: c.name, title: String(x.title).trim().slice(0, 160), location: null })));
      if (st.method === 'board' && st.error) st.error = `board ${st.error} — read the page in the browser instead`;
      Object.assign(st, { method: 'page', found: jobs.length, matched: matched.length, ms });
      if (!jobs.length) st.error = st.error ?? 'no job list found on that page';
    } catch (e) {
      st.method = 'none'; st.error = String(e.message).slice(0, 160);
      await log(`${c.name}: browser scrape failed — ${e.message}`);
    }
  }

  const seen = new Set(); const items = [...boardItems, ...pageItems].filter((i) => !seen.has(i.id) && seen.add(i.id));
  const added = await upsertPipeline(uid, items);
  const companiesOut = classified.map((c) => status.get(c.careersUrl));
  await savePortalsStatus(uid, { jobId: job.id, companies: companiesOut });
  const readable = companiesOut.filter((c) => c.method !== 'none').length;
  await log(`pipeline: ${items.length} matching posting${items.length === 1 ? '' : 's'} (${boardItems.length} board, ${pageItems.length} page), ${added} new · ${readable}/${companiesOut.length} companies readable`);
  await progress(`done — ${added} new, ${items.length} matching, ${readable}/${companiesOut.length} companies readable`);
  return { pending: items.length, added, boards: boards.length, pages: toScrape.length, readable, durationMs: Date.now() - t0 };
}
