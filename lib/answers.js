// Answer bank — what the member has already said on other forms, so the second application
// reuses their words instead of re-drafting them. users/{uid}/careerOpsAnswers/{id}:
//   { question, key, answer, source: "you" | "standard" | "drafted", standardKey?, company?, reportJobId?, usedAt[], updatedAt }
// Matching is deliberately dumb and transparent: same normalised question first, then the
// "standard answer" family a question belongs to (salary, right to work, notice period …),
// then a fact straight from profile.yml (LinkedIn, phone). No model, no tokens.
import { createHash } from 'node:crypto';

export function normalizeQuestion(q) {
  return String(q ?? '').toLowerCase()
    .replace(/^\s*(\d+[.)]|[-*•])\s*/, '')                // "3. " / "- "
    .replace(/\s*(\*|\(required\)|\(optional\)|required|optional)\s*$/i, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
export const questionId = (q) => 'q_' + createHash('sha1').update(normalizeQuestion(q)).digest('hex').slice(0, 20);

// Mirrored in jhg-compass lib/careerops/answers.ts — keep the keys and order in step.
export const STANDARD_ANSWERS = [
  { key: 'right_to_work',    label: 'Right to work',        match: /(right|entitled|eligib|authori[sz]ed|legally|permitted).{0,40}\bwork|work (visa|rights|authori[sz]ation|permit|eligib)|citizen|resident|residency/i },
  { key: 'sponsorship',      label: 'Visa sponsorship',     match: /sponsor/i },
  { key: 'salary',           label: 'Salary expectation',   match: /salary|remuneration|pay (expectation|rate)|compensation expectation|expected (pay|rate|package)|hourly rate/i },
  { key: 'notice_period',    label: 'Notice period',        match: /notice period/i },
  { key: 'start_date',       label: 'Earliest start date',  match: /start date|when (can|could|would|are you able to) (you )?(start|commence)|earliest (start|available)|availab(le|ility) to start/i },
  { key: 'location',         label: 'Where you are based',  match: /(where|which) (city|country|location|are you (based|located|living))|current (location|city)|based in|where do you (live|reside)|preferred location/i },
  { key: 'work_arrangement', label: 'Remote / hybrid / on-site preference', match: /\b(remote|hybrid|on-?site|work from home|office days|in the office)\b/i },
  { key: 'relocation',       label: 'Willing to relocate',  match: /relocat/i },
  { key: 'drivers_licence',  label: "Driver's licence",     match: /driver'?s? licen[cs]e|full licen[cs]e/i },
  { key: 'background_check', label: 'Background / police check', match: /criminal|conviction|police (check|vetting)|background check|credit check/i },
  { key: 'how_heard',        label: 'How you heard about the role', match: /how did you (hear|find out|learn)|where did you (hear|see|find)|source of application|referr(ed|al)/i },
  { key: 'title',            label: 'Title (Mr / Ms / Mx …)',   match: /^title:?$/i },
  { key: 'phone',            label: 'Mobile phone',          match: /\b(mobile|phone|telephone|contact number)\b/i },
  { key: 'street_address',   label: 'Street address',        match: /street address|address line|^address:?$|home address/i },
  { key: 'postcode',         label: 'Postcode',              match: /post(al)? ?code|\bzip\b/i },
];
export function standardKeyFor(question) {
  const q = String(question ?? '');
  for (const s of STANDARD_ANSWERS) if (s.match.test(q)) return s.key;
  return null;
}

// Facts profile.yml already holds — never worth a model call or a question to the member.
const PROFILE_FACTS = [
  { key: 'linkedin', match: /linkedin/i }, { key: 'github', match: /github/i }, { key: 'portfolio', match: /portfolio|personal (website|site)/i },
  { key: 'phone', match: /\b(phone|mobile|contact number)\b/i }, { key: 'email', match: /\be-?mail\b/i }, { key: 'name', match: /^(full |your )?name$/i },
];

// bank: [{ id, question, key, answer, source, standardKey?, company?, updatedAt? }]
// → per question { question, standardKey, hit: { id?, answer, source, company?, at?, standardKey? } | null }
export function matchAnswers(questions, bank, profile = {}) {
  const byKey = new Map(), byStandard = new Map();
  for (const a of bank ?? []) {
    if (!a?.answer) continue;
    const k = a.key || normalizeQuestion(a.question);
    if (k && (!byKey.has(k) || (a.updatedAt ?? 0) > (byKey.get(k).updatedAt ?? 0))) byKey.set(k, a);
    if (a.standardKey && (!byStandard.has(a.standardKey) || a.source === 'standard' || (a.updatedAt ?? 0) > (byStandard.get(a.standardKey).updatedAt ?? 0))) byStandard.set(a.standardKey, a);
  }
  return questions.map((question) => {
    const key = normalizeQuestion(question);
    const standardKey = standardKeyFor(question);
    const exact = byKey.get(key);
    if (exact) return { question, standardKey, hit: { id: exact.id, answer: exact.answer, source: exact.source ?? 'you', company: exact.company ?? null, at: exact.updatedAt ?? null } };
    const std = standardKey ? byStandard.get(standardKey) : null;
    if (std) return { question, standardKey, hit: { id: std.id, answer: std.answer, source: 'standard', standardKey, company: std.company ?? null, at: std.updatedAt ?? null } };
    const fact = PROFILE_FACTS.find((f) => f.match.test(question));
    if (fact && profile[fact.key]) return { question, standardKey, hit: { answer: String(profile[fact.key]), source: 'profile' } };
    return { question, standardKey, hit: null };
  });
}
