// Runs one agent turn. Preferred path: the agent's n8n workflow (webhook
// /webhook/careerops/<agent>) so the flow is editable in n8n. If that workflow
// is not active yet, falls back to Ollama directly so members are never blocked.
// Plain node:http on purpose: fetch/undici gives up when response headers take
// longer than 300 s, and a Pi-sized model can take longer than that to answer.
import http from 'node:http';

function post(url, body, { onLine, cancelled, timeoutMs = 60 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let buf = '', all = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        all += chunk;
        if (!onLine) return;
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine(line); }
      });
      res.on('end', () => { if (onLine && buf.trim()) onLine(buf.trim()); resolve({ status: res.statusCode, text: all }); });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('LLM request timed out')));
    if (cancelled) {
      const t = setInterval(async () => { if (await cancelled()) { clearInterval(t); req.destroy(new Error('cancelled')); } }, 5000);
      req.on('close', () => clearInterval(t));
    }
    req.end(data);
  });
}

export async function runAgent({ env, agent, cfg, messages, log, progress, cancelled, optionOverrides = {} }) {
  // num_predict caps the answer: a small model with no cap can ramble for 20+ minutes on a Pi.
  // repeat_penalty / repeat_last_n: small models at low temperature loop on a block
  // ("**COMPANY TYPE:** SaaS" × 40). Mild penalty over a long window stops that.
  const options = { temperature: cfg.temperature, num_ctx: cfg.numCtx, num_predict: cfg.numPredict ?? 2800, repeat_penalty: cfg.repeatPenalty ?? 1.15, repeat_last_n: 256, ...optionOverrides };
  const t0 = Date.now();

  // 1) n8n workflow
  const hook = `${env.n8n}/webhook/careerops/${agent}`;
  try {
    const r = await post(hook, { agent, model: cfg.model, options, messages }, { cancelled });
    if (r.status === 200) {
      const j = JSON.parse(r.text);
      const content = j.content ?? j.message?.content ?? j.response;
      if (typeof content === 'string' && content.trim()) {
        await log(`n8n workflow careerops/${agent} answered in ${Math.round((Date.now() - t0) / 1000)}s (${j.usage?.completion ?? '?'} tokens, stop: ${j.done_reason ?? '?'})`);
        return { content, via: 'n8n', usage: j.usage ?? null, doneReason: j.done_reason ?? null, durationMs: Date.now() - t0 };
      }
      await log(`n8n workflow careerops/${agent} returned no content — falling back to Ollama`);
    } else {
      await log(`n8n workflow careerops/${agent} not available (HTTP ${r.status}) — falling back to Ollama`);
    }
  } catch (e) {
    if (e.message === 'cancelled') throw e;
    await log(`n8n unreachable (${e.message}) — falling back to Ollama`);
  }

  // 2) Ollama directly (streamed so we can report progress + honour cancel)
  let content = '', tokens = 0, usage = null, doneReason = null;
  let lastProgress = 0;
  await post(`${env.ollama}/api/chat`, { model: cfg.model, messages, options, stream: true }, {
    cancelled,
    onLine: (line) => {
      try {
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        if (j.message?.content) { content += j.message.content; tokens++; }
        if (j.done) { usage = { prompt: j.prompt_eval_count ?? null, completion: j.eval_count ?? null }; doneReason = j.done_reason ?? null; }
        if (Date.now() - lastProgress > 15000) { lastProgress = Date.now(); progress(`generating… ${tokens} tokens`); }
      } catch (e) { if (e.message !== 'Unexpected end of JSON input') throw e; }
    },
  });
  if (!content.trim()) throw new Error(`Ollama returned no content for model ${cfg.model}`);
  await log(`ollama ${cfg.model} answered in ${Math.round((Date.now() - t0) / 1000)}s (${tokens} tokens, stop: ${doneReason ?? '?'})`);
  return { content, via: 'ollama', usage, doneReason, durationMs: Date.now() - t0 };
}
