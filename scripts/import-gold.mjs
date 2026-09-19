// Import hand-written gold cases (training/gold/<set>/<NN-slug>/) into trainingExamples.
// Each case dir: meta.json { company, role, market, intendedFit, notes, split, teacherModel }, jd.md, cv.md, profile.yml, report.md
// Usage: node scripts/import-gold.mjs training/gold/pilot
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from 'dotenv'; config();
import { saveExample, exampleId } from '../lib/training.js';
import { parseScoreSummary } from '../lib/prompts.js';

const dir = process.argv[2] || 'training/gold/pilot';
let n = 0;
for (const name of (await readdir(dir)).sort()) {
  const d = join(dir, name);
  let meta; try { meta = JSON.parse(await readFile(join(d, 'meta.json'), 'utf8')); } catch { continue; }
  const [jd, cv, profileYaml, report] = await Promise.all(['jd.md', 'cv.md', 'profile.yml', 'report.md'].map((f) => readFile(join(d, f), 'utf8')));
  const s = parseScoreSummary(report);
  if (!s.found || s.score == null) { console.error(`${name}: report has no SCORE_SUMMARY — skipped`); continue; }
  const id = exampleId(jd, cv);
  await saveExample({
    id, agent: 'evaluator', source: 'claude', split: meta.split === 'exam' ? 'exam' : 'train', approved: true,
    company: meta.company, role: meta.role, market: meta.market ?? 'New Zealand', intendedFit: meta.intendedFit, notes: meta.notes ?? '',
    cv: cv.trim(), profileYaml: profileYaml.trim(), jd: jd.trim(), report: report.trim(),
    summary: { company: s.company, role: s.role, score: s.score, archetype: s.archetype, legitimacy: s.legitimacy },
    teacherModel: meta.teacherModel ?? 'claude-fable-5-1', studentPromptVersion: 2, createdBy: 'import-gold', jobId: `gold:${name}`,
  });
  console.log(`${name}: ${meta.company} — ${meta.role} · ${meta.intendedFit} → ${s.score} · ${meta.split ?? 'train'}`);
  n++;
}
console.log(`imported ${n}`);
process.exit(0);
