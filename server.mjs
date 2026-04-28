#!/usr/bin/env node
/**
 * server.mjs — Career-Ops Dashboard Server
 *
 * Run:  node server.mjs
 * Open: http://localhost:3000
 *
 * Environment:
 *   PORT               (optional, default 3000)
 *   ANTHROPIC_API_KEY  (required for AI evaluation)
 */

import http            from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import path            from 'path';
import { fileURLToPath } from 'url';
import { spawn }       from 'child_process';
import yaml            from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = process.env.PORT || 3000;

// ── File paths ───────────────────────────────────────────────────────────────

const P = {
  applications : path.join(__dirname, 'data/applications.md'),
  pipeline     : path.join(__dirname, 'data/pipeline.md'),
  profile      : path.join(__dirname, 'config/profile.yml'),
  profileMd    : path.join(__dirname, 'modes/_profile.md'),
  cv           : path.join(__dirname, 'cv.md'),
  ofertaMd     : path.join(__dirname, 'modes/oferta.md'),
  sharedMd     : path.join(__dirname, 'modes/_shared.md'),
  reports      : path.join(__dirname, 'reports'),
  output       : path.join(__dirname, 'output'),
  dashboard    : path.join(__dirname, 'dashboard.html'),
  scheduler    : path.join(__dirname, '.scheduler.json'),
  cvTemplate   : path.join(__dirname, 'templates/cv-template.html'),
};

// ── Parsers ──────────────────────────────────────────────────────────────────

function parseApplications(md) {
  const rows = [];
  for (const line of md.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim());
    const num = cells[1];
    if (!num || num === '#' || num.startsWith('-') || isNaN(parseInt(num))) continue;
    const scoreRaw = cells[5] || '0';
    rows.push({
      num     : parseInt(num),
      date    : cells[2] || '',
      company : cells[3] || '',
      role    : cells[4] || '',
      score   : scoreRaw,
      scoreNum: parseFloat(scoreRaw.split('/')[0]) || 0,
      status  : cells[6] || '',
      pdf     : cells[7] || '',
      report  : cells[8] || '',
      notes   : cells[9] || '',
    });
  }
  return rows.sort((a, b) => b.scoreNum - a.scoreNum);
}

function parsePipeline(md) {
  const pending = [], processed = [];
  let section = '';
  for (const line of md.split('\n')) {
    if (/pendientes|pending/i.test(line))   { section = 'pending';   continue; }
    if (/procesadas|processed/i.test(line)) { section = 'processed'; continue; }
    if (section === 'pending' && line.startsWith('- [ ]')) {
      const parts = line.replace(/^- \[ \] /, '').split(' | ');
      pending.push({ url: parts[0]?.trim(), company: parts[1]?.trim(), role: parts[2]?.trim() });
    }
    if (section === 'processed' && line.startsWith('- [x]')) {
      const parts = line.replace(/^- \[x\] /, '').split(' | ');
      processed.push({ num: parts[0]?.trim(), url: parts[1]?.trim(), company: parts[2]?.trim(), role: parts[3]?.trim(), score: parts[4]?.trim() });
    }
  }
  return { pending, processed };
}

function updateApplicationRow(md, num, updates) {
  return md.split('\n').map(line => {
    if (!line.startsWith('|')) return line;
    const cells = line.split('|');
    if (cells[1]?.trim() !== String(num)) return line;
    if (updates.status !== undefined) cells[6] = ` ${updates.status} `;
    if (updates.notes  !== undefined) cells[9] = ` ${updates.notes} `;
    if (updates.pdf    !== undefined) cells[7] = ` ${updates.pdf} `;
    return cells.join('|');
  }).join('\n');
}

// Add a new pipeline entry to pipeline.md (pending section)
function addToPipeline(md, url, company, role) {
  const newLine = `- [ ] ${url} | ${company} | ${role}`;
  // Insert after the Pendientes header line
  const lines = md.split('\n');
  const idx = lines.findIndex(l => /pendientes|pending/i.test(l));
  if (idx === -1) return md + '\n' + newLine;
  lines.splice(idx + 1, 0, newLine);
  return lines.join('\n');
}

// ── Scheduler ────────────────────────────────────────────────────────────────

let schedulerTimer = null;

