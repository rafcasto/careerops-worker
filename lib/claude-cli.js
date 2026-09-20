// Claude Code CLI as the Researcher's brain — no API key, your Claude subscription.
//
//   curl -fsSL https://claude.ai/install.sh | bash     # once, on the Pi
//   claude login                                        # once, as the user the service runs as
//
// The worker shells out to `claude -p` (headless mode) with only WebSearch/WebFetch
// allowed, JSON output, a turn cap and a timeout. Nothing on the Pi filesystem is
// exposed to it (cwd = an empty scratch dir; no file tools allowed).
import { execFile } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const home = process.env.HOME || os.homedir();
const CANDIDATES = [process.env.CLAUDE_CLI_BIN, join(home, '.local', 'bin', 'claude'), '/usr/local/bin/claude', join(home, '.nvm', 'versions', 'node', process.version, 'bin', 'claude')].filter(Boolean);
export const CLI_MODEL = process.env.CLAUDE_CLI_MODEL || '';   // empty = the CLI's default
const SCRATCH = join(home, '.cache', 'careerops-claude-cli');
let binCache;

export async function claudeCliBin() {
  if (binCache !== undefined) return binCache;
  for (const p of CANDIDATES) { try { await access(p, constants.X_OK); binCache = p; return p; } catch {} }
  binCache = null; return null;
}
// Installed AND logged in (credentials file written by `claude login`).
export async function claudeCliAvailable() {
  if (!(await claudeCliBin())) return false;
  if (process.env.CLAUDE_CLI_FORCE === '1') return true;
  try { const c = JSON.parse(await readFile(join(home, '.claude', '.credentials.json'), 'utf8')); return !!(c.claudeAiOauth?.accessToken || c.claudeAiOauth?.refreshToken); } catch { return false; }
}
export const claudeCliReset = () => { binCache = undefined; };

// One headless research turn. Returns { text, sources, usage, servedBy, durationMs }
// shaped like lib/claude.js research() so jobs don't care which path answered.
export async function researchViaCli({ system, user, maxSearches = 6, maxTurns = 14, timeoutMs = 15 * 60 * 1000, log, cancelled }) {
  const bin = await claudeCliBin();
  if (!bin) throw new Error('Claude Code CLI not found on the Pi (set CLAUDE_CLI_BIN or install it)');
  await mkdir(SCRATCH, { recursive: true });
  const t0 = Date.now();
  const sys = `${system}\n\nTOOLS: you may use WebSearch (at most ${maxSearches} searches) and WebFetch. Do not use any other tool. Finish with a section "## Sources" listing every URL you actually read, one per line as a Markdown link.`;
  const args = ['-p', '--output-format', 'json', '--allowedTools', 'WebSearch,WebFetch', '--max-turns', String(maxTurns), '--append-system-prompt', sys, ...(CLI_MODEL ? ['--model', CLI_MODEL] : [])];
  const { stdout, stderr, code } = await new Promise((resolve) => {
    const child = execFile(bin, args, { cwd: SCRATCH, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } },
      (err, stdout, stderr) => resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: err ? (err.code ?? 1) : 0 }));
    child.stdin.end(user);
    if (cancelled) { const t = setInterval(async () => { if (await cancelled()) { clearInterval(t); child.kill('SIGTERM'); } }, 5000); child.on('exit', () => clearInterval(t)); }
  });
  let j = null;
  try { j = JSON.parse(stdout); } catch { const m = stdout.match(/\{[\s\S]*\}\s*$/); if (m) { try { j = JSON.parse(m[0]); } catch {} } }
  if (!j || j.is_error || typeof j.result !== 'string' || !j.result.trim()) {
    const tail = (stderr || stdout).trim().split('\n').slice(-6).join('\n');
    throw new Error(`claude -p failed (exit ${code}${j?.subtype ? `, ${j.subtype}` : ''}): ${tail || 'no output'}`);
  }
  const text = j.result.trim();
  const sources = [];
  for (const m of text.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)) if (!sources.some((s) => s.url === m[2])) sources.push({ title: m[1], url: m[2] });
  const usage = { input: j.usage?.input_tokens ?? null, output: j.usage?.output_tokens ?? null, turns: j.num_turns ?? null, costUsd: j.total_cost_usd ?? null };
  if (log) await log(`claude cli${j.model ? ` ${j.model}` : ''}: ${usage.turns ?? '?'} turns, ${sources.length} sources in ${Math.round((Date.now() - t0) / 1000)}s`);
  return { text, sources, usage, servedBy: j.model ? `claude-code:${j.model}` : 'claude-code', durationMs: Date.now() - t0 };
}

// A plain (no-tools) headless turn — the teacher path for generate_gold when there is
// no API key. Same return shape as lib/claude.js teach().
export async function teachViaCli({ system, user, timeoutMs = 20 * 60 * 1000, log }) {
  const bin = await claudeCliBin();
  if (!bin) throw new Error('Claude Code CLI not found on the Pi');
  await mkdir(SCRATCH, { recursive: true });
  const t0 = Date.now();
  const sys = Array.isArray(system) ? system.map((b) => b.text ?? '').join('\n') : String(system ?? '');
  const args = ['-p', '--output-format', 'json', '--allowedTools', '', '--max-turns', '1', '--append-system-prompt', sys, ...(CLI_MODEL ? ['--model', CLI_MODEL] : [])];
  const { stdout, stderr, code } = await new Promise((resolve) => {
    const child = execFile(bin, args, { cwd: SCRATCH, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } },
      (err, stdout, stderr) => resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: err ? (err.code ?? 1) : 0 }));
    child.stdin.end(user);
  });
  let j = null; try { j = JSON.parse(stdout); } catch {}
  if (!j || j.is_error || typeof j.result !== 'string' || !j.result.trim()) throw new Error(`claude -p failed (exit ${code}${j?.subtype ? `, ${j.subtype}` : ''}): ${(stderr || stdout).trim().split('\n').slice(-4).join('\n') || 'no output'}`);
  const usage = { input: j.usage?.input_tokens ?? 0, output: j.usage?.output_tokens ?? 0, cacheRead: j.usage?.cache_read_input_tokens ?? 0, cacheWrite: j.usage?.cache_creation_input_tokens ?? 0 };
  if (log) await log(`claude cli${j.model ? ` ${j.model}` : ''}: ${usage.output} tokens out in ${Math.round((Date.now() - t0) / 1000)}s`);
  return { text: j.result.trim(), usage, servedBy: j.model ? `claude-code:${j.model}` : 'claude-code', stopReason: j.subtype === 'success' ? 'end_turn' : j.subtype, durationMs: Date.now() - t0 };
}
