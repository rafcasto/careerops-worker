// build_dataset — approved examples → datasets/<name>/{train,exam}.jsonl on the Pi.
//   payload { agent: 'evaluator', name, sources: ['claude','live'] }
import { getAgentsConfig } from '../lib/firestore.js';
import { DEFAULT_AGENTS_CONFIG } from '../lib/prompts.js';
import { listExamples, saveDataset, writeDataset } from '../lib/training.js';

export async function run({ job, env, log, progress }) {
  const { payload } = job;
  const agent = 'evaluator';
  const name = String(payload.name || `evaluator-${new Date().toISOString().slice(0, 10)}`).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
  const sources = Array.isArray(payload.sources) && payload.sources.length ? payload.sources.map(String) : ['claude'];
  const config = await getAgentsConfig(DEFAULT_AGENTS_CONFIG);
  const cfg = config.agents[agent];

  await progress('collecting approved examples');
  const all = await listExamples({ agent, approvedOnly: true, sources });
  const train = all.filter((e) => e.split !== 'exam');
  const exam = all.filter((e) => e.split === 'exam');
  if (train.length < 5) throw new Error(`only ${train.length} approved training examples (${sources.join('+')}) — generate more gold first`);
  const dir = await writeDataset(env.trainingDir, name, { train, exam, systemPrompt: cfg.systemPrompt, numCtx: cfg.numCtx });
  const bySource = {}; for (const e of all) bySource[e.source] = (bySource[e.source] ?? 0) + 1;
  await saveDataset(name, { agent, sources, bySource, train: train.length, exam: exam.length, dir, promptVersion: cfg.promptVersion, builtAt: Date.now(), builtBy: job.createdBy, jobId: job.id });
  await log(`dataset ${name}: ${train.length} train / ${exam.length} exam → ${dir}`);
  await progress(`done — ${train.length} train, ${exam.length} exam`);
  return { name, train: train.length, exam: exam.length, bySource, dir };
}