function loadScheduler() {
  if (!existsSync(P.scheduler)) return { enabled: false, intervalHours: 24, lastScan: null, nextScan: null };
  try { return JSON.parse(readFileSync(P.scheduler, 'utf8')); } catch { return { enabled: false, intervalHours: 24, lastScan: null, nextScan: null }; }
}

function saveScheduler(cfg) {
  writeFileSync(P.scheduler, JSON.stringify(cfg, null, 2));
}

function runScheduledScan() {
  console.log('[scheduler] Running scheduled scan…');
  const proc = spawn('node', ['scan.mjs'], { cwd: __dirname });
  proc.stdout.on('data', d => process.stdout.write('[scan] ' + d));
  proc.stderr.on('data', d => process.stderr.write('[scan] ' + d));
  proc.on('close', () => {
    const cfg = loadScheduler();
    cfg.lastScan = new Date().toISOString();
    cfg.nextScan = new Date(Date.now() + cfg.intervalHours * 3_600_000).toISOString();
    saveScheduler(cfg);
    setupScheduler();
  });
}

function setupScheduler() {
  if (schedulerTimer) clearTimeout(schedulerTimer);
  const cfg = loadScheduler();
  if (!cfg.enabled) return;
  const ms = cfg.nextScan
    ? Math.max(0, new Date(cfg.nextScan).getTime() - Date.now())
    : cfg.intervalHours * 3_600_000;
  schedulerTimer = setTimeout(runScheduledScan, ms);
  console.log(`[scheduler] Next scan in ${Math.round(ms / 60_000)} min`);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type'     : 'text/event-stream',
    'Cache-Control'    : 'no-cache',
    'Connection'       : 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function send(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => body += d.toString());
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

// ── Route handlers ───────────────────────────────────────────────────────────

function getApplications(res) {
  json(res, parseApplications(readFileSync(P.applications, 'utf8')));
}

function getPipeline(res) {
  json(res, parsePipeline(readFileSync(P.pipeline, 'utf8')));
}

function getProfile(res) {
  const profileYml = existsSync(P.profile)    ? yaml.load(readFileSync(P.profile,    'utf8')) : {};
  const profileMd  = existsSync(P.profileMd)  ? readFileSync(P.profileMd,  'utf8') : '';
  json(res, { ...profileYml, _profileMd: profileMd });
}

function getReports(res) {
  if (!existsSync(P.reports)) { json(res, []); return; }
  const files = readdirSync(P.reports).filter(f => f.endsWith('.md')).sort().reverse();
  json(res, files.map(f => ({ id: f.replace('.md', ''), filename: f })));
}

function getReport(res, id) {
  const fp = path.join(P.reports, `${id}.md`);
  if (!existsSync(fp)) { json(res, { error: 'Not found' }, 404); return; }
  json(res, { id, content: readFileSync(fp, 'utf8') });
}

function getSchedulerConfig(res) {
  json(res, loadScheduler());
}

async function setSchedulerConfig(req, res) {
  const body = await parseBody(req);
  const cfg  = { ...loadScheduler(), ...body };
  if (cfg.enabled && !cfg.nextScan) {
    cfg.nextScan = new Date(Date.now() + cfg.intervalHours * 3_600_000).toISOString();
  }
  saveScheduler(cfg);
  setupScheduler();
  json(res, cfg);
}

async function patchApplication(req, res, num) {
  const body = await parseBody(req);
  let md = readFileSync(P.applications, 'utf8');
  md = updateApplicationRow(md, num, body);
  writeFileSync(P.applications, md);
  json(res, { success: true });
}

async function postAddToPipeline(req, res) {
  const { url, company, role } = await parseBody(req);
  let md = readFileSync(P.pipeline, 'utf8');
  md = addToPipeline(md, url || '', company || 'Unknown', role || 'Unknown');
  writeFileSync(P.pipeline, md);
  json(res, { success: true });
}

function startScan(res) {
  sseHeaders(res);
  const proc = spawn('node', ['scan.mjs'], { cwd: __dirname });
  proc.stdout.on('data', d => send(res, { type: 'log',   message: d.toString() }));
  proc.stderr.on('data', d => send(res, { type: 'error', message: d.toString() }));
  proc.on('close', code => {
    const cfg = loadScheduler();
    cfg.lastScan = new Date().toISOString();
    if (cfg.enabled) cfg.nextScan = new Date(Date.now() + cfg.intervalHours * 3_600_000).toISOString();
    saveScheduler(cfg);
    send(res, { type: 'done', code });
    res.end();
  });
}

async function fetchJD(req, res) {
  const { url } = await parseBody(req);
  if (!url) { json(res, { error: 'url required' }, 400); return; }
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; career-ops/1.0)' } });
    const html = await r.text();
    // Very light HTML → text strip
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);
    json(res, { text });
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

