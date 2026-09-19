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
    // torch/unsloth ship wheels for CPython ≤ 3.12: prefer python3.12 / 3.11 when creating the venv,
    // and let pip resume the ~800 MB torch download instead of failing on a flaky link.
    await ssh(`V=~/careerops-finetune/venv; [ -x $V/bin/python3 ] || { PY=$(command -v python3.12 || command -v python3.11 || command -v python3); echo "creating venv with $PY ($($PY --version))"; $PY -m venv $V; }; $V/bin/python3 -c 'import torch, unsloth, trl, datasets' 2>/dev/null || { $V/bin/pip install -q --upgrade pip && $V/bin/pip install -q --resume-retries 10 torch --index-url https://download.pytorch.org/whl/cu128 && $V/bin/pip install -q --resume-retries 10 'unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git' trl datasets; }`);

    await progress(`training ${base} on ${ds.train} examples × ${epochs} epochs (accum ${accum})`);
    // Detached: a laptop GPU box drops SSH sessions (sleep, Wi-Fi). Training runs under nohup
    // and writes .exit when done; we poll and tolerate connection blips in between.
    // Ship the training script as a file (base64, no shell-quoting games) so the exit
    // code written to .exit is the trainer's, not something the login shell expanded.
    const trainScript = `#!/bin/bash
cd ${remote}
rm -f .exit
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True UNSLOTH_CE_LOSS_TARGET_GB=1
~/careerops-finetune/venv/bin/python3 train_lora.py --base '${base}' --data train.jsonl --out ${outName} --epochs ${epochs} --max_seq ${maxSeq} --batch 1 --accum ${accum} > train.log 2>&1
echo $? > .exit
`;
    const b64 = Buffer.from(trainScript).toString('base64');
    await ssh(`echo ${b64} | base64 -d > ${remote}/train.sh && chmod +x ${remote}/train.sh && (nohup ${remote}/train.sh > /dev/null 2>&1 &) && echo started`);
    const t0 = Date.now();
    let lastTail = '', misses = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 30000));
      if (await cancelled()) { await ssh(`pkill -f 'train_lora.py --base' || true`).catch(() => {}); throw new Error('cancelled'); }
      if (Date.now() - t0 > 4 * 3600 * 1000) throw new Error('training exceeded 4 hours');
      let out;
      try { out = await sh('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, `cd ${remote} && (cat .exit 2>/dev/null || echo running) && tail -c 1500 train.log 2>/dev/null | tr '\\r' '\\n' | grep -v '^$' | tail -4`]); misses = 0; }
      catch (e) { misses++; await log(`GPU box unreachable (${misses}/20): ${e.message.split('\n')[0].slice(0, 120)}`); if (misses >= 20) throw new Error('GPU box unreachable for 10 minutes — is it asleep? Training may still be running there; re-run to resume once it is back'); continue; }
      const [first, ...rest] = out.trim().split('\n');
      const tail = rest.join('\n');
      if (tail && tail !== lastTail) { lastTail = tail; await log(tail); }
      if (first !== 'running') { if (first.trim() !== '0') throw new Error(`training exited ${first.trim()}: ${tail.split('\n').slice(-3).join(' · ')}`); break; }
      await progress(`training… ${Math.round((Date.now() - t0) / 60000)} min`);
    }

    await progress('fetching the GGUF (resumable)');
    const local = join(env.trainingDir, 'models', outName);
    await mkdir(local, { recursive: true });
    // ~1 GB over a laptop Wi-Fi link: resume on every drop instead of starting over.
    let fetched = false;
    for (let attempt = 1; attempt <= 40 && !fetched; attempt++) {
      if (await cancelled()) throw new Error('cancelled');
      try {
        await sh('rsync', ['-az', '--partial', '--append-verify', '--timeout=60', '-e', 'ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=3', `${host}:${remote}/${outName}/`, `${local}/`, '--include=*.gguf', '--include=Modelfile', '--exclude=*'], { log });
        fetched = true;
      } catch (e) { await log(`fetch attempt ${attempt} failed (${e.message.split('\n')[0].slice(0, 100)}) — retrying in 15s`); await new Promise((r) => setTimeout(r, 15000)); }
    }
    if (!fetched) throw new Error('could not fetch the GGUF from the GPU box after 40 attempts');
    const gguf = (await readdir(local)).find((f) => f.endsWith('.gguf'));
    if (!gguf) throw new Error('no GGUF came back from the GPU box');
    // Our own Modelfile: no TEMPLATE override, so Ollama uses the chat template from the GGUF.
    await writeFile(join(local, 'Modelfile'), `FROM ./${gguf}\nPARAMETER temperature 0.2\nPARAMETER num_ctx 8192\nPARAMETER repeat_penalty 1.15\n`, 'utf8');

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
