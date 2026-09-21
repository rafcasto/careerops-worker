// Signed-in form reading: log in to the portal with the member's vault credentials and walk the
// application wizard page by page, reading every field. The walker may press ONLY buttons whose
// text is on NEXT_BUTTONS (Continue / Next / Save and Continue). It fills required fields it has a
// fact for (profile, standard answers, the tailored CV file) so the portal lets it move on — that is
// a saved draft in the member's own candidate account, never a submission. Anything that looks
// like a Submit / Apply / Send button is never touched; the walk stops on the Review page.
import { existsSync } from 'node:fs';
import { collectFieldsInPage, classifyFields } from './form-read.js';
import { normalizeQuestion } from './answers.js';

export const NEXT_BUTTONS = /^\s*(save and continue|save & continue|save and next|continue|next|next step|proceed)\s*$/i;
export const FORBIDDEN_BUTTONS = /submit|send|apply|finish|complete|confirm/i;
export const nextButtonAllowed = (text) => NEXT_BUTTONS.test(String(text ?? '')) && !FORBIDDEN_BUTTONS.test(String(text ?? ''));

export function portalFor(url) {
  const h = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (/myworkdayjobs\.com$/i.test(h)) return 'workday';
  if (/successfactors\.(eu|com)$|jobs2web/i.test(h)) return 'successfactors';
  if (/\.csod\.com$/i.test(h)) return 'csod';
  return 'generic';
}