async function evaluateJob(req, res) {
  const { jd, url } = await parseBody(req);
  sseHeaders(res);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    send(res, { type: 'no_key' });
    res.end();
    return;
  }

  const cvContent   = existsSync(P.cv)        ? readFileSync(P.cv,        'utf8') : '';
  const profileYml  = existsSync(P.profile)   ? readFileSync(P.profile,   'utf8') : '';
  const profileMd   = existsSync(P.profileMd) ? readFileSync(P.profileMd, 'utf8') : '';
  const ofertaMd    = existsSync(P.ofertaMd)  ? readFileSync(P.ofertaMd,  'utf8') : '';
  const sharedMd    = existsSync(P.sharedMd)  ? readFileSync(P.sharedMd,  'utf8') : '';

  const systemPrompt = [sharedMd, ofertaMd, '## Candidate Profile\n```yaml\n' + profileYml + '\n```', profileMd, '## Candidate CV\n\n' + cvContent].join('\n\n---\n\n');
  const userMessage  = url ? `Evaluate this job posting.\nURL: ${url}\n\nJob Description:\n${jd || ''}` : `Evaluate this job posting:\n\n${jd}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body    : JSON.stringify({
        model    : 'claude-opus-4-6',
        max_tokens: 4096,
        stream   : true,
        system   : systemPrompt,
        messages : [{ role: 'user', content: userMessage }],
      }),
    });

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6);
        if (raw === '[DONE]') continue;
        try {
          const evt = JSON.parse(raw);
          if (evt.type === 'content_block_delta' && evt.delta?.text) {
            send(res, { type: 'text', text: evt.delta.text });
          }
        } catch { /* ignore parse errors */ }
      }
    }
    send(res, { type: 'done' });
    res.end();
  } catch (e) {
    send(res, { type: 'error', message: e.message });
    send(res, { type: 'done' });
    res.end();
  }
}

async function generateCV(req, res) {
  const { company, role } = await parseBody(req);
  mkdirSync(P.output, { recursive: true });

  const slug    = (company || 'cv').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const dateStr = new Date().toISOString().split('T')[0];

  // Choose template: AI resume for AI/ML/clinical roles, Traditional otherwise
  const isAI = /\bai\b|machine.?learning|clinical.?ai|healthcare.?ai|data.?science|\bml\b|agentic|llm|nlp/i.test(role || '');
  const templateName = isAI
    ? 'Resume_Parul_AIProduct2026.docx'
    : 'Resume_Parul_TraditionalProduct2026.docx';
  const templatePath = path.join(__dirname, 'Parul Resume', templateName);

  if (!existsSync(templatePath)) {
    json(res, { error: `Template not found: ${templateName}` }, 500);
    return;
  }

  const outFilename = `cv-${slug}-${dateStr}.docx`;
  const outPath     = path.join(P.output, outFilename);

  const { copyFileSync } = await import('fs');
  copyFileSync(templatePath, outPath);

  json(res, { success: true, filename: outFilename, path: outPath, template: templateName });
}

function startAutofill(req, res) {
  sseHeaders(res);
  parseBody(req).then(({ url }) => {
    if (!url) { send(res, { type: 'error', message: 'URL required' }); send(res, { type: 'done' }); res.end(); return; }
    send(res, { type: 'log', message: `Starting autofill for: ${url}` });
    const proc = spawn('node', ['autofill.mjs', url], { cwd: __dirname });
    proc.stdout.on('data', d => {
      for (const line of d.toString().split('\n').filter(Boolean)) {
        try { send(res, { type: 'autofill', data: JSON.parse(line) }); } catch { send(res, { type: 'log', message: line }); }
      }
    });
    proc.stderr.on('data', d => send(res, { type: 'error', message: d.toString() }));
    proc.on('close', code => { send(res, { type: 'done', code }); res.end(); });
  });
}

// ── Batch helpers ────────────────────────────────────────────────────────────

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function getNextReportNum() {
  if (!existsSync(P.reports)) return 11;
  const files = readdirSync(P.reports).filter(f => /^\d+/.test(f) && f.endsWith('.md'));
  const nums  = files.map(f => parseInt(f.split('-')[0])).filter(n => !isNaN(n));
  // Also check applications.md for the highest num
  let maxApp = 10;
  try {
    const apps = parseApplications(readFileSync(P.applications, 'utf8'));
    maxApp = apps.reduce((m, a) => Math.max(m, a.num), 10);
  } catch {}
  return Math.max(nums.length ? Math.max(...nums) : 0, maxApp) + 1;
}

function markPipelineProcessed(url, numStr, company, role, score) {
  let md = readFileSync(P.pipeline, 'utf8');
  // Remove from pending (line starting with "- [ ] <url>")
  md = md.replace(new RegExp(`^- \\[ \\] ${escapeRegex(url)}.*$`, 'm'), '');
  // Add to Procesadas section
  const processedLine = `- [x] #${numStr} | ${url} | ${company} | ${role} | ${score} | PDF ❌`;
  md = md.replace(/(## Procesadas\n)/, `$1${processedLine}\n`);
  writeFileSync(P.pipeline, md);
}

async function batchEvaluate(req, res) {
  const { jobs } = await parseBody(req);
  if (!jobs?.length) { json(res, { error: 'jobs array required' }, 400); return; }
  sseHeaders(res);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    send(res, { type: 'no_key' });
    res.end();   // do NOT send all_done — let the client handle no_key cleanly
    return;
  }

  // Load shared context once
  const cvContent   = existsSync(P.cv)        ? readFileSync(P.cv,        'utf8') : '';
  const profileYml  = existsSync(P.profile)   ? readFileSync(P.profile,   'utf8') : '';
  const profileMd   = existsSync(P.profileMd) ? readFileSync(P.profileMd, 'utf8') : '';
  const ofertaMd    = existsSync(P.ofertaMd)  ? readFileSync(P.ofertaMd,  'utf8') : '';
  const sharedMd    = existsSync(P.sharedMd)  ? readFileSync(P.sharedMd,  'utf8') : '';
  const systemPrompt = [sharedMd, ofertaMd,
    '## Candidate Profile\n```yaml\n' + profileYml + '\n```',
    profileMd, '## Candidate CV\n\n' + cvContent].join('\n\n---\n\n');

  send(res, { type: 'batch_start', total: jobs.length });
  mkdirSync(P.reports, { recursive: true });
  mkdirSync(path.join(__dirname, 'batch/tracker-additions'), { recursive: true });

  let successCount = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    send(res, { type: 'job_start', index: i, company: job.company, role: job.role });

    try {
      let fullText = '';
      const userMessage = `Evaluate this job posting.\nURL: ${job.url}\nCompany: ${job.company}\nRole: ${job.role}`;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method  : 'POST',
        headers : { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body    : JSON.stringify({
          model    : 'claude-opus-4-6',
          max_tokens: 4096,
          stream   : true,
          system   : systemPrompt,
          messages : [{ role: 'user', content: userMessage }],
        }),
      });

      const reader  = response.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'content_block_delta' && evt.delta?.text) {
              fullText += evt.delta.text;
            }
          } catch {}
        }
      }

      // Extract global score — look for patterns like "4.2/5" near "global/score"
      const scoreMatch = fullText.match(/(?:global|score|puntuaci[oó]n)[^0-9]{0,20}(\d\.\d)\/5/i)
                      || fullText.match(/(\d\.\d)\/5/);
      const score  = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
      const status = score >= 3.5 ? 'Evaluated' : 'SKIP';

      // Assign report number (sequential, re-check each iteration to avoid collisions)
      const reportNum = getNextReportNum();
      const numStr    = String(reportNum).padStart(3, '0');
      const slug      = job.company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      const dateStr   = new Date().toISOString().split('T')[0];
      const filename  = `${numStr}-${slug}-${dateStr}.md`;

      const reportMd = [
        `# ${job.company} — ${job.role}`,
        ``,
        `**Score:** ${score}/5  `,
        `**Status:** ${status}  `,
        `**URL:** ${job.url}  `,
        `**Date:** ${dateStr}  `,
        `**Legitimacy:** unconfirmed (batch mode)`,
        ``,
        `---`,
        ``,
        fullText,
      ].join('\n');

      writeFileSync(path.join(P.reports, filename), reportMd);

      // Write TSV for merge-tracker
      const tsvLine = [reportNum, dateStr, job.company, job.role, status, `${score}/5`, '❌', `[${numStr}](reports/${filename})`, 'Batch evaluated'].join('\t');
      writeFileSync(path.join(__dirname, `batch/tracker-additions/${numStr}-${slug}.tsv`), tsvLine + '\n');

      // Mark processed in pipeline.md
      markPipelineProcessed(job.url, numStr, job.company, job.role, `${score}/5`);

      successCount++;
      send(res, { type: 'job_done', index: i, score, status, reportId: filename.replace('.md', '') });

    } catch (e) {
      send(res, { type: 'job_error', index: i, error: e.message });
    }
  }

  // Merge tracker additions into applications.md
  try {
    await new Promise(resolve => {
      const proc = spawn('node', ['merge-tracker.mjs'], { cwd: __dirname });
      proc.on('close', resolve);
    });
  } catch { /* merge is best-effort */ }

  send(res, { type: 'all_done', success: successCount, total: jobs.length });
  res.end();
}

