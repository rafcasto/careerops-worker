// import_model — a GGUF trained elsewhere (Colab, another box) uploaded to the
// Drive folder → `ollama create` on the Pi.
//   payload { tag, driveFileId, base? }
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { accessToken } from '../lib/drive.js';
import { saveModel, safeTag } from '../lib/training.js';

export async function run({ job, env, log, progress }) {
  const { payload } = job;
  const tag = safeTag(payload.tag || '');
  const fileId = String(payload.driveFileId || '').trim();
  if (!tag || !/^[A-Za-z0-9_-]{10,}$/.test(fileId)) throw new Error('import_model needs a tag and a Drive file id');
  const outName = tag.replace(/[:/]/g, '-');
  const local = join(env.trainingDir, 'models', outName);
  await mkdir(local, { recursive: true });
  await saveModel(tag, { agent: 'evaluator', status: 'importing', source: 'import', base: payload.base ?? null, driveFileId: fileId, startedAt: Date.now(), jobId: job.id, createdBy: job.createdBy });
  try {
    await progress('downloading the GGUF from Drive');
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { authorization: `Bearer ${await accessToken()}` } });
    if (!r.ok) throw new Error(`Drive download → ${r.status}`);
    const gguf = join(local, 'model.gguf');
    await pipeline(Readable.fromWeb(r.body), createWriteStream(gguf));
    await writeFile(join(local, 'Modelfile'), `FROM ./model.gguf\nPARAMETER temperature 0.2\nPARAMETER num_ctx 8192\nPARAMETER repeat_penalty 1.15\n`, 'utf8');
    await progress(`importing into Ollama as ${tag}`);
    await new Promise((res, rej) => execFile('ollama', ['create', tag, '-f', 'Modelfile'], { cwd: local, timeout: 30 * 60 * 1000 }, (e, so, se) => (e ? rej(new Error(`ollama create failed: ${(se || so || e.message).trim().slice(-300)}`)) : res())));
    await saveModel(tag, { status: 'ready', ggufPath: gguf, importedAt: Date.now(), endedAt: Date.now() });
    await log(`ready: ${tag} imported from Drive`);
    return { tag };
  } catch (e) { await saveModel(tag, { status: 'failed', error: e.message, endedAt: Date.now() }); throw e; }
}