// Which fact fills a field with this label. facts: { firstName, lastName, name, email, phone, linkedin, city, country, address, ... , standard: { right_to_work: '…' } }
const FACT_RULES = [
  [/^(legal |preferred )?(first|given) ?name:?$/i, 'firstName'], [/^(legal )?(last|family|sur) ?name:?$/i, 'lastName'], [/^(full |your )?name:?$/i, 'name'], [/^preferred name:?$/i, 'firstName'],
  [/^(region|state|region \/ state|province)$/i, 'region'],
  [/\be-?mail\b/i, 'email'], [/\b(phone|mobile|telephone)\b/i, 'phone'], [/linkedin/i, 'linkedin'], [/github/i, 'github'], [/portfolio|website/i, 'portfolio'],
  [/^(city|town|suburb)$/i, 'city'], [/^country/i, 'country'], [/^(address|street|address line 1)/i, 'address'], [/post ?code|zip/i, 'postcode'],
];
export function factFor(label, facts = {}) {
  for (const [re, key] of FACT_RULES) if (re.test(label) && facts[key]) return String(facts[key]);
  const std = facts.standard ?? {};
  const s = STANDARD_MATCH.find(([re]) => re.test(label)); if (s && std[s[1]]) return String(std[s[1]]);
  return null;
}
// The model marks what the CV lacks as "[Add: …]" — a placeholder, never something to type into a form.
export const isPlaceholder = (v) => /^\s*\[?\s*add\s*:/i.test(String(v ?? '')) || /\[add:/i.test(String(v ?? ''));
// "…real sentence. [Add: your postcode]" → "…real sentence."; a bare placeholder → null.
export function cleanAnswer(v) {
  const raw = String(v ?? '').trim(); if (!raw) return null;
  const stripped = raw.replace(/\[(add|confirm|note|todo)\s*:[^\]]*\]?/gi, '').replace(/\s{2,}/g, ' ').replace(/\s+([.,;])/g, '$1').trim();
  if (stripped === raw) return raw;
  return stripped.length >= 20 && /[a-z]/i.test(stripped) ? stripped : null;
}
const STANDARD_MATCH = [
  [/how did you (hear|find|learn)|source/i, 'how_heard'], [/(entitled|eligib|authori[sz]ed|legally|right).{0,40}work|work (visa|rights|authori)/i, 'right_to_work'],
  [/sponsor/i, 'sponsorship'], [/salary|remuneration|compensation/i, 'salary'], [/notice period/i, 'notice_period'], [/start date|earliest|availab/i, 'start_date'], [/relocat/i, 'relocation'],
  [/^title:?$/i, 'title'], [/\b(mobile|phone|telephone|contact number)\b/i, 'phone'], [/street address|address line|^address:?$|home address/i, 'street_address'], [/post(al)? ?code|\bzip\b/i, 'postcode'],
];
// When a dropdown has no matching option, the family tells us a sensible pick (how-heard → the careers site).
const OPTION_FALLBACKS = [[/how did you (hear|find)|where did you (hear|see)|source/i, /careers? (site|page|website)|company website|website|company/i]];
// For a select: the option whose text best matches the fact (exact, then startsWith, then yes/no).
export function pickOption(options, fact) {
  if (!fact || !options?.length) return null;
  const f = String(fact).toLowerCase().trim(); const norm = (o) => String(o).toLowerCase().trim();
  const real = options.filter((o) => !/^(please )?select|^choose|^--|^$/i.test(norm(o)));
  const exact = real.find((o) => norm(o) === f) ?? real.find((o) => norm(o).startsWith(f) || f.startsWith(norm(o)));
  if (exact) return exact;
  // Affirmative / negative phrasing → the Yes/No-style option ("I agree", "I do not hold …" → No).
  const yes = real.find((o) => /^(yes|i agree|agree|i accept|accept|i confirm|confirm|i declare|true)\b/i.test(o));
  const no = real.find((o) => /^(no|i do not|i don't|disagree|false)\b/i.test(o));
  if (/^(yes|y|true|i agree|agreed|i accept|i confirm|i declare|correct)\b/.test(f) && yes) return yes;
  if (/^(no|n|false|none|not |never|i do not|i don't|i have not|i haven't|i am not|i'm not|nil|n\/a)\b/.test(f) && no) return no;
  // A number in the answer → the range option that contains it ("6 years" → "5+ years" / "3-7 years").
  const num = Number((f.match(/(\d+(?:\.\d+)?)/) || [])[1]);
  if (Number.isFinite(num)) {
    const inRange = real.find((o) => { const m = norm(o).match(/(\d+(?:\.\d+)?)\s*(?:[-–to]+\s*(\d+(?:\.\d+)?)|\+|or more|and above)/); if (!m) return false; const lo = parseFloat(m[1]); const hi = m[2] != null ? parseFloat(m[2]) : Infinity; return num >= lo && num <= hi; });
    if (inRange) return inRange;
    const lessThan = real.find((o) => { const m = norm(o).match(/(less than|under|fewer than|<)\s*(\d+)/); return m && num < parseFloat(m[2]); });
    if (lessThan) return lessThan;
  }
  // Keyword overlap: the option sharing the most distinctive words with the answer (≥ 1 word of 5+ letters).
  const words = new Set(f.split(/[^a-z0-9]+/).filter((w) => w.length >= 5));
  let best = null, bestN = 0;
  for (const o of real) { const n = norm(o).split(/[^a-z0-9]+/).filter((w) => words.has(w)).length; if (n > bestN) { best = o; bestN = n; } }
  return bestN >= 1 ? best : null;
}

// react-select / autosuggest style dropdowns: open, read the visible options, click the best match;
// otherwise type the value to filter and try again; a free-text autosuggest keeps what was typed.
async function pickCombobox(page, loc, f, fact) {
  const fallback = OPTION_FALLBACKS.find(([re]) => re.test(f.label))?.[1] ?? null;
  const OPT = '[role="option"]:visible, [class*="__option"]:visible, [id*="-option-"]:visible';
  const visibleOptions = async () => page.locator(OPT).evaluateAll((els) => els.map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 200));
  const choose = async (opts) => { const o = pickOption(opts, fact) ?? (fallback ? opts.find((x) => fallback.test(x)) : null); if (!o) return null; await page.locator(OPT).filter({ hasText: new RegExp(`^\\s*${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }).first().click({ timeout: 5000 }); return o; };
  const control = loc.locator('xpath=ancestor::*[contains(@class,"control") or contains(@class,"container")][1]');
  const typeable = await loc.evaluate((el) => !el.readOnly && el.getAttribute('aria-readonly') !== 'true' && el.getAttribute('inputmode') !== 'none').catch(() => true);
  try {
    if (await control.count()) await control.first().click({ timeout: 5000 }); else await loc.click({ timeout: 5000 });
    await page.waitForTimeout(600);
    let opts = await visibleOptions();
    if (!opts.length) { await loc.press('ArrowDown', { timeout: 3000 }).catch(() => {}); await page.waitForTimeout(500); opts = await visibleOptions(); }
    let picked = opts.length ? await choose(opts) : null;
    if (!picked && fact && typeable) { await loc.fill('', { timeout: 5000 }).catch(() => {}); await loc.type(String(fact).slice(0, 60), { delay: 25, timeout: 8000 }).catch(() => {}); await page.waitForTimeout(700); opts = await visibleOptions(); picked = opts.length ? await choose(opts) : null; }
    if (!picked && fact && !opts.length && !typeable) { await page.keyboard.press('Escape').catch(() => {}); return null; }
    if (!picked && fact && !opts.length) { await page.keyboard.press('Escape').catch(() => {}); return String(fact); }   // free-text autosuggest: the typed value stands
    if (!picked) { await page.keyboard.press('Escape').catch(() => {}); return null; }
    return picked;
  } catch { await page.keyboard.press('Escape').catch(() => {}); return null; }
}

// "$150–170k" → 150000 · "85,000" → 85000 · prose without a number → null.
export function numberFrom(v) {
  const s = String(v ?? '').replace(/,/g, '');
  const k = s.match(/(\d+(?:\.\d+)?)(?:\s*[–-]\s*\d+(?:\.\d+)?)?\s*k\b/i);   // "150–170k" → the low end, in thousands
  if (k) return Math.round(parseFloat(k[1]) * 1000);
  const m = s.match(/\d+(?:\.\d+)?/);
  return m ? Math.round(parseFloat(m[0])) : null;
}

async function settle(page, ms = 2500) { await page.waitForLoadState('domcontentloaded').catch(() => {}); await page.waitForTimeout(ms); }
async function clickText(page, re, { role = 'button', timeout = 8000 } = {}) {
  const loc = page.getByRole(role, { name: re }).first();
  if (!(await loc.count())) return false;
  await loc.click({ timeout }); await settle(page); return true;
}

// Get from the posting page to the sign-in form, then sign in. Returns when the wizard (or the
// candidate home) is on screen. Throws with a readable reason otherwise.
export async function signIn(page, portal, { email, password, log }) {
  const hasPassword = async () => (await page.locator('input[type="password"]:visible').count()) > 0;
  if (!(await hasPassword())) {
    // Posting page → Apply → (Workday) Apply Manually → sign-in form.
    if (await clickText(page, /^apply$|^apply now$|apply for this job/i) || await clickText(page, /^apply$|^apply now$|apply for this job/i, { role: 'link' })) await log?.(`clicked Apply on the posting`);
    if (portal === 'workday') { if (await clickText(page, /apply manually/i)) await log?.('Workday: chose "Apply Manually"'); }
    if (!(await hasPassword())) { await clickText(page, /sign in|log ?in|already have an account/i, { role: 'button' }).catch(() => false) || await clickText(page, /sign in|log ?in|already have an account/i, { role: 'link' }).catch(() => false); }
  }
  if (!(await hasPassword())) throw new Error('could not reach the sign-in form from the posting — open the posting, sign in once yourself, and try again');
  const pw = page.locator('input[type="password"]:visible').first();
  const emailBox = page.locator('input[type="email"]:visible, input[name*="email" i]:visible, input[id*="email" i]:visible, input[type="text"]:visible').first();
  await emailBox.fill(email); await pw.fill(password);
  await log?.(`signing in as ${email}`);
  const before = page.url();
  if (!(await clickText(page, /^sign in$|^log ?in$|^continue$|^next$/i))) await pw.press('Enter');
  await settle(page, 4000);
  const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 6000);
  if (await hasPassword() && /invalid|incorrect|not (found|recogni[sz]ed)|does ?n.t match|try again|verify your (email|account)/i.test(text)) throw new Error(`the portal rejected the sign-in: ${(text.match(/[^\n]*(invalid|incorrect|not (found|recogni[sz]ed)|does ?n.t match|verify your (email|account))[^\n]*/i) ?? [''])[0].trim().slice(0, 160)}`);
  if (await hasPassword() && page.url() === before) throw new Error('the portal did not accept the sign-in (still on the login page) — check the email and password in your portal accounts');
  if (/verification code|one-time code|two-factor|2fa|authenticat(or|ion) app/i.test(text)) throw new Error('the portal asks for a verification code — sign in once yourself on this device, then try again');
  await log?.('signed in');
}

// The drafted answer for a form label: same normalised text, else one contains the other.
export function answerFor(label, answers = []) {
  const l = normalizeQuestion(label); if (!l) return null;
  const usable = answers.map((a) => ({ question: a?.question, answer: cleanAnswer(a?.answer) })).filter((a) => a.question && a.answer);
  const exact = usable.find((a) => normalizeQuestion(a.question) === l); if (exact) return exact.answer;
  const loose = usable.find((a) => { const q = normalizeQuestion(a.question); return q.length > 12 && (l.includes(q) || q.includes(l)); });
  return loose?.answer || null;
}

// Walk the wizard. mode 'reach': fill only required empty fields it has a fact for (enough to move on).
// mode 'fill': also type the drafted answers and facts into every empty field — the application as a
// saved draft in the member's account, up to the Review page. Never presses Submit either way.
// Returns { pages: [{ title, url, questions, identity, files, filled, skipped }], questions, stoppedAt, finalUrl }.
export async function walkWizard(page, { facts = {}, cvPath = null, answers = [], mode = 'reach', log, maxPages = 8 } = {}) {
  const pages = []; const seenQ = new Map(); const seenUrls = new Set();
  let stoppedAt = 'end';
  for (let n = 0; n < maxPages; n++) {
    const collected = await page.evaluate(collectFieldsInPage);
    const c = classifyFields(collected, page.url());
    const filled = [], skipped = [];
    // Fill what we can, only when required and empty — and never anything we lack a fact for.
    for (const f of collected.fields) {
      const wanted = mode === 'fill' ? (!f.value && !f.selected && !(f.checked?.length)) : (f.required && !f.value && !f.selected);
      if (!wanted) continue;
      const answer = mode === 'fill' ? answerFor(f.label, answers) : null;
      if ((f.type === 'radio' || f.type === 'checkbox') && f.optionIdx?.length) {
        const want = answer ?? factFor(f.label, facts);
        const picks = f.type === 'checkbox' && want ? String(want).split(/\s*[,;/]\s*/).map((w) => pickOption(f.options, w)).filter(Boolean) : [pickOption(f.options, want)].filter(Boolean);
        if (!picks.length) { if (f.required || mode === 'fill') skipped.push(f.label); continue; }
        try { for (const p of picks) await page.locator(`[data-co-idx="${f.optionIdx[f.options.indexOf(p)]}"]`).check({ timeout: 5000, force: true }); filled.push(`${f.label} ← ${picks.join(', ')}`); }
        catch (e) { skipped.push(`${f.label} (${e.message.split('\n')[0].slice(0, 60)})`); }
        continue;
      }
      if (f.idx == null) continue;
      const loc = page.locator(`[data-co-idx="${f.idx}"]`);
      try {
        if (f.type === 'file') {
          const onResumePage = /resume|\bcv\b|curriculum/i.test(collected.title ?? '') && collected.fields.filter((x) => x.type === 'file').length === 1;
          const wantsCv = /resume|\bcv\b|curriculum/i.test(f.label + ' ' + f.name) || onResumePage;
          if (wantsCv && cvPath && existsSync(cvPath)) { await loc.setInputFiles(cvPath, { timeout: 8000 }); await page.waitForTimeout(1500); filled.push(`${f.label} ← tailored CV`); } else skipped.push(f.label + (wantsCv && !cvPath ? ' (no tailored CV yet)' : ''));
          continue;
        }
        const fact = answer ?? factFor(f.label, facts);
        if (f.type === 'switch') { if (f.required) { await loc.check({ timeout: 5000, force: true }); filled.push(`${f.label} ← on`); } continue; }
        if (f.combobox) {
          const picked = await pickCombobox(page, loc, f, fact);
          if (picked) filled.push(`${f.label} ← ${picked}`); else if (f.required || mode === 'fill') skipped.push(f.label);
          continue;
        }
        if (f.type === 'select') { const opt = pickOption(f.options ?? [], fact); if (opt) { await loc.selectOption({ label: opt }, { timeout: 8000 }); filled.push(`${f.label} ← ${opt}`); } else skipped.push(f.label); continue; }
        if (f.type === 'number') { const n = numberFrom(fact); if (n != null) { await loc.fill(String(n), { timeout: 8000 }); filled.push(`${f.label} ← ${n}`); } else skipped.push(f.label); continue; }
        if (['text', 'textarea', 'email', 'tel', 'url', 'date'].includes(f.type)) { if (fact) { const v = f.maxLength ? String(fact).slice(0, f.maxLength) : String(fact); await loc.fill(v, { timeout: 8000 }); filled.push(`${f.label} ← ${v.slice(0, 40)}${v.length > 40 ? '…' : ''}`); } else skipped.push(f.label); continue; }
        skipped.push(f.label);
      } catch (e) { skipped.push(`${f.label} (${e.message.split('\n')[0].slice(0, 60)})`); }
    }
    for (const q of c.questions) if (!seenQ.has(q.label.toLowerCase())) seenQ.set(q.label.toLowerCase(), q);
    pages.push({ title: (collected.title || '').slice(0, 120), url: page.url(), questions: c.questions.length, identity: c.identity.length, files: c.files.length, filled, skipped });
    await log?.(`page ${n + 1} "${(collected.title || '').slice(0, 60)}": ${c.questions.length} question(s), filled ${filled.length}, could not fill ${skipped.length}`);
    // Review / submit page → stop. Never press anything here.
    const bodyText = (collected.text ?? '');
    const submitVisible = await page.getByRole('button', { name: /^submit$|submit application|send application/i }).count();
    if (submitVisible || /^review\b|review (your )?application/im.test(bodyText.slice(0, 600))) { stoppedAt = 'review'; await log?.('reached the review page — stopping (the worker never submits)'); break; }
    // Advance with an allowlisted button only.
    const buttons = await page.locator('button:visible, input[type="submit"]:visible, a[role="button"]:visible').evaluateAll((els) => els.map((e) => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim()));
    const nextText = buttons.find(nextButtonAllowed);
    if (!nextText) { stoppedAt = 'no-next-button'; break; }
    const urlBefore = page.url(); const sig = JSON.stringify(collected.fields.map((f) => f.label));
    await page.getByRole('button', { name: new RegExp(`^\\s*${nextText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') }).first().click({ timeout: 8000 }).catch(async () => page.locator(`input[type="submit"][value="${nextText}"]`).first().click({ timeout: 8000 }));
    await settle(page, 3500);
    const after = await page.evaluate(collectFieldsInPage);
    const errText = (after.text ?? '').match(/[^\n]*(is required|required field|please (complete|fill|select)|must be (completed|provided)|errors? (found|on this page))[^\n]*/i)?.[0];
    if (page.url() === urlBefore && JSON.stringify(after.fields.map((f) => f.label)) === sig) { stoppedAt = errText ? `blocked: ${errText.trim().slice(0, 140)}` : 'blocked: the page did not advance'; await log?.(stoppedAt); break; }
    if (seenUrls.has(page.url() + sig)) { stoppedAt = 'loop'; break; } seenUrls.add(urlBefore + sig);
  }
  return { pages, questions: [...seenQ.values()], stoppedAt, finalUrl: page.url() };
}
