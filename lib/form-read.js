// Read an application form the way the member sees it — every field, its label, its type,
// the options, whether it's required — using the Pi's Chromium through career-ops' Playwright.
// STRICTLY READ-ONLY: navigates and reads the DOM. Never types, clicks a control, or submits.
// The one "navigation" it allows itself is following an <a href> whose text says Apply when the
// posting page carries no form (Lever /apply, Greenhouse #app links, company "Apply now" links).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Runs inside the page. Kept as one self-contained function so it can be unit-tested on a data: URL.
export function collectFieldsInPage() {
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').trim();
  const visible = (el) => { const r = el.getClientRects(); return r.length > 0 && !(el.closest('[hidden],[aria-hidden="true"]')); };
  const labelFor = (el) => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return clean(l.textContent); }
    const by = el.getAttribute('aria-labelledby'); if (by) { const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '); if (clean(t)) return clean(t); }
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    const wrap = el.closest('label'); if (wrap) return clean(wrap.textContent.replace(el.value ?? '', ''));
    // Nearest preceding label-ish text inside the field's container.
    let box = el.closest('fieldset, [class*="field"], [class*="question"], [class*="form-group"], [class*="FormField"], li, div');
    for (let i = 0; box && i < 4; i++, box = box.parentElement) {
      const cand = box.querySelector('legend, label, [class*="label"], h1, h2, h3, h4, p, span');
      const t = cand && cand !== el && !cand.contains(el) ? clean(cand.textContent) : '';
      if (t && t.length >= 3 && t.length <= 240) return t;
    }
    return clean(el.getAttribute('placeholder')) || clean(el.name) || '';
  };
  // Handles from an earlier page of the same SPA would collide with this page's — clear them first.
  for (const e of document.querySelectorAll('[data-co-idx]')) delete e.dataset.coIdx;
  const out = []; const groups = new Map(); let k = 0;
  const els = document.querySelectorAll('input, textarea, select');
  for (const el of els) {
    const type = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : (el.type || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image', 'search'].includes(type)) continue;
    if (type !== 'file' && !visible(el)) continue;
    const required = el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(labelFor(el)) || !!el.closest('[class*="required"]');
    if (type === 'radio' || type === 'checkbox') {
      el.dataset.coIdx = String(k);
      const name = el.name || el.closest('fieldset')?.id || labelFor(el);
      const g = groups.get(name) ?? { type: type === 'radio' ? 'radio' : 'checkbox', name, label: '', options: [], optionIdx: [], checked: [], required: false };
      const fs = el.closest('fieldset'); const legend = fs?.querySelector('legend');
      g.label ||= clean(legend?.textContent) || (fs ? labelFor(fs.querySelector('input')) : '');
      const optLabel = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) || el.closest('label')?.textContent || el.value;
      g.options.push(clean(optLabel)); g.optionIdx.push(k++); if (el.checked) g.checked.push(clean(optLabel)); g.required ||= required;
      groups.set(name, g); continue;
    }
    el.dataset.coIdx = String(k);   // handle for the signed-in walker (lib/form-login.js)
    const f = { idx: k++, type, name: el.name || el.id || '', label: labelFor(el), required, maxLength: el.maxLength > 0 ? el.maxLength : null, value: type === 'file' ? '' : String(el.value ?? '').slice(0, 200) };
    if (type === 'select') f.options = [...el.options].map((o) => clean(o.textContent)).filter(Boolean).slice(0, 60);
    if (type === 'file') f.accept = el.accept || '';
    out.push(f);
  }
  for (const g of groups.values()) { if (!g.label && g.options.length === 1) g.label = g.options[0]; if (g.options.length > 1 || g.label) out.push(g); }
  const text = document.body?.innerText ?? '';
  const password = !![...els].find((e) => e.type === 'password' && visible(e));
  const applyLink = [...document.querySelectorAll('a[href]')].find((a) => /\bapply\b/i.test(a.textContent) && !/^javascript:/i.test(a.getAttribute('href')));
  return { title: document.title, fields: out, password, text: text.slice(0, 4000), applyHref: applyLink ? applyLink.href : null, url: location.href };
}

