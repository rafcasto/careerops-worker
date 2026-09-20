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
import { run as deep } from './deep.js';
import { run as advise } from './advise.js';
import { run as contacto } from './contacto.js';
import { run as apply } from './apply.js';
import { run as applyForm } from './apply_form.js';
import { run as applyFill } from './apply_fill.js';
import { run as interviewPrep } from './interview_prep.js';
import { run as followup } from './followup.js';
import { run as patterns } from './patterns.js';

export const HANDLERS = {
  evaluate,
  scan,
  pdf,
  cover,
  sync_setup: syncSetup,
  // CareerOps portal tasks
  deep,
  advise,
  contacto,
  apply,
  apply_form: applyForm,
  apply_fill: applyFill,
  interview_prep: interviewPrep,
  followup,
  patterns,
  import_model: importModel,
  build_dataset: buildDataset,
  generate_gold: generateGold,
  finetune,
  exam,
  promote,
};
