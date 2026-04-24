import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
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
    };
  } catch (e) {
    return {
      phone,
      status: 'ERROR',
      reason: 'runtime error',
      title,
      finalUrl,
      error: String(e && e.stack ? e.stack : e),
    };
  } finally {
    if (context) {
      await withTimeout(context.close().catch(() => {}), 10000, 'context close').catch(() => {});
    }
  }
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

app.post('/api/check', async (req, res) => {
  const phones = normalizePhones(req.body?.phones || '');
  const delayMs = Math.max(500, Math.min(Number(req.body?.delayMs || 2000), 10000));

  if (!phones.length) {
    return res.status(400).json({ error: 'No phones provided' });
  }

  let browser = null;
  const results = [];
  try {
    browser = await chromium.launch({ headless: true });

    for (let i = 0; i < phones.length; i++) {
      if (i > 0 && i % 5 === 0) {
        await withTimeout(browser.close().catch(() => {}), 10000, 'browser close').catch(() => {});
        browser = await chromium.launch({ headless: true });
      }

      const result = await checkPhone(browser, phones[i]);
      results.push({ index: i + 1, ...result });

      if (i < phones.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    res.json({ summary: createSummary(results), results });
  } catch (e) {
    res.status(500).json({ error: String(e && e.stack ? e.stack : e), results });
  } finally {
    if (browser) {
      await withTimeout(browser.close().catch(() => {}), 10000, 'browser close').catch(() => {});
    }
  }
});

app.get('/api/check-stream', async (req, res) => {
  const phones = normalizePhones(req.query.phones || '');
  const delayMs = Math.max(500, Math.min(Number(req.query.delayMs || 2000), 10000));

  if (!phones.length) {
    res.status(400).end('No phones provided');
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let browser = null;
  const results = [];
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  req.on('close', async () => {
    if (browser) {
      await withTimeout(browser.close().catch(() => {}), 10000, 'browser close').catch(() => {});
    }
  });

  try {
    browser = await chromium.launch({ headless: true });
    send('start', { total: phones.length });

    for (let i = 0; i < phones.length; i++) {
      if (i > 0 && i % 5 === 0) {
        await withTimeout(browser.close().catch(() => {}), 10000, 'browser close').catch(() => {});
        browser = await chromium.launch({ headless: true });
      }

      const result = { index: i + 1, ...(await checkPhone(browser, phones[i])) };
      results.push(result);
      send('result', { result, summary: createSummary(results) });

      if (i < phones.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    send('done', { summary: createSummary(results), results });
    res.end();
  } catch (e) {
    send('error', { error: String(e && e.stack ? e.stack : e), summary: createSummary(results), results });
    res.end();
  } finally {
    if (browser) {
      await withTimeout(browser.close().catch(() => {}), 10000, 'browser close').catch(() => {});
    }
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`facebook-phone-checker-web listening on :${PORT}`);
});
