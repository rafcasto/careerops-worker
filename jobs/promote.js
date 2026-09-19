// promote — make a model the agent's production model (same as Admin → Models).
//   payload { agent, tag }
import { firestore } from '../lib/firestore.js';
import { AGENT_KEYS } from '../lib/keys.js';

export async function run({ job, env, log }) {
  const { payload } = job;
  const agent = AGENT_KEYS.includes(payload.agent) ? payload.agent : 'evaluator';
  const tag = String(payload.tag || '').trim();
  if (!tag) throw new Error('promote needs a model tag');
  const r = await fetch(`${env.ollama}/api/show`, { method: 'POST', body: JSON.stringify({ model: tag }) });
  if (!r.ok) throw new Error(`model ${tag} is not on the Pi`);
  await firestore().doc('config/agents').set({ agents: { [agent]: { model: tag } }, updatedAt: Date.now(), updatedBy: job.createdBy }, { merge: true });
  await log(`${agent} now runs on ${tag}`);
  return { agent, tag };
}
