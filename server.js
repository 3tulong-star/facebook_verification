import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { chromium } from 'playwright';
import XLSX from 'xlsx';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const jobs = new Map();
const LOG_DIR = path.join(__dirname, 'logs');
const MAX_JOB_CONCURRENCY = 6;
const MAX_RECHECK_CONCURRENCY = 2;

app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function normalizePhones(text) {
  return [...new Set(String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
}

function normalizePhoneDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function columnName(index) {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const mod = (n - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    n = Math.floor((n - mod) / 26);
  }
  return name;
}

function parseWorkbook(buffer, columnIndex = 0) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { sheetName: '', columns: [], phones: [] };
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, blankrows: false });
  const maxColumns = rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
  const columns = Array.from({ length: maxColumns }, (_unused, index) => {
    const samples = rows.map(row => String(row?.[index] || '').trim()).filter(Boolean);
    const digits = rows.map(row => normalizePhoneDigits(row?.[index])).filter(Boolean);
    const firstValue = samples[0] || '';
    return {
      index,
      name: columnName(index),
      label: firstValue ? `${columnName(index)} - ${firstValue.slice(0, 24)}` : columnName(index),
      nonEmpty: samples.length,
      normalizedCount: [...new Set(digits)].length,
    };
  });
  const phones = [...new Set(rows.map(row => normalizePhoneDigits(row?.[columnIndex])).filter(Boolean))];
  return { sheetName, columns, phones };
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function classifyResult({ initialUrl, finalUrl, text }) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  const urlChanged = !!finalUrl && !!initialUrl && finalUrl !== initialUrl;
  const inRecoverFlow = /\/recover\//i.test(finalUrl || '');
  const hasNoAccountText = /找不到帐户|找不到账户|No search results|No account found|check your email or mobile number and try again/i.test(t);
  const hasChooseAccountText = /选择你的账户|这些 Facebook 个人主页与你输入的邮箱或手机号相符|Choose your account|These Facebook profiles match the email (?:address )?or mobile number/i.test(t);
  const hasRecoveryText = /选择登录方式|获取短信验证码|使用密码|无法再访问这些\?|Choose how to log in|Send code via SMS|Use password|No longer have access to these\?/i.test(t);
  const hasIdentifyText = /查找你的账户|请输入你的手机号或邮箱|Find your account|Please enter your mobile number or email/i.test(t);

  if (inRecoverFlow || urlChanged) return { status: 'HAS_FB', reason: 'url changed into recovery flow', matchedRule: inRecoverFlow ? 'recover_url' : 'url_changed' };
  if (!urlChanged && /\/login\/identify/i.test(finalUrl || '') && hasNoAccountText) return { status: 'NO_FB', reason: 'stayed on identify page with no-account text', matchedRule: 'identify_url_plus_no_account_text' };
  if (hasChooseAccountText) return { status: 'HAS_FB', reason: 'facebook returned matching account profiles', matchedRule: 'choose_account_text' };
  if (hasRecoveryText) return { status: 'HAS_FB', reason: 'facebook returned recovery options', matchedRule: 'recovery_options_text' };
  if (hasIdentifyText) return { status: 'UNKNOWN', reason: 'stayed on identify page without conclusive result', matchedRule: 'identify_page_text' };
  return { status: 'UNKNOWN', reason: 'unrecognized response page', matchedRule: 'fallback_unrecognized' };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT: ${label} exceeded ${ms}ms`)), ms))
  ]);
}

function createSummary(results) {
  return {
    total: results.length,
    hasFb: results.filter(r => r.status === 'HAS_FB').length,
    noFb: results.filter(r => r.status === 'NO_FB').length,
    unknown: results.filter(r => r.status === 'UNKNOWN').length,
    error: results.filter(r => r.status === 'ERROR').length,
    needsRecheck: results.filter(r => r.needsRecheck).length,
    lowConfidence: results.filter(r => r.confidence === 'low').length,
  };
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function ensureLogDir() {
  await fs.mkdir(LOG_DIR, { recursive: true });
}

function compactResultForLog(result) {
  return {
    index: result.index,
    phone: result.phone,
    status: result.status,
    reason: result.reason,
    matchedRule: result.matchedRule,
    title: result.title,
    initialUrl: result.initialUrl,
    finalUrl: result.finalUrl,
    urlChanged: result.urlChanged,
    visibleTextSnippet: result.visibleTextSnippet,
    profile: result.profile,
    confidence: result.confidence,
    needsRecheck: !!result.needsRecheck,
    observationFlags: result.observationFlags || [],
    error: result.error,
    checkedAt: result.checkedAt,
  };
}

async function appendJobLog(job, event, data = {}) {
  if (!job.logFile) return;
  const line = JSON.stringify({
    at: new Date().toISOString(),
    event,
    jobId: job.id,
    total: job.total,
    processed: job.results.length,
    currentBatch: job.currentBatch,
    totalBatches: job.totalBatches,
    summary: createSummary(job.results),
    ...data,
  });
  await fs.appendFile(job.logFile, `${line}\n`, 'utf8');
}

function addObservationFlags(result) {
  const flags = [];
  let confidence = 'high';
  if (result.index > 100) flags.push('after_first_100');
  if (result.index > 100 && result.status === 'HAS_FB' && result.matchedRule === 'url_changed') {
    flags.push('after_100_has_fb_by_url_changed_only');
    flags.push('needs_recheck');
    confidence = 'low';
  }
  if (result.status === 'HAS_FB' && result.matchedRule === 'url_changed') {
    confidence = result.index > 100 ? 'low' : 'medium';
  }
  if (result.status === 'UNKNOWN' || result.status === 'ERROR') {
    flags.push('needs_recheck');
    confidence = 'low';
  }
  return { ...result, confidence, needsRecheck: flags.includes('needs_recheck'), observationFlags: [...new Set(flags)] };
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
];
const LOCALES = ['en-US', 'zh-CN', 'en-GB'];
const TIMEZONES = ['Asia/Shanghai', 'America/Los_Angeles', 'Europe/London'];
const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 }
];
const COLOR_SCHEMES = ['light', 'dark'];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function jitter(base, spread = 0.35) {
  const factor = 1 + ((Math.random() * 2 - 1) * spread);
  return Math.max(50, Math.round(base * factor));
}

function createProfile() {
  return {
    userAgent: pick(USER_AGENTS),
    locale: pick(LOCALES),
    timezoneId: pick(TIMEZONES),
    viewport: pick(VIEWPORTS),
    colorScheme: pick(COLOR_SCHEMES),
  };
}

function jobSnapshot(job) {
  return {
    jobId: job.id,
    status: job.status,
    total: job.total,
    processed: job.results.length,
    progress: { current: job.results.length, total: job.total },
    summary: createSummary(job.results),
    error: job.error,
    lastEventAt: job.lastEventAt,
    concurrency: job.concurrency,
    delayMs: job.delayMs,
    batchSize: job.batchSize,
    batchPauseMs: job.batchPauseMs,
    currentBatch: job.currentBatch,
    totalBatches: job.totalBatches,
    logFile: job.logFile,
  };
}

async function createBrowser() {
  return chromium.launch({ headless: true });
}

async function checkPhone(browser, phone) {
  const profile = createProfile();
  let context = null;
  let page = null;
  let text = '';
  const initialUrl = 'https://www.facebook.com/login/identify';
  let finalUrl = '';
  let title = '';

  try {
    await withTimeout((async () => {
      context = await browser.newContext({
        viewport: profile.viewport,
        userAgent: profile.userAgent,
        locale: profile.locale,
        timezoneId: profile.timezoneId,
        colorScheme: profile.colorScheme,
      });
      page = await context.newPage();
      await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(jitter(2000));
      const input = page.locator('input[type="text"], input[type="email"], input[name="email"]').first();
      await input.waitFor({ state: 'visible', timeout: 15000 });
      await input.fill(phone);
      await page.waitForTimeout(jitter(400));
      const button = page.getByRole('button', { name: /继续|Continue/i }).first();
      await button.click({ timeout: 10000, delay: jitter(80) });
      await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(jitter(2500));
      text = await withTimeout(page.locator('body').innerText().catch(() => ''), 10000, 'read body text');
      finalUrl = page.url();
      title = await withTimeout(page.title().catch(() => ''), 5000, 'read title');
    })(), 45000, `phone ${phone}`);

    const visibleTextSnippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const classified = classifyResult({ initialUrl, finalUrl, text });
    return { phone, status: classified.status, reason: classified.reason, matchedRule: classified.matchedRule, title, initialUrl, finalUrl, urlChanged: initialUrl !== finalUrl, visibleTextSnippet, profile, error: null, checkedAt: new Date().toISOString() };
  } catch (e) {
    return { phone, status: 'ERROR', reason: 'runtime error', matchedRule: 'runtime_error', title, initialUrl, finalUrl, urlChanged: initialUrl !== finalUrl, visibleTextSnippet: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500), profile, error: String(e && e.stack ? e.stack : e), checkedAt: new Date().toISOString() };
  } finally {
    if (context) await withTimeout(context.close().catch(() => {}), 10000, 'context close').catch(() => {});
  }
}

async function runChecks({ phones, delayMs = 2000, concurrency = 1, onResult }) {
  const results = new Array(phones.length);
  const workers = [];
  let nextIndex = 0;

  for (let w = 0; w < concurrency; w++) {
    workers.push((async () => {
      let browser = await createBrowser();
      let processedByWorker = 0;
      try {
        while (true) {
          const current = nextIndex++;
          if (current >= phones.length) break;
          if (processedByWorker > 0 && processedByWorker % 5 === 0) {
            await withTimeout(browser.close().catch(() => {}), 10000, 'browser close').catch(() => {});
            browser = await createBrowser();
          }
          const result = { index: current + 1, ...(await checkPhone(browser, phones[current])) };
          results[current] = result;
          processedByWorker += 1;
          if (onResult) {
            const readyResults = results.filter(Boolean);
            await onResult(result, createSummary(readyResults), { current: readyResults.length, total: phones.length });
          }
          if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      } finally {
        if (browser) await withTimeout(browser.close().catch(() => {}), 10000, 'browser close').catch(() => {});
      }
    })());
  }

  await Promise.all(workers);
  return results.filter(Boolean).sort((a, b) => a.index - b.index);
}

async function createJob({ phones, delayMs, concurrency, batchSize, batchPauseMs }) {
  const id = crypto.randomUUID();
  const batches = chunkArray(phones, batchSize);
  await ensureLogDir();
  const job = {
    id,
    phones,
    delayMs,
    concurrency,
    batchSize,
    batchPauseMs,
    batches,
    currentBatch: 0,
    totalBatches: batches.length,
    results: [],
    total: phones.length,
    status: 'pending',
    error: null,
    listeners: new Set(),
    createdAt: Date.now(),
    lastEventAt: Date.now(),
    logFile: path.join(LOG_DIR, `${safeTimestamp()}-${id}.jsonl`),
  };
  jobs.set(id, job);
  return job;
}

function emitJob(job, event, data) {
  job.lastEventAt = Date.now();
  for (const res of job.listeners) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

async function startJob(job) {
  if (job.status !== 'pending') return;
  job.status = 'running';

  try {
    await appendJobLog(job, 'start', {
      settings: {
        delayMs: job.delayMs,
        concurrency: job.concurrency,
        batchSize: job.batchSize,
        batchPauseMs: job.batchPauseMs,
      },
      phones: job.phones,
    });
    emitJob(job, 'start', { ...jobSnapshot(job) });

    let globalIndexOffset = 0;
    for (let b = 0; b < job.batches.length; b++) {
      job.currentBatch = b + 1;
      const batchPhones = job.batches[b];
      await appendJobLog(job, 'batch_start', { batchIndex: b + 1, batchCount: job.batches.length, batchSize: batchPhones.length });
      emitJob(job, 'batch', { ...jobSnapshot(job), batchIndex: b + 1, batchCount: job.batches.length, batchSize: batchPhones.length, message: `starting batch ${b + 1}/${job.batches.length}` });

      const batchResults = await runChecks({
        phones: batchPhones,
        delayMs: job.delayMs,
        concurrency: job.concurrency,
        onResult: async (result) => {
          const adjusted = addObservationFlags({ ...result, index: result.index + globalIndexOffset });
          job.results = job.results.filter(r => r.index !== adjusted.index).concat(adjusted).sort((a, b) => a.index - b.index);
          await appendJobLog(job, 'result', { result: compactResultForLog(adjusted) });
          emitJob(job, 'result', { result: adjusted, summary: createSummary(job.results), progress: { current: job.results.length, total: job.total }, ...jobSnapshot(job) });
        }
      });

      const adjustedBatch = batchResults.map(r => addObservationFlags({ ...r, index: r.index + globalIndexOffset }));
      for (const r of adjustedBatch) {
        job.results = job.results.filter(x => x.index !== r.index).concat(r).sort((a, b) => a.index - b.index);
      }
      globalIndexOffset += batchPhones.length;

      await appendJobLog(job, 'batch_done', { batchIndex: b + 1, batchCount: job.batches.length, batchSize: batchPhones.length });
      emitJob(job, 'batch', { ...jobSnapshot(job), batchIndex: b + 1, batchCount: job.batches.length, batchSize: batchPhones.length, message: `finished batch ${b + 1}/${job.batches.length}` });

      if (b < job.batches.length - 1 && job.batchPauseMs > 0) {
        await appendJobLog(job, 'batch_pause', { nextBatch: b + 2, pauseMs: job.batchPauseMs });
        emitJob(job, 'pause', { ...jobSnapshot(job), nextBatch: b + 2, pauseMs: job.batchPauseMs, message: `pausing ${job.batchPauseMs}ms before next batch` });
        await new Promise(resolve => setTimeout(resolve, job.batchPauseMs));
      }
    }

    job.status = 'done';
    await appendJobLog(job, 'done', { results: job.results.map(compactResultForLog) });
    emitJob(job, 'done', { ...jobSnapshot(job), results: job.results, progress: { current: job.results.length, total: job.total } });
  } catch (e) {
    job.status = 'error';
    job.error = String(e && e.stack ? e.stack : e);
    await appendJobLog(job, 'error', { error: job.error });
    emitJob(job, 'error', { ...jobSnapshot(job), error: job.error });
  }
}

app.post('/api/jobs', async (req, res) => {
  const phones = normalizePhones(req.body?.phones || '');
  const delayMs = Math.max(300, Math.min(Number(req.body?.delayMs || 1500), 10000));
  const concurrency = Math.max(1, Math.min(Number(req.body?.concurrency || 1), MAX_JOB_CONCURRENCY));
  const batchSize = Math.max(10, Math.min(Number(req.body?.batchSize || 100), 200));
  const batchPauseMs = Math.max(0, Math.min(Number(req.body?.batchPauseMs || 15000), 120000));

  if (!phones.length) return res.status(400).json({ error: 'No phones provided' });

  try {
    const job = await createJob({ phones, delayMs, concurrency, batchSize, batchPauseMs });
    startJob(job).catch((e) => {
      job.status = 'error';
      job.error = String(e && e.stack ? e.stack : e);
      emitJob(job, 'error', { ...jobSnapshot(job), error: job.error });
    });
    res.json({ ...jobSnapshot(job) });
  } catch (e) {
    res.status(500).json({ error: String(e && e.stack ? e.stack : e) });
  }
});

app.get('/api/jobs/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ ...jobSnapshot(job), recentResults: job.results.slice(-20) });
});

app.get('/api/jobs/:jobId/logs', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.logFile) return res.status(404).json({ error: 'Job log not found' });
  try {
    const content = await fs.readFile(job.logFile, 'utf8');
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${job.id}.jsonl"`);
    res.send(content);
  } catch (e) {
    res.status(404).json({ error: String(e && e.stack ? e.stack : e) });
  }
});

