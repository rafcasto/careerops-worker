// HTML → PDF through career-ops' own renderer (fonts inlined, page budget,
// ATS-safe print CSS) driving the Pi's system Chromium — no Playwright
// browser download needed. The career-ops scripts are imported from the
// shared checkout so this stays in step with upstream templates.
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';

async function careerOps(env, file) { return import(pathToFileURL(join(env.repo, file)).href); }

export async function renderPdf(env, html, outputPath, { format = 'a4', maxPages, workspaceRoot } = {}) {
  const { renderHtmlToPdf } = await careerOps(env, 'generate-pdf.mjs');
  const { chromium } = await import(pathToFileURL(join(env.repo, 'node_modules', 'playwright', 'index.mjs')).href).catch(() => import('playwright'));
  await mkdir(dirname(outputPath), { recursive: true });
  return renderHtmlToPdf(html, outputPath, {
    format, baseDir: env.repo, maxPages, strictPages: false, workspaceRoot,
    launchBrowser: (o) => chromium.launch({ ...o, executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] }),
  });
}

// build-cv-html.mjs runs main() on import, so it is invoked as a CLI.
export function buildCvHtml(env, root, payloadPath, outHtml, templateName) {
  const args = [join(env.repo, 'build-cv-html.mjs'), payloadPath, outHtml];
  if (templateName) args.push(join(env.repo, 'templates', templateName));
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { cwd: env.repo, timeout: 120000, env: { ...process.env, CAREER_OPS_ROOT: root } }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`build-cv-html failed: ${(stderr || stdout || err.message).trim().split('\n').slice(-6).join(' · ')}`));
      resolve((stdout || '').trim());
    });
  });
}

export async function buildCoverHtml(env, payload) {
  const { buildHtml } = await careerOps(env, 'generate-cover-letter.mjs');
  return buildHtml(payload, join(env.repo, 'templates', 'cover-letter-template.html'));
}

export async function writeJson(path, obj) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(obj, null, 2), 'utf8'); }
