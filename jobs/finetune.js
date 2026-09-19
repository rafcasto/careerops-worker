// finetune — LoRA on the GPU box over ssh, GGUF back, `ollama create` on the Pi.
//   payload { agent: 'evaluator', dataset, base, tag, epochs (0.5–5), maxSeq }
import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDataset, saveModel, safeTag } from '../lib/training.js';

const BASES = ['unsloth/Qwen2.5-1.5B-Instruct', 'unsloth/Llama-3.2-3B-Instruct', 'unsloth/Qwen2.5-3B-Instruct', 'unsloth/Llama-3.2-1B-Instruct'];

function sh(cmd, args, { log, cancelled, cwd, timeout = 6 * 3600 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd });
    let out = '', lastFlush = 0;
    const onData = (b) => { out += b.toString(); if (log && Date.now() - lastFlush > 20000) { lastFlush = Date.now(); log(out.trim().split('\n').slice(-3).join('\n')); } };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    const poll = cancelled ? setInterval(async () => { if (await cancelled()) child.kill('SIGTERM'); }, 5000) : null;
    child.on('close', (code) => { clearTimeout(timer); if (poll) clearInterval(poll); code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args[0] ?? ''} exited ${code}: ${out.trim().split('\n').slice(-5).join(' · ')}`)); });
    child.on('error', reject);
  });
}

export async function run({ job, env, log, progress, cancelled }) {
  const { payload } = job;
  const host = env.gpuHost;
  if (!host) throw new Error('GPU_SSH_HOST is not set');
  const datasetName = String(payload.dataset || '');
  const ds = await getDataset(datasetName);
  if (!ds) throw new Error(`dataset "${datasetName}" not found — build it first`);
  const base = BASES.includes(payload.base) ? payload.base : BASES[1];
  const tag = safeTag(payload.tag || `careerops-evaluator:${new Date().toISOString().slice(0, 10)}`);
  const epochs = Math.min(5, Math.max(0.5, Number(payload.epochs) || 2));
  const maxSeq = Math.min(8192, Math.max(2048, Math.round(Number(payload.maxSeq) || 6144)));
  // Effective batch = batch × accum; scale accumulation to the dataset so tiny pilots still take real steps.
  const accum = Math.max(1, Math.min(16, Math.floor((ds.train ?? 16) / 4)));
  const outName = tag.replace(/[:/]/g, '-');
  const remote = `~/careerops-finetune/${outName}`;
  const ssh = (cmd) => sh('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, cmd], { log, cancelled });

  await saveModel(tag, { agent: 'evaluator', base, dataset: datasetName, epochs, maxSeq, status: 'training', source: 'finetune', startedAt: Date.now(), jobId: job.id, createdBy: job.createdBy });
  try {
    await progress('checking the GPU box');
    const gpu = await ssh('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader');
    await log(`gpu: ${gpu.trim()}`);

    await progress('syncing dataset + trainer');
    await ssh(`mkdir -p ${remote}`);
    await sh('rsync', ['-az', join(env.repoWorker ?? process.cwd(), 'training', 'train_lora.py'), `${host}:${remote}/train_lora.py`], { log });
    await sh('rsync', ['-az', join(ds.dir, 'train.jsonl'), `${host}:${remote}/train.jsonl`], { log });

    await progress('python env (first run installs unsloth — slow)');
    await ssh(`[ -x ~/careerops-finetune/venv/bin/python3 ] || python3 -m venv ~/careerops-finetune/venv; ~/careerops-finetune/venv/bin/python3 -c 'import torch, unsloth, trl, datasets' 2>/dev/null || { ~/careerops-finetune/venv/bin/pip install -q --upgrade pip && ~/careerops-finetune/venv/bin/pip install -q torch --index-url https://download.pytorch.org/whl/cu128 && ~/careerops-finetune/venv/bin/pip install -q 'unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git' trl datasets; }`);

    await progress(`training ${base} on ${ds.train} examples × ${epochs} epochs (accum ${accum})`);
    await ssh(`cd ${remote} && PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True UNSLOTH_CE_LOSS_TARGET_GB=1 ~/careerops-finetune/venv/bin/python3 train_lora.py --base '${base}' --data train.jsonl --out ${outName} --epochs ${epochs} --max_seq ${maxSeq} --batch 1 --accum ${accum}`);

    await progress('fetching the GGUF');
    const local = join(env.trainingDir, 'models', outName);
    await mkdir(local, { recursive: true });
    await sh('rsync', ['-az', `${host}:${remote}/${outName}/`, `${local}/`, '--include=*.gguf', '--include=Modelfile', '--exclude=*'], { log });
    const gguf = (await readdir(local)).find((f) => f.endsWith('.gguf'));
    if (!gguf) throw new Error('no GGUF came back from the GPU box');

    await progress(`importing into Ollama as ${tag}`);
    await sh('ollama', ['create', tag, '-f', join(local, 'Modelfile')], { cwd: local, log });
    await saveModel(tag, { status: 'ready', ggufPath: join(local, gguf), trainedAt: Date.now(), endedAt: Date.now() });
    await log(`ready: ${tag} ← ${base} on ${datasetName} (${ds.train} examples, ${epochs} epochs)`);
    await progress(`done — ${tag} is on the Pi`);
    return { tag, base, dataset: datasetName, gguf };
  } catch (e) {
    await saveModel(tag, { status: 'failed', error: e.message, endedAt: Date.now() });
    throw e;
  }
}