app.get('/api/jobs/:jobId/stream', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).end('Job not found');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  job.listeners.add(res);
  res.write(`event: start\n`);
  res.write(`data: ${JSON.stringify({ ...jobSnapshot(job) })}\n\n`);

  for (const result of job.results) {
    res.write(`event: result\n`);
    res.write(`data: ${JSON.stringify({ result, summary: createSummary(job.results), progress: { current: job.results.length, total: job.total }, ...jobSnapshot(job) })}\n\n`);
  }

  if (job.status === 'done') {
    res.write(`event: done\n`);
    res.write(`data: ${JSON.stringify({ ...jobSnapshot(job), results: job.results })}\n\n`);
    res.end();
    job.listeners.delete(res);
    return;
  }
  if (job.status === 'error') {
    res.write(`event: error\n`);
    res.write(`data: ${JSON.stringify({ ...jobSnapshot(job) })}\n\n`);
    res.end();
    job.listeners.delete(res);
    return;
  }

  const heartbeat = setInterval(() => {
    if (!job.listeners.has(res)) return;
    res.write(`event: ping\n`);
    res.write(`data: ${JSON.stringify({ ...jobSnapshot(job) })}\n\n`);
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    job.listeners.delete(res);
  });
});

app.post('/api/recheck', async (req, res) => {
  const phones = normalizePhones(req.body?.phones || '');
  const delayMs = Math.max(300, Math.min(Number(req.body?.delayMs || 1500), 10000));
  const concurrency = Math.max(1, Math.min(Number(req.body?.concurrency || 1), MAX_RECHECK_CONCURRENCY));
  if (!phones.length) return res.status(400).json({ error: 'No phones provided' });
  const job = req.body?.jobId ? jobs.get(req.body.jobId) : null;
  try {
    if (job) await appendJobLog(job, 'recheck_start', { phones, settings: { delayMs, concurrency } });
    const results = (await runChecks({ phones, delayMs, concurrency })).map(addObservationFlags);
    if (job) {
      for (const result of results) await appendJobLog(job, 'recheck_result', { result: compactResultForLog(result) });
      await appendJobLog(job, 'recheck_done', { summary: createSummary(results), results: results.map(compactResultForLog) });
    }
    res.json({ summary: createSummary(results), results });
  } catch (e) {
    if (job) await appendJobLog(job, 'recheck_error', { error: String(e && e.stack ? e.stack : e) }).catch(() => {});
    res.status(500).json({ error: String(e && e.stack ? e.stack : e) });
  }
});

