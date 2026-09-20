// Where the Researcher's answers come from — decided by the agent's model tag
// (Admin → CareerOps → Models):
//   claude-cli[:model]  → Claude Code, headless, WebSearch + WebFetch (your subscription)
//   claude-api[:model]  → Anthropic API + web_search (needs ANTHROPIC_API_KEY on the Pi)
//   anything else       → that Ollama model, no web access (says what it could not verify)
import { claudeConfigured, research } from './claude.js';
import { claudeCliAvailable, researchViaCli, isClaudeCliTag, cliModelFromTag } from './claude-cli.js';

const API_TAG = /^claude-api(?::([A-Za-z0-9._-]+))?$/;

export async function researcherMode(cfg) {
  const tag = String(cfg?.model ?? '');
  if (isClaudeCliTag(tag)) return (await claudeCliAvailable()) ? 'cli' : 'cli-missing';
  if (API_TAG.test(tag)) return claudeConfigured() ? 'api' : 'api-missing';
  return 'local';
}

// Returns null when the tag is an Ollama model — the caller runs it locally.
export async function researchWithClaude({ cfg, system, user, maxSearches, maxTokens, log, cancelled }) {
  const mode = await researcherMode(cfg);
  if (mode === 'cli-missing') throw new Error('The Researcher is set to Claude Code, but the CLI is not logged in on the Pi — run `claude auth login` as the worker user, or pick another model in Admin → CareerOps → Models');
  if (mode === 'api-missing') throw new Error('The Researcher is set to the Anthropic API, but ANTHROPIC_API_KEY is not on the Pi — set it, or pick claude-cli / an Ollama model in Admin → CareerOps → Models');
  if (mode === 'api') {
    const model = String(cfg.model).match(API_TAG)?.[1] || undefined;
    const r = await research({ system, user, log, maxSearches, maxTokens, model });
    return { content: r.text, via: 'claude-api', model: r.servedBy, durationMs: r.durationMs, usage: r.usage, sources: r.sources };
  }
  if (mode === 'cli') {
    const model = cliModelFromTag(cfg.model);
    const r = await researchViaCli({ system, user, model, log, maxSearches, cancelled });
    return { content: r.text, via: 'claude-cli', model: r.servedBy || (model ? `claude-code:${model}` : 'claude-code'), durationMs: r.durationMs, usage: r.usage, sources: r.sources };
  }
  return null;
}
