// Claude as the teacher: generates synthetic cases and gold evaluations for
// fine-tuning the small Pi models. Official SDK, streamed (long outputs),
// server-side refusal fallbacks on. Needs ANTHROPIC_API_KEY on the Pi only.
import Anthropic from '@anthropic-ai/sdk';

export const TEACHER_MODEL = process.env.CLAUDE_TEACHER_MODEL || 'claude-fable-5-1';
let client = null;

export const claudeConfigured = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

function getClient() {
  if (!client) client = new Anthropic({ timeout: 20 * 60 * 1000, maxRetries: 2 });
  return client;
}

// One teacher turn. `system` may be a string or [{type:'text', text, cache_control}] so the
// big career-ops rubric is cached across the cases of a job.
export async function teach({ system, user, maxTokens = 16000, effort = 'high', log }) {
  const t0 = Date.now();
  const stream = getClient().beta.messages.stream({
    model: TEACHER_MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort },
    system,
    messages: [{ role: 'user', content: user }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') {
    throw new Error(`Claude declined this case (${msg.stop_details?.category ?? 'unspecified'}): ${msg.stop_details?.explanation ?? ''}`.trim());
  }
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const servedBy = msg.model;
  const usage = { input: msg.usage.input_tokens, output: msg.usage.output_tokens, cacheRead: msg.usage.cache_read_input_tokens ?? 0, cacheWrite: msg.usage.cache_creation_input_tokens ?? 0 };
  if (log) await log(`claude ${servedBy}: ${usage.output} tokens out, ${usage.input} in (${usage.cacheRead} cached) in ${Math.round((Date.now() - t0) / 1000)}s${msg.stop_reason === 'max_tokens' ? ' — hit max_tokens' : ''}`);
  return { text, usage, servedBy, stopReason: msg.stop_reason, durationMs: Date.now() - t0 };
}

// One research turn with web search — used by the Researcher agent (deep, contacto)
// when the Pi has an Anthropic key. Returns the text plus the sources it read, so the
// note can cite them. Server-side refusal fallbacks stay on, like teach().
export async function research({ system, user, maxTokens = 8000, maxSearches = 6, effort = 'medium', log }) {
  const t0 = Date.now();
  const stream = getClient().beta.messages.stream({
    model: TEACHER_MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort },
    system,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches }],
    messages: [{ role: 'user', content: user }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') {
    throw new Error(`Claude declined this request (${msg.stop_details?.category ?? 'unspecified'}): ${msg.stop_details?.explanation ?? ''}`.trim());
  }
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const sources = [];
  for (const b of msg.content) {
    if (b.type !== 'web_search_tool_result' || !Array.isArray(b.content)) continue; // an object here means a tool error, not results
    for (const r of b.content) if (r.type === 'web_search_result' && r.url && !sources.some((s) => s.url === r.url)) sources.push({ title: r.title ?? '', url: r.url });
  }
  const usage = { input: msg.usage.input_tokens, output: msg.usage.output_tokens, searches: msg.usage.server_tool_use?.web_search_requests ?? 0 };
  if (log) await log(`claude ${msg.model}: ${usage.output} tokens out, ${usage.searches} web searches, ${sources.length} sources in ${Math.round((Date.now() - t0) / 1000)}s`);
  return { text, sources, usage, servedBy: msg.model, durationMs: Date.now() - t0 };
}
