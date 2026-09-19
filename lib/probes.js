// Cheap reachability checks the worker publishes in careerops:state / heartbeat.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

export async function ollamaModels(base) {
  try {
    const r = await withTimeout(fetch(`${base}/api/tags`), 4000, null);
    if (!r?.ok) return null;
    const { models = [] } = await r.json();
    return models.map((m) => ({
      name: m.name,
      sizeGb: Math.round((m.size / 1e9) * 100) / 100,
      modifiedAt: m.modified_at,
      family: m.details?.family,
      params: m.details?.parameter_size,
    }));
  } catch { return null; }
}

// n8n public REST needs an API key; the healthz endpoint does not. Workflow
// activity per agent is read from the n8n SQLite directly when available.
export async function n8nUp(base) {
  try { const r = await withTimeout(fetch(`${base}/healthz`), 3000, null); return !!r?.ok; } catch { return false; }
}

export async function n8nAgentWorkflows(agentKeys) {
  // Workflows are matched by name prefix "careerops/<agent>" — set that name in n8n.
  try {
    const { default: Database } = await import('node:sqlite').then((m) => ({ default: m.DatabaseSync })).catch(() => ({ default: null }));
    if (!Database) return agentKeys.map((key) => ({ key, n8nWorkflowId: null, active: false }));
    const db = new Database(join(process.env.HOME, '.n8n', 'database.sqlite'), { readOnly: true });
    const rows = db.prepare('select id, name, active from workflow_entity').all();
    db.close();
    return agentKeys.map((key) => {
      const w = rows.find((r) => String(r.name).toLowerCase().startsWith(`careerops/${key}`));
      return { key, n8nWorkflowId: w?.id ?? null, active: !!w?.active };
    });
  } catch { return agentKeys.map((key) => ({ key, n8nWorkflowId: null, active: false })); }
}

export function gpuReachable(host) {
  if (!host) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', host, 'true'], { timeout: 8000 }, (err) => resolve(!err));
  });
}

export async function careerOpsVersion(repo) {
  try { return JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version ?? null; } catch { return null; }
}
