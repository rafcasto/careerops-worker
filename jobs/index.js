// One module per job type. Each exports async run(ctx) where ctx = { job, log, progress, cancelled, env, ... }.
// Phase 0 ships only the contract; phase 1 adds evaluate + sync_setup.
const notYet = (type) => async ({ log }) => { log(`${type}: not implemented yet (see docs/CAREER_OPS_AGENTS.md phases)`); throw new Error(`${type} is not available yet`); };

export const HANDLERS = {
  evaluate: notYet('evaluate'),
  scan: notYet('scan'),
  pdf: notYet('pdf'),
  cover: notYet('cover'),
  sync_setup: notYet('sync_setup'),
  import_model: notYet('import_model'),
  build_dataset: notYet('build_dataset'),
  generate_gold: notYet('generate_gold'),
  finetune: notYet('finetune'),
  exam: notYet('exam'),
  promote: notYet('promote'),
};
