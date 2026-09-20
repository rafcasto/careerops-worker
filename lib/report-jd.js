// The JD behind a report. Reports written before phase 3 (2026-09-19) carry jdChars but no
// `jd` text, so the Tailor / Writer would refuse them. Recover it from the member's root
// (jds/NNN-company.txt — written by every evaluation) or, failing that, re-read the posting
// URL; the recovered text is written back to Firestore so this only happens once.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { slug } from './user-root.js';
import { extractJd } from './extract.js';
import { updateReport } from './firestore.js';

const MIN_JD = 300;   // same floor as extractJd — anything shorter isn't a job description

export const jdFileFor = (report) => `${String(report.n ?? 0).padStart(3, '0')}-${slug(report.company)}.txt`;

export async function resolveReportJd({ env, uid, root, report, reportJobId, log, persist = updateReport }) {
  if (typeof report.jd === 'string' && report.jd.trim()) return report.jd;
  let jd = '', from = '';
  const file = join(root, 'jds', jdFileFor(report));
  try { const t = (await readFile(file, 'utf8')).trim(); if (t.length >= MIN_JD) { jd = t; from = `jds/${jdFileFor(report)}`; } } catch {}
  if (!jd && report.url) {
    await log?.(`report has no saved JD and none on disk — re-reading ${report.url}`);
    try { const ex = await extractJd(env, report.url, { log }); jd = ex.text; from = report.url; } catch (e) { await log?.(`could not re-read the posting: ${e.message}`); }
  }
  if (!jd) throw new Error(`this report has no saved job description (it predates JD storage and the posting can't be re-read) — re-run the evaluation for ${report.company}`);
  jd = jd.slice(0, 20000);
  await log?.(`recovered the job description from ${from} (${jd.length} chars) — saving it on the report`);
  try { await persist(uid, reportJobId, { jd, jdChars: report.jdChars ?? jd.length, jdRecoveredFrom: from, jdRecoveredAt: Date.now() }); }
  catch (e) { await log?.(`could not save the recovered JD on the report: ${e.message}`); }
  return jd;
}
