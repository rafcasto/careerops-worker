// sync_setup — write the member's CV + profile.yml into their career-ops root.
import { getSetup } from '../lib/firestore.js';
import { ensureUserRoot } from '../lib/user-root.js';

export async function run({ job, env, log }) {
  const root = await ensureUserRoot(env, job.uid, await getSetup(job.uid));
  await log(`synced cv.md + config/profile.yml → ${root}`);
  return { root };
}
