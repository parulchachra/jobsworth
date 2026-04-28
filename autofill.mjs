#!/usr/bin/env node
/**
 * autofill.mjs — Playwright-based job application autofiller
 *
 * Usage: node autofill.mjs <url>
 *
 * Reads candidate info from config/profile.yml.
 * Fills common form fields (name, email, phone, LinkedIn, location).
 * Opens browser in headed mode so the user can review before submitting.
 * NEVER submits automatically.
 */

import { chromium }  from 'playwright';
import { readFileSync, existsSync } from 'fs';
import yaml          from 'js-yaml';
import path          from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const url       = process.argv[2];

if (!url) {
  console.error(JSON.stringify({ type: 'error', message: 'Usage: node autofill.mjs <url>' }));
  process.exit(1);
}

// ── Load profile ─────────────────────────────────────────────────────────────

const profilePath = path.join(__dirname, 'config/profile.yml');
const profile     = existsSync(profilePath) ? yaml.load(readFileSync(profilePath, 'utf8')) : {};
const c           = profile.candidate || {};

const [firstName, ...rest] = (c.full_name || '').trim().split(/\s+/);
const lastName = rest.join(' ');

// ── Field definitions ────────────────────────────────────────────────────────
// Each entry: { labels (case-insensitive substrings), value, type }

const FIELDS = [
  { labels: ['first name', 'firstname', 'given name', 'first_name'],  value: firstName,              type: 'text' },
  { labels: ['last name', 'lastname', 'surname', 'family name', 'last_name'], value: lastName,       type: 'text' },
  { labels: ['full name', 'your name', 'legal name'],                 value: c.full_name,            type: 'text' },
  { labels: ['email', 'e-mail', 'email address'],                     value: c.email,                type: 'email' },
  { labels: ['phone', 'mobile', 'telephone', 'cell'],                 value: c.phone,                type: 'tel' },
  { labels: ['linkedin', 'linkedin url', 'linkedin profile'],         value: `https://${c.linkedin}`,type: 'url' },
  { labels: ['city', 'location', 'address'],                          value: c.location,             type: 'text' },
  { labels: ['website', 'portfolio', 'personal site'],                value: c.portfolio_url,        type: 'url' },
  { labels: ['github'],                                                value: c.github,               type: 'url' },
];

// ── Selectors to try for each field ─────────────────────────────────────────

function buildSelectors(labels) {
  const selectors = [];
  for (const label of labels) {
    selectors.push(`input[placeholder*="${label}" i]`);
    selectors.push(`input[aria-label*="${label}" i]`);
    selectors.push(`input[name*="${label.replace(/\s+/g, '')}" i]`);
    selectors.push(`input[id*="${label.replace(/\s+/g, '')}" i]`);
  }
  return selectors;
}

// ── Also try to fill textareas for cover letter / additional info ────────────

const COVER_LETTER_LABELS = ['cover letter', 'message', 'additional information', 'why do you want'];

function buildCoverLetter(profile) {
  const n = profile.narrative || {};
  return `${n.headline || ''}

${n.exit_story || ''}

I would welcome the opportunity to discuss how my background aligns with this role.`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log(JSON.stringify({ type: 'log', message: `Launching browser → ${url}` }));

  const browser = await chromium.launch({ headless: false, slowMo: 80 });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page    = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1500); // let JS render
    console.log(JSON.stringify({ type: 'log', message: 'Page loaded. Scanning for fields…' }));
  } catch (e) {
    console.log(JSON.stringify({ type: 'error', message: `Navigation failed: ${e.message}` }));
    return;
  }

  const filled   = [];
  const skipped  = [];

  // ── Fill text / email / tel / url inputs ───────────────────────────────────
  for (const field of FIELDS) {
    if (!field.value) { skipped.push(field.labels[0]); continue; }
    const selectors = buildSelectors(field.labels);
    let matched = false;
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.count() === 0) continue;
        if (!(await el.isVisible())) continue;
        await el.fill(String(field.value));
        filled.push({ field: field.labels[0], value: field.value });
        console.log(JSON.stringify({ type: 'filled', field: field.labels[0], value: field.value }));
        matched = true;
        break;
      } catch { /* selector not found, try next */ }
    }
    if (!matched) skipped.push(field.labels[0]);
  }

  // ── Try to fill cover letter / additional info textareas ──────────────────
  for (const label of COVER_LETTER_LABELS) {
    try {
      const el = page.locator(`textarea[placeholder*="${label}" i], textarea[aria-label*="${label}" i], textarea[name*="${label.replace(/\s+/g, '')}" i]`).first();
      if (await el.count() > 0 && await el.isVisible()) {
        const text = buildCoverLetter(profile);
        await el.fill(text);
        filled.push({ field: label, value: '(cover letter text)' });
        console.log(JSON.stringify({ type: 'filled', field: label, value: '(cover letter drafted)' }));
        break;
      }
    } catch { /* ignore */ }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(JSON.stringify({
    type   : 'summary',
    filled : filled.length,
    skipped: skipped,
    note   : 'Browser is open. Review all fields before submitting. DO NOT submit automatically.',
  }));

  console.log(JSON.stringify({
    type   : 'done',
    message: 'Autofill complete. Browser left open for your review.',
    filled,
    skipped,
  }));

  // Keep browser open — user must close it manually after reviewing
}

run().catch(e => {
  console.error(JSON.stringify({ type: 'error', message: e.message }));
  process.exit(1);
});