function serveDashboard(res) {
  if (!existsSync(P.dashboard)) {
    res.writeHead(404); res.end('dashboard.html not found — run build first');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(readFileSync(P.dashboard, 'utf8'));
}

// ── Router ───────────────────────────────────────────────────────────────────

const ROUTES = [
  ['GET',   /^\/$/,                                     (req, res)      => serveDashboard(res)],
  ['GET',   /^\/api\/applications$/,                    (req, res)      => getApplications(res)],
  ['GET',   /^\/api\/pipeline$/,                        (req, res)      => getPipeline(res)],
  ['GET',   /^\/api\/profile$/,                         (req, res)      => getProfile(res)],
  ['GET',   /^\/api\/reports$/,                         (req, res)      => getReports(res)],
  ['GET',   /^\/api\/reports\/(.+)$/,                   (req, res, m)   => getReport(res, decodeURIComponent(m[1]))],
  ['GET',   /^\/api\/scheduler$/,                       (req, res)      => getSchedulerConfig(res)],
  ['POST',  /^\/api\/scheduler$/,                       (req, res)      => setSchedulerConfig(req, res)],
  ['POST',  /^\/api\/scan$/,                            (req, res)      => startScan(res)],
  ['POST',  /^\/api\/fetch-jd$/,                        (req, res)      => fetchJD(req, res)],
  ['POST',  /^\/api\/evaluate$/,                        (req, res)      => evaluateJob(req, res)],
  ['POST',  /^\/api\/generate-cv$/,                     (req, res)      => generateCV(req, res)],
  ['POST',  /^\/api\/autofill$/,                        (req, res)      => startAutofill(req, res)],
  ['POST',  /^\/api\/pipeline\/add$/,                   (req, res)      => postAddToPipeline(req, res)],
  ['POST',  /^\/api\/batch-evaluate$/,                  (req, res)      => batchEvaluate(req, res)],
  ['PATCH', /^\/api\/applications\/(\d+)$/,             (req, res, m)   => patchApplication(req, res, parseInt(m[1]))],
];

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const pathname = new URL(req.url, `http://localhost`).pathname;

  for (const [method, pattern, handler] of ROUTES) {
    if (req.method !== method) continue;
    const m = pathname.match(pattern);
    if (!m) continue;
    try { await handler(req, res, m); }
    catch (e) {
      console.error('[error]', e);
      if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('\n  ┌─────────────────────────────────────┐');
  console.log(`  │  Career-Ops  ·  localhost:${PORT}       │`);
  console.log('  └─────────────────────────────────────┘\n');
  setupScheduler();
});
