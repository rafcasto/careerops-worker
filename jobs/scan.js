// scan — the Scout: career-ops scan.mjs over the member's portals.yml (zero
// LLM tokens: public ATS APIs + JSON boards), then the new "## Pending" lines
// from data/pipeline.md are mirrored into Firestore for the Scan screen.
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getSetup, upsertPipeline } from '../lib/firestore.js';
import { ensureUserRoot } from '../lib/user-root.js';

export function parsePending(md) {
  const pend = md.split(/^## Pending\s*$/m)[1]?.split(/^## /m)[0] ?? '';
  const items = [];
  for (const line of pend.split('\n')) {
    const m = line.match(/^- \[ \] (\S+)\s*\|\s*([^|]*)\|\s*([^|]*)(?:\|\s*([^|]*))?/);
    if (!m) continue;
    const url = m[1].trim();
    if (!/^https?:\/\//.test(url)) continue;
    items.push({ id: createHash('sha1').update(url).digest('hex').slice(0, 20), url, company: m[2].trim(), title: m[3].trim(), location: (m[4] ?? '').trim() || null });
  }
  return items;
}

export async function run({ job, env, log, progress, cancelled }) {
  const { uid } = job;
  const setup = await getSetup(uid);
  const root = await ensureUserRoot(env, uid, setup);
  const portals = String(setup?.portalsYaml ?? '').trim();
  if (!portals) throw new Error('No watchlist yet — add companies in CareerOps → Setup');
  await writeFile(join(root, 'portals.yml'), portals + '\n', 'utf8');

  await progress('scanning your portals');
  const t0 = Date.now();
  const { stdout, stderr, code } = await new Promise((resolve) => {
    const child = execFile(process.execPath, [join(env.repo, 'scan.mjs'), '--quiet'], { cwd: env.repo, timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_PORTALS: join(root, 'portals.yml') } },
      (err, stdout, stderr) => resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: err ? (err.code ?? 1) : 0 }));
    const t = setInterval(async () => { if (await cancelled()) { clearInterval(t); child.kill('SIGTERM'); } }, 5000);
    child.on('exit', () => clearInterval(t));
  });
  const tail = (stdout + '\n' + stderr).trim().split('\n').filter((l) => l.trim()).slice(-25).join('\n');
  await log(`scan.mjs exit ${code} in ${Math.round((Date.now() - t0) / 1000)}s\n${tail}`);
  if (await cancelled()) return null;
  if (code !== 0 && !/portal|provider|fetch/i.test(tail)) throw new Error(`scan failed (exit ${code})`);

  const md = await readFile(join(root, 'data', 'pipeline.md'), 'utf8').catch(() => '');
  const items = parsePending(md);
  const added = await upsertPipeline(uid, items);
  await log(`pipeline: ${items.length} pending posting${items.length === 1 ? '' : 's'}, ${added} new`);
  await progress(`done — ${added} new, ${items.length} pending`);
  return { pending: items.length, added, durationMs: Date.now() - t0 };
}
