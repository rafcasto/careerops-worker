// advise — training (modes/training.md) or project (modes/project.md) verdicts against
// the candidate's North Star. Runs on the Evaluator's model with its own system prompt.
//   payload { kind: training|project, title, description, provider?, url?, cost?, effort? }
import { TRAINING_SYSTEM_PROMPT, PROJECT_SYSTEM_PROMPT, buildTaskMessages } from '../lib/prompts.js';
import { loadContext, runTask, finish, str } from './_task.js';

export async function run({ job, env, log, progress, cancelled }) {
  const kind = job.payload.kind === 'project' ? 'project' : 'training';
  const title = str(job.payload.title, 160), description = str(job.payload.description, 4000);
  if (!title || !description) throw new Error(`${kind} needs a title and a description`);
  await progress('loading your CV and profile');
  const { setup, cfg } = await loadContext({ job, env, agent: 'evaluator' });
  const system = kind === 'project' ? PROJECT_SYSTEM_PROMPT : TRAINING_SYSTEM_PROMPT;
  const facts = [`Name: ${title}`, job.payload.provider ? `${kind === 'project' ? 'Stack' : 'Provider'}: ${str(job.payload.provider, 160)}` : '', job.payload.url ? `Link: ${str(job.payload.url, 300)}` : '', job.payload.cost ? `Cost: ${str(job.payload.cost, 40)}` : '', job.payload.effort ? `Time: ${str(job.payload.effort, 60)}` : '', '', description].filter((l) => l !== undefined).join('\n');
  const messages = buildTaskMessages({ system, cv: setup.cvMarkdown, profileYaml: setup.profileYaml, extra: [[kind === 'project' ? 'THE PROJECT IDEA' : 'THE COURSE / CERTIFICATION', facts, 5000]], instruction: `Evaluate this ${kind} for the candidate and give the verdict.`, numCtx: cfg.numCtx, cvShare: 0.45 });
  await progress(`judging with ${cfg.model}`);
  const out = await runTask({ env, agent: 'evaluator', cfg, system, messages, log, progress, cancelled, numPredict: 1800 });
  if (await cancelled()) return null;
  const verdict = out.content.match(/\*\*(DO WITH TIMEBOX[^*]*|DON'T DO|DO|BUILD|SKIP|PIVOT TO[^*]*)\*\*/i)?.[1] ?? null;
  await progress(`done — ${verdict ?? 'verdict'}`);
  return finish({ job, kind, title: `${kind === 'project' ? 'Project' : 'Training'}: ${title}${verdict ? ` — ${verdict}` : ''}`, markdown: out.content, data: { verdict, title }, agent: 'evaluator', cfg, out });
}
