// server.js  (403-hardened)
// Polls LoginSubmit every N seconds using page values (no password), with warm-up, real browser headers, optional proxy.

const express = require('express');
const axios = require('axios').default;
const cheerio = require('cheerio');
const { CookieJar } = require('tough-cookie');
const qs = require('qs');
const { HttpsProxyAgent } = require('https-proxy-agent');

const PORT = process.env.PORT || 10000;
const BASE = process.env.BLS_BASE || 'https://www.blsspainmorocco.net';
const LOGIN_PATH = '/MAR/account/Login';
const HOME_PATH = '/MAR/home/index';
const SUBMIT_PATH = '/MAR/account/LoginSubmit';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);
const EMAIL = process.env.LOGIN_EMAIL || 'jamalfahal6@gmail.com';

// اختياري: بروكسي سكني/روتيتنج بصيغة http://user:pass@host:port أو socks5://...
const PROXY_URL = process.env.PROXY_URL || '';

function makeHeaders(referer = BASE) {
  return {
    'authority': new URL(BASE).host,
    'pragma': 'no-cache',
    'cache-control': 'no-cache',
    'upgrade-insecure-requests': '1',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-user': '?1',
    'sec-fetch-dest': 'document',
    'accept-language': 'ar-MA,ar;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5',
    'referer': referer
  };
}

function createClient() {
  const jar = new CookieJar();
  const common = {
    baseURL: BASE,
    maxRedirects: 0,
    validateStatus: () => true,
    headers: makeHeaders()
  };
  if (PROXY_URL) {
    common.httpsAgent = new HttpsProxyAgent(PROXY_URL);
  }
  const http = axios.create(common);

  // attach cookies
  http.interceptors.request.use(async (config) => {
    const cookieString = await jar.getCookieString(config.baseURL + (config.url || ''));
    config.headers = { ...(config.headers || {}), Cookie: cookieString };
    return config;
  });
  // set cookies
  http.interceptors.response.use(async (res) => {
    const setCookie = res.headers['set-cookie'];
    if (setCookie && setCookie.length) {
      for (const c of setCookie) {
        try { await jar.setCookie(c, BASE + (res.config.url || ''), { ignoreError: true }); } catch {}
      }
    }
    return res;
  });

  return { http, jar };
}

// تسخين الجلسة لتقليل 403
async function warmUp(http) {
  const s1 = await http.get('/', { headers: makeHeaders() });
  // تجاهل الحالة هنا؛ بعض الحمايات ترجع 200/302
  await sleep(300);
  const s2 = await http.get(HOME_PATH, { headers: makeHeaders(BASE + '/') });
  await sleep(300);
  const s3 = await http.get(LOGIN_PATH, { headers: makeHeaders(BASE + HOME_PATH) });
  return s3;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractInputs(html) {
  const $ = cheerio.load(html);
  const inputs = {};
  $('input').each((_, el) => {
    const $el = $(el);
    const name = ($el.attr('name') || '').trim();
    if (!name) return;
    const type = ($el.attr('type') || '').toLowerCase();
    const value = $el.attr('value') ?? '';
    inputs[name] = { type, value: String(value) };
  });
  return inputs;
}

function findEmailField(inputs, $html) {
  for (const [k, v] of Object.entries(inputs)) if (v.type === 'email') return k;
  for (const [k] of Object.entries(inputs)) if (/email/i.test(k)) return k;
  if ($html) {
    const $ = $html;
    let emailName = null;
    $('label').each((_, el) => {
      const t = ($(el).text() || '').toLowerCase();
      if (t.includes('email') || t.includes('e-mail') || t.includes('البريد')) {
        const forId = $(el).attr('for');
        if (forId) {
          const cand = $(`input#${forId}`).attr('name');
          if (cand) emailName = cand;
        }
      }
    });
    if (emailName) return emailName;
  }
  return null;
}

function buildPayloadFromPage(html, emailValue) {
  const $ = cheerio.load(html);
  const inputs = extractInputs(html);
  const payload = {};
  for (const [name, meta] of Object.entries(inputs)) payload[name] = meta.value || '';
  const emailName = findEmailField(inputs, $);
  if (emailName) payload[emailName] = emailValue || '';
  return { payload, emailName };
}

async function postLoginSubmit(http, payload) {
  const body = qs.stringify(payload);
  return await http.post(SUBMIT_PATH, body, {
    headers: {
      ...makeHeaders(BASE + LOGIN_PATH),
      'content-type': 'application/x-www-form-urlencoded'
    }
  });
}

async function pollOnce() {
  const { http } = createClient();
  // محاولتان: تسخين + إعادة
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const warm = await warmUp(http);
      if (warm.status !== 200 || !warm.data) throw new Error(`Login warmup failed: HTTP ${warm.status}`);

      const { payload, emailName } = buildPayloadFromPage(warm.data, EMAIL);
      const res = await postLoginSubmit(http, payload);
      const is302 = res.status >= 300 && res.status < 400;
      const location = res.headers['location'] || null;
      const isErrorLike =
        (location && (/\/Home\/Error\?/i.test(location) || /\/account\/login\?err=/i.test(location)));

      console.log('====== BLS LoginSubmit check ======');
      console.log('Attempt     :', attempt);
      console.log('GET(Login)  :', warm.status);
      console.log('POST Status :', res.status, is302 ? '(302 Found)' : '');
      console.log('Location    :', location);
      console.log('Email field :', emailName || '(not found)');
      console.log('Error-like  :', !!isErrorLike);
      console.log('Payload keys:', Object.keys(payload)); // تجنب طباعة القيم كاملة
      console.log('===================================');
      return; // نجاح المحاولة
    } catch (e) {
      console.warn(`[poll warn] attempt ${attempt} -> ${e.message || e}`);
      if (attempt === 1) await sleep(800);
    }
  }
  console.error('[poll error] all attempts failed');
}

setInterval(pollOnce, POLL_INTERVAL_MS);

// Minimal HTTP
const app = express();
app.get('/', (_req, res) => res.send('BLS LoginSubmit checker running ✅'));
app.get('/once', async (_req, res) => {
  try { await pollOnce(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on ${PORT}`);
  console.log(`⏱️ Poll every ${POLL_INTERVAL_MS} ms`);
  console.log(`📧 EMAIL used: ${EMAIL}`);
  if (PROXY_URL) console.log(`🌐 PROXY in use`);
});
