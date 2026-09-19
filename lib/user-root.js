// Per-member career-ops data root: <CAREEROPS_DATA_BASE>/<uid>/ — the "user
// layer" the career-ops scripts read via CAREER_OPS_ROOT. System layer stays
// in the shared upstream checkout (CAREER_OPS_REPO).
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SAFE_UID = /^[A-Za-z0-9_-]{1,128}$/;

export function userRoot(env, uid) {
  if (!SAFE_UID.test(uid)) throw new Error(`refusing unsafe uid "${uid}"`);
  return join(env.dataBase, uid);
}

// Writes cv.md + config/profile.yml from the member's Firestore setup doc.
// Returns the root path. Throws when there is no CV yet — evaluate needs one.
export async function ensureUserRoot(env, uid, setup) {
  const root = userRoot(env, uid);
  for (const d of ['config', 'data', 'reports', 'output', 'jds', 'modes', 'batch/tracker-additions']) await mkdir(join(root, d), { recursive: true });
  const cv = String(setup?.cvMarkdown ?? '').trim();
  if (!cv) throw new Error('No CV yet — add your CV in Agents → Setup first');
  await writeFile(join(root, 'cv.md'), cv + '\n', 'utf8');
  await writeFile(join(root, 'config', 'profile.yml'), String(setup?.profileYaml ?? '').trim() + '\n', 'utf8');
  return root;
}

export async function nextReportNumber(root) {
  try {
    const names = await readdir(join(root, 'reports'));
    const nums = names.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
    return (nums.length ? Math.max(...nums) : 0) + 1;
  } catch { return 1; }
}

export const slug = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
