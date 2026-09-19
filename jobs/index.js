// One module per job type. Each exports async run(ctx) where ctx = { job, log, progress, cancelled, env, ... }.
const notYet = (type) => async ({ log }) => { log(`${type}: not implemented yet (see docs/CAREER_OPS_AGENTS.md phases)`); throw new Error(`${type} is not available yet`); };

import { run as evaluate } from './evaluate.js';
import { run as syncSetup } from './sync_setup.js';
import { run as pdf } from './pdf.js';
import { run as cover } from './cover.js';
import { run as scan } from './scan.js';

export const HANDLERS = {
  evaluate,
  scan,
  pdf,
  cover,
  sync_setup: syncSetup,
  import_model: notYet('import_model'),
  build_dataset: notYet('build_dataset'),
  generate_gold: notYet('generate_gold'),
  finetune: notYet('finetune'),
  exam: notYet('exam'),
  promote: notYet('promote'),
};
