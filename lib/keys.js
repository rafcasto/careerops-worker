// Mirror of jhg-compass/lib/careerops/keys.ts — change both together.
export const KEYS = {
  queue: 'careerops:queue',
  jobs: 'careerops:jobs',
  job: (id) => `careerops:job:${id}`,
  userJobs: (uid) => `careerops:user:${uid}:jobs`,
  quota: (uid, day) => `careerops:quota:${uid}:${day}`,
  worker: 'careerops:worker',
  state: 'careerops:state',
  rpc: 'careerops:rpc',
  rpcReply: (id) => `careerops:rpc:${id}`,
};
export const MEMBER_JOB_TYPES = ['evaluate', 'scan', 'pdf', 'cover', 'sync_setup'];
export const ADMIN_JOB_TYPES = ['import_model', 'build_dataset', 'generate_gold', 'finetune', 'exam', 'promote'];
export const AGENT_KEYS = ['scout', 'extractor', 'evaluator', 'tailor', 'writer'];
export const HEARTBEAT_TTL_S = 120;
export const LOG_TAIL_BYTES = 12_000;
