// One module per job type. Each exports async run(ctx) where ctx = { job, log, progress, cancelled, env, ... }.

import { run as evaluate } from './evaluate.js';
import { run as syncSetup } from './sync_setup.js';
import { run as pdf } from './pdf.js';
import { run as cover } from './cover.js';
import { run as scan } from './scan.js';
import { run as generateGold } from './generate_gold.js';
import { run as buildDataset } from './build_dataset.js';
import { run as exam } from './exam.js';
import { run as finetune } from './finetune.js';
import { run as importModel } from './import_model.js';
import { run as promote } from './promote.js';

export const HANDLERS = {
  evaluate,
  scan,
  pdf,
  cover,
  sync_setup: syncSetup,
  import_model: importModel,
  build_dataset: buildDataset,
  generate_gold: generateGold,
  finetune,
  exam,
  promote,
};
