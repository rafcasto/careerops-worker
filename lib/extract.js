// JD extraction from a URL. Zero-dependency first pass (fetch + strip), with
// career-ops' Playwright reader as a fallback for JS-rendered boards when it is
// installed. Read-only: never clicks or submits anything.
import { execFile } from 'node:child_process';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ');
  const main = s.match(/<main[\s\S]*?<\/main>/i)?.[0] || s.match(/<article[\s\S]*?<\/article>/i)?.[0] || s;
  return main.replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

export async function extractJd(env, url, { log } = {}) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('URL must be http(s)');
  let title = '', text = '';
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    const html = await r.text();
    title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '';
    text = htmlToText(html);
    if (r.status === 404 || r.status === 410) throw new Error(`posting returns HTTP ${r.status} — likely closed`);
  } catch (e) { if (log) await log(`fetch ${url}: ${e.message}`); if (/closed/.test(e.message)) throw e; }

  if (text.length < 600) {
    if (log) await log('page has little server-rendered text — trying career-ops browser-extract');
    const out = await new Promise((resolve) => execFile(process.execPath, [join(env.repo, 'browser-extract.mjs'), url, '--mode', 'jd'], { cwd: env.repo, timeout: 90000, env: { ...process.env, CAREER_OPS_ROOT: env.repo } }, (err, stdout) => resolve(err ? null : stdout)));
    try { const j = JSON.parse(out || 'null'); if (j?.text) { text = j.text; title = j.title || title; } } catch {}
  }
  if (text.length < 300) throw new Error('Could not read a job description from that URL — paste the JD text instead');
  return { title, text: text.slice(0, 20000) };
}
