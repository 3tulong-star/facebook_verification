import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function normalizePhones(text) {
  return [...new Set(
    String(text || '')
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean)
  )];
}

function classifyText(text) {
  const t = (text || '').replace(/\s+/g, ' ').trim();

  if (/找不到帐户|找不到账户|No search results|No account found|check your email or mobile number and try again/i.test(t)) {
    return { status: 'NO_FB', reason: 'facebook returned no account found' };
  }

  if (/选择登录方式|获取短信验证码|使用密码|无法再访问这些\?|Choose how to log in|Send code via SMS|Use password|No longer have access to these\?/i.test(t)) {
    return { status: 'HAS_FB', reason: 'facebook returned recovery options' };
  }

  if (/查找你的账户|请输入你的手机号或邮箱|Find your account|Please enter your mobile number or email/i.test(t)) {
    return { status: 'UNKNOWN', reason: 'stayed on identify page without conclusive result' };
  }

  return { status: 'UNKNOWN', reason: 'unrecognized response page' };
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
  };
}

async function createBrowser() {
  return chromium.launch({ headless: true });
}

async function checkPhone(browser, phone) {
  let context = null;
  let page = null;
  let text = '';
  let finalUrl = '';
  let title = '';

  try {
    await withTimeout((async () => {
      context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
      page = await context.newPage();

      await page.goto('https://www.facebook.com/login/identify', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2000);

      const input = page.locator('input[type="text"], input[type="email"], input[name="email"]').first();
      await input.waitFor({ state: 'visible', timeout: 15000 });
      await input.fill(phone);
      await page.waitForTimeout(400);

      const button = page.getByRole('button', { name: /继续|Continue/i }).first();
      await button.click({ timeout: 10000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(2500);

      text = await withTimeout(page.locator('body').innerText().catch(() => ''), 10000, 'read body text');
      finalUrl = page.url();
      title = await withTimeout(page.title().catch(() => ''), 5000, 'read title');
    })(), 45000, `phone ${phone}`);

    const classified = classifyText(text);
    return {
      phone,
      status: classified.status,
      reason: classified.reason,
      title,
      finalUrl,
      error: null,
      checkedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      phone,
      status: 'ERROR',
      reason: 'runtime error',
      title,
      finalUrl,
      error: String(e && e.stack ? e.stack : e),
      checkedAt: new Date().toISOString(),
    };
  } finally {
    if (context) {
      await withTimeout(context.close().catch(() => {}), 10000, 'context close').catch(() => {});
    }
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

          if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
        }
      } finally {
        if (browser) {
          await withTimeout(browser.close().catch(() => {}), 10000, 'browser close').catch(() => {});
        }
      }
    })());
  }

  await Promise.all(workers);
  return results.filter(Boolean).sort((a, b) => a.index - b.index);
}

app.get('/api/check-stream', async (req, res) => {
  const phones = normalizePhones(req.query.phones || '');
  const delayMs = Math.max(300, Math.min(Number(req.query.delayMs || 1500), 10000));
  const concurrency = Math.max(1, Math.min(Number(req.query.concurrency || 1), 4));

  if (!phones.length) {
    res.status(400).end('No phones provided');
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let clientClosed = false;
  const send = (event, data) => {
    if (clientClosed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  req.on('close', () => {
    clientClosed = true;
  });

  try {
    send('start', { total: phones.length, concurrency });

    const results = await runChecks({
      phones,
      delayMs,
      concurrency,
      onResult: async (result, summary, progress) => {
        send('result', { result, summary, progress });
      }
    });

    if (!clientClosed) {
      send('done', { summary: createSummary(results), results, progress: { current: results.length, total: phones.length } });
      res.end();
    }
  } catch (e) {
    if (!clientClosed) {
      send('error', {
        error: String(e && e.stack ? e.stack : e),
        progress: { current: 0, total: phones.length }
      });
      res.end();
    }
  }
});

app.post('/api/recheck', async (req, res) => {
  const phones = normalizePhones(req.body?.phones || '');
  const delayMs = Math.max(300, Math.min(Number(req.body?.delayMs || 1500), 10000));
  const concurrency = Math.max(1, Math.min(Number(req.body?.concurrency || 1), 4));

  if (!phones.length) {
    return res.status(400).json({ error: 'No phones provided' });
  }

  try {
    const results = await runChecks({ phones, delayMs, concurrency });
    res.json({ summary: createSummary(results), results });
  } catch (e) {
    res.status(500).json({ error: String(e && e.stack ? e.stack : e) });
  }
});

app.post('/api/export.xlsx', async (req, res) => {
  const results = Array.isArray(req.body?.results) ? req.body.results : [];
  if (!results.length) {
    return res.status(400).json({ error: 'No results provided' });
  }

  const rows = results.map(r => ({
    Index: r.index,
    Phone: r.phone,
    Status: r.status,
    Reason: r.reason,
    FinalUrl: r.finalUrl || '',
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
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`facebook-phone-checker-web listening on :${PORT}`);
});
