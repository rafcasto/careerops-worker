// Where the Researcher's answers come from, in order of preference:
//   1. Anthropic API + web_search   (ANTHROPIC_API_KEY on the Pi)
//   2. Claude Code CLI, headless    (`claude login` on the Pi — your subscription, no key)
//   3. the local Ollama model       (no web access; says what it could not verify)
import { claudeConfigured, research, TEACHER_MODEL } from './claude.js';
import { claudeCliAvailable, researchViaCli, CLI_MODEL } from './claude-cli.js';

export async function researcherMode() {
  if (claudeConfigured()) return 'api';
  if (await claudeCliAvailable()) return 'cli';
  return 'local';
}

// Returns null when neither Claude path is available — the caller runs the local model.
export async function researchWithClaude({ system, user, maxSearches, maxTokens, log, cancelled }) {
  const mode = await researcherMode();
  if (mode === 'api') {
    const r = await research({ system, user, log, maxSearches, maxTokens });
    return { content: r.text, via: 'claude', model: r.servedBy || TEACHER_MODEL, durationMs: r.durationMs, usage: r.usage, sources: r.sources };
  }
  if (mode === 'cli') {
    const r = await researchViaCli({ system, user, log, maxSearches, cancelled });
    return { content: r.text, via: 'claude', model: r.servedBy || (CLI_MODEL ? `claude-code:${CLI_MODEL}` : 'claude-code'), durationMs: r.durationMs, usage: r.usage, sources: r.sources };
  }
  return null;
}