app.post('/api/import.xlsx', async (req, res) => {
  const raw = String(req.body?.fileBase64 || '').replace(/^data:.*?;base64,/, '');
  const columnIndex = Math.max(0, Number(req.body?.columnIndex || 0));
  if (!raw) return res.status(400).json({ error: 'No file provided' });
  try {
    const parsed = parseWorkbook(Buffer.from(raw, 'base64'), columnIndex);
    res.json({ ...parsed, total: parsed.phones.length, selectedColumnIndex: columnIndex });
  } catch (e) {
    res.status(400).json({ error: String(e && e.stack ? e.stack : e) });
  }
});

app.post('/api/export.xlsx', async (req, res) => {
  const results = Array.isArray(req.body?.results) ? req.body.results : [];
  if (!results.length) return res.status(400).json({ error: 'No results provided' });

  const rows = results.map(r => ({
    Index: r.index,
    Phone: r.phone,
    Status: r.status,
    Reason: r.reason,
    MatchedRule: r.matchedRule || '',
    Confidence: r.confidence || '',
    NeedsRecheck: r.needsRecheck ? 'true' : 'false',
    ObservationFlags: Array.isArray(r.observationFlags) ? r.observationFlags.join(',') : '',
    Title: r.title || '',
    InitialUrl: r.initialUrl || '',
    FinalUrl: r.finalUrl || '',
    UrlChanged: r.urlChanged ? 'true' : 'false',
    VisibleTextSnippet: r.visibleTextSnippet || '',
    UserAgent: r.profile?.userAgent || '',
    Locale: r.profile?.locale || '',
    Timezone: r.profile?.timezoneId || '',
    Viewport: r.profile?.viewport ? `${r.profile.viewport.width}x${r.profile.viewport.height}` : '',
    CheckedAt: r.checkedAt || '',
    Error: r.error || ''
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'results');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="facebook-check-results.xlsx"');
  res.send(buffer);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, jobs: jobs.size });
});

app.listen(PORT, () => {
  console.log(`facebook-phone-checker-web listening on :${PORT}`);
});