const IDENTITY = /^(first|last|full|given|family|preferred)?\s*name$|^name$|\be-?mail\b|\bphone\b|\bmobile\b|linkedin|github|portfolio|website|\bcity\b|\bcountry\b|address|postcode|zip/i;
const FILE_HINT = /resume|cv|curriculum|cover/i;

// → { fields, questions, identity, files, needsAccount, atsHint, finalUrl, title, note }
export function classifyFields(collected, url) {
  const fields = collected.fields ?? [];
  const identity = [], files = [], questions = [];
  for (const f of fields) {
    const label = f.label || f.name || '';
    if (f.type === 'file') { files.push({ label: label || 'File', accept: f.accept || '', required: !!f.required, kind: FILE_HINT.test(label + ' ' + f.name) ? (/cover/i.test(label + ' ' + f.name) ? 'cover' : 'cv') : 'other' }); continue; }
    // Identity fields have short labels; a long label that happens to mention "country" or "address" is a question.
    if (['email', 'tel', 'url', 'password'].includes(f.type) || (IDENTITY.test(label) && label.length <= 40)) { if (f.type !== 'password') identity.push({ label, type: f.type }); continue; }
    if (!label || label.length < 4) continue;
    questions.push({ label, type: f.type, required: !!f.required, options: f.options ?? [], maxLength: f.maxLength ?? null });
  }
  const host = (() => { try { return new URL(collected.url || url).hostname; } catch { return ''; } })();
  const atsHint = /myworkdayjobs/.test(host) ? 'Workday' : /successfactors|jobs2web/.test(host) ? 'SuccessFactors' : /csod\.com/.test(host) ? 'Cornerstone' : /greenhouse/.test(host) ? 'Greenhouse' : /lever\.co/.test(host) ? 'Lever' : /ashbyhq/.test(host) ? 'Ashby' : /smartrecruiters/.test(host) ? 'SmartRecruiters' : /eightfold/.test(host) ? 'Eightfold' : null;
  const gateText = /create (an )?account|sign in|log ?in|already have an account|register to apply/i.test(collected.text ?? '');
  const needsAccount = collected.password || (gateText && questions.length === 0 && files.length === 0);
  let note = '';
  if (needsAccount) note = `${atsHint ? atsHint + ' ' : ''}asks for an account before showing the form — later pages can't be read until you sign in; paste those questions by hand.`;
  else if (!questions.length && !files.length) note = 'no form fields found on this page — open the posting, find the Apply link and paste that URL instead.';
  return { fields, questions, identity, files, needsAccount, atsHint, finalUrl: collected.url || url, title: collected.title ?? '', note };
}

export async function openBrowser(env) {
  const { chromium } = await import(pathToFileURL(join(env.repo, 'node_modules', 'playwright', 'index.mjs')).href).catch(() => import('playwright'));
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ userAgent: UA, viewport: { width: 1280, height: 1800 } });
  return { browser, page };
}

export async function readApplyForm(env, url, { log, timeoutMs = 60000 } = {}) {
  const { browser, page } = await openBrowser(env);
  try {
    page.setDefaultTimeout(timeoutMs);
    const open = async (u) => { await page.goto(u, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500); return page.evaluate(collectFieldsInPage); };
    let collected = await open(url);
    let c = classifyFields(collected, url);
    // Posting page without a form but with an Apply link → follow it (a plain href, never a click on a control).
    if (!c.questions.length && !c.files.length && !c.needsAccount && collected.applyHref && collected.applyHref !== collected.url) {
      await log?.(`no form on the posting page — following its Apply link ${collected.applyHref}`);
      try { collected = await open(collected.applyHref); c = classifyFields(collected, collected.applyHref); } catch (e) { await log?.(`could not open the Apply link: ${e.message}`); }
    }
    return c;
  } finally { await browser.close().catch(() => {}); }
}
