// ats-resolve — find the job board behind a careers page, so a member only ever pastes the
// URL they'd find on Google. Zero LLM tokens:
//   1. Fetch the page; collect links to hosts career-ops has a provider for (Workday,
//      Cornerstone, Eightfold, Greenhouse, …) and hand each to resolveProvider().
//   2. No such link? Fingerprint the page (and any jobs./careers. host it links to) for the
//      branded ATS families detect() cannot see from a URL — SuccessFactors, Phenom, Avature.
//   3. Confirm every candidate with career-ops' own probeProvider() (same code as
//      verify-portals.mjs) so we never suggest a board that answers 404 / empty.
// The result is a *suggestion* ({careersUrl, provider, apiUrl}) — the scan uses it right away
// and Setup offers it as a one-click "Use this"; the member's config is never rewritten.
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_HTML = 2 * 1024 * 1024;

// Hosts career-ops auto-detects from a URL. Order = preference when a page links to several.
const ATS_HOSTS = [
  /\.myworkdayjobs\.com$/i, /\.csod\.com$/i, /\.eightfold\.ai$/i, /(^|\.)greenhouse\.io$/i, /(^|\.)lever\.co$/i, /(^|\.)ashbyhq\.com$/i,
  /\.smartrecruiters\.com$/i, /\.workable\.com$/i, /\.oraclecloud\.com$/i, /\.icims\.com$/i, /\.teamtailor\.com$/i, /\.recruitee\.com$/i,
  /\.bamboohr\.com$/i, /\.breezy\.hr$/i, /\.jobvite\.com$/i, /\.avature\.net$/i, /\.successfactors\.(eu|com)$/i, /\.jobs2web\.com$/i,
  /\.jibeapply\.com$/i, /\.personio\.(de|com)$/i, /\.pinpointhq\.com$/i, /\.rippling\.com$/i, /\.beesite\.de$/i, /\.softgarden\.io$/i,
];
// Branded ATS families: no host to recognise, but the page markup gives them away.
const FINGERPRINTS = [
  { id: 'successfactors', re: /successfactors\.(eu|com)|jobs2web|tile-search-results|rmk-jobs|career\?site=/i },
  { id: 'phenom', re: /phenompeople|phenom\.com|ph-page|phapp|pcsx|"widgets"|\/widgets\b/i },
  { id: 'avature', re: /avature/i },
];
// Families career-ops has NO provider for — worth telling the member why it's browser-only.
const KNOWN_NO_PROVIDER = [[/snaphire/i, 'SnapHire'], [/qjumpers/i, 'QJumpers'], [/pageuppeople|pageup\.com/i, 'PageUp'], [/jobadder/i, 'JobAdder'], [/livehire/i, 'LiveHire'], [/expr3ss/i, 'Expr3ss']];

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };
const isAtsHost = (h) => ATS_HOSTS.some((re) => re.test(h));
const atsRank = (h) => { const i = ATS_HOSTS.findIndex((re) => re.test(h)); return i === -1 ? 99 : i; };

// Every absolute http(s) URL in href/src/content attributes and bare text, made absolute.
export function extractLinks(html, baseUrl) {
  const out = new Set();
  const s = String(html ?? '');
  for (const m of s.matchAll(/(?:href|src|content|data-url|action)\s*=\s*["']([^"'<>\s]+)["']/gi)) { try { out.add(new URL(m[1].replace(/&amp;/g, '&'), baseUrl).toString()); } catch {} }
  for (const m of s.matchAll(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s"'<>)\\]*)?/gi)) out.add(m[0].replace(/&amp;/g, '&').replace(/[.,;:]+$/, ''));
  return [...out];
}

// Links to hosts a provider can read, most-linked first, ATS preference as tiebreak.
export function extractAtsLinks(html, baseUrl) {
  const counts = new Map();
  for (const u of extractLinks(html, baseUrl)) { const h = hostOf(u); if (h && isAtsHost(h)) counts.set(u, (counts.get(u) ?? 0) + 1); }
  // Collapse to one URL per host: the shortest path (the board root), keeping the host's total weight.
  const byHost = new Map();
  for (const [u, n] of counts) { const h = hostOf(u); const cur = byHost.get(h); if (!cur) byHost.set(h, { url: u, n }); else { cur.n += n; if (u.length < cur.url.length) cur.url = u; } }
  return [...byHost.entries()].sort((a, b) => b[1].n - a[1].n || atsRank(a[0]) - atsRank(b[0])).map(([, v]) => v.url);
}

// Links to a jobs./careers./join. host that is not the page's own host — where a branded ATS usually lives.
export function extractCareerHosts(html, baseUrl) {
  const self = hostOf(baseUrl); const seen = new Set(); const out = [];
  for (const u of extractLinks(html, baseUrl)) {
    const h = hostOf(u);
    if (!h || h === self || isAtsHost(h) || seen.has(h) || !/^(jobs|careers?|join|work|talent|recruit|vacancies)[.-]/i.test(h)) continue;
    seen.add(h); out.push(originOf(u));
  }
  return out.filter(Boolean);
}

export function fingerprintHtml(html) {
  const s = String(html ?? '');
  for (const f of FINGERPRINTS) if (f.re.test(s)) return f.id;
  return null;
}
export function knownNoProvider(html) { const s = String(html ?? ''); for (const [re, label] of KNOWN_NO_PROVIDER) if (re.test(s)) return label; return null; }

export async function fetchPage(url, { timeoutMs = 20000 } = {}) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = (await r.text()).slice(0, MAX_HTML);
  return { url: r.url || url, html };
}

// career-ops' provider registry + probe, loaded from the checkout. Cached per process.
let toolsPromise = null;
export function loadCareerOpsTools(repo) {
  return (toolsPromise ??= (async () => {
    const reg = await import(join(repo, 'providers', '_registry.mjs'));
    const providers = await reg.loadProviders(join(repo, 'providers'));
    const { makeHttpCtx } = await import(join(repo, 'providers', '_http.mjs'));
    const { probeProvider } = await import(join(repo, 'verify-portals.mjs'));
    const ctx = makeHttpCtx();
    return { providers, resolve: (entry) => reg.resolveProvider(entry, providers, { skipIds: ['local-parser'] }), probe: (entry, provider) => probeProvider(entry, provider, ctx) };
  })());
}

// → { careersUrl, provider, apiUrl, live, via } | null. `hint` (string) rides along when the
// page is a known browser-only family. Everything network-y is injectable for tests.
export async function resolveCompany(company, { resolve, probe, fetchPage: fp = fetchPage, log, maxCandidates = 6 } = {}) {
  let page;
  try { page = await fp(company.careersUrl); } catch (e) { await log?.(`${company.name}: could not read ${company.careersUrl} to look for its job board — ${e.message}`); return null; }
  const tryEntry = async (entry, via) => {
    const r = resolve(entry); const p = r?.provider; if (!p) return null;
    const res = await probe(entry, p);
    if (res.status === 'live' || res.status === 'empty') return { careersUrl: entry.careers_url, provider: p.id, apiUrl: entry.api ?? null, live: res.jobCount ?? null, via };
    await log?.(`${company.name}: ${p.id} at ${entry.careers_url} answered ${res.httpStatus ?? res.errorKind ?? res.status} — not it`);
    return null;
  };
  // 1. links to hosts a provider reads, plus the page itself if it redirected onto one.
  const candidates = [];
  if (isAtsHost(hostOf(page.url)) && hostOf(page.url) !== hostOf(company.careersUrl)) candidates.push(page.url);
  candidates.push(...extractAtsLinks(page.html, page.url).filter((u) => !candidates.includes(u)));
  let fallback = null;
  for (const url of candidates.slice(0, maxCandidates)) {
    const hit = await tryEntry({ name: company.name, careers_url: url, enabled: true }, 'link');
    if (hit?.live) return hit;
    fallback ??= hit;
  }
  // 2. branded ATS: fingerprint this page, then the jobs./careers. hosts it links to.
  const pages = [page];
  for (const origin of extractCareerHosts(page.html, page.url).slice(0, 2)) { try { pages.push(await fp(origin)); } catch {} }
  for (const pg of pages) {
    const id = fingerprintHtml(pg.html); if (!id) continue;
    const origin = originOf(pg.url); if (!origin) continue;
    const hit = await tryEntry({ name: company.name, careers_url: origin, provider: id, api: origin, enabled: true }, 'fingerprint');
    if (hit?.live) return hit;
    fallback ??= hit;
  }
  if (fallback) return fallback;
  const family = pages.map((p) => knownNoProvider(p.html)).find(Boolean);
  return family ? { hint: `runs on ${family}, which has no board API — read in the browser` } : null;
}
