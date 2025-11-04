// BLS LoginSubmit checker (no password) — polls every N seconds
// - GET /MAR/account/Login  => parse inputs (names/values + __RequestVerificationToken/Id/ReturnUrl)
// - Build payload using page values AS-IS, except only the email field is set to EMAIL
// - POST /MAR/account/LoginSubmit (x-www-form-urlencoded), no redirects
// - Log: HTTP status + Location + the exact payload we sent (to verify it matches your sample)

const express = require('express');
const axios = require('axios').default;
const cheerio = require('cheerio');
const { CookieJar } = require('tough-cookie');
const qs = require('qs');

const PORT = process.env.PORT || 10000;
const BASE = process.env.BLS_BASE || 'https://www.blsspainmorocco.net';
const LOGIN_PATH = '/MAR/account/Login';
const SUBMIT_PATH = '/MAR/account/LoginSubmit';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);

// الإيميل الوحيد الذي سنملأه في الطلب (بدون باسوورد)
const EMAIL = process.env.LOGIN_EMAIL || 'jamalfahal6@gmail.com';

// ============ axios + CookieJar (لا نتبع 302) ============
function createClient() {
  const jar = new CookieJar();
  const http = axios.create({
    baseURL: BASE,
    maxRedirects: 0,                // لا تتبع 302
    validateStatus: () => true,     // خليه يرجع الاستجابة كما هي
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache'
    },
    jar
  });

  // attach cookies before each request
  http.interceptors.request.use(async (config) => {
    const cookieString = await jar.getCookieString(config.baseURL + (config.url || ''));
    config.headers = config.headers || {};
    config.headers['Cookie'] = cookieString;
    return config;
  });

  // update jar from each response
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

// ============ Helpers ============
async function fetchLogin(http) {
  const res = await http.get(LOGIN_PATH, {
    headers: { Referer: BASE + '/MAR/home/index' }
  });
  if (!res || res.status !== 200 || !res.data) {
    throw new Error(`GET ${LOGIN_PATH} failed: HTTP ${res && res.status}`);
  }
  return res.data;
}

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
  // 1) type=email
  for (const [k, v] of Object.entries(inputs)) {
    if (v.type === 'email') return k;
  }
  // 2) name contains email
  for (const [k] of Object.entries(inputs)) {
    if (/email/i.test(k)) return k;
  }
  // 3) label[for] يشير لحقل
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

  // املأ كل الحقول بالقيم الموجودة في الصفحة (كما هي)
  for (const [name, meta] of Object.entries(inputs)) {
    payload[name] = meta.value || '';
  }

  // تعرّف على اسم حقل الإيميل وعدّله فقط
  const emailName = findEmailField(inputs, $);
  if (emailName) {
    payload[emailName] = emailValue || '';
  }

  return { payload, emailName };
}

async function postLoginSubmit(http, payload) {
  const body = qs.stringify(payload);
  const res = await http.post(SUBMIT_PATH, body, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': BASE,
      'Referer': BASE + LOGIN_PATH
    }
  });
  return res;
}

// ============ Poll logic ============
async function pollOnce() {
  try {
    const startedAt = new Date().toISOString();
    const { http } = createClient();

    // 1) GET login and parse all inputs (tokens + randomized names)
    const html = await fetchLogin(http);

    // 2) payload = page values AS-IS (only override the email field)
    const { payload, emailName } = buildPayloadFromPage(html, EMAIL);

    // 3) POST LoginSubmit (no redirect following)
    const res = await postLoginSubmit(http, payload);
    const is302 = res.status >= 300 && res.status < 400;
    const location = res.headers['location'] || null;

    // 4) consider error-like redirects (/Home/Error? or /account/Login?err=)
    const isErrorLike =
      (location && (/\/Home\/Error\?/i.test(location) || /\/account\/login\?err=/i.test(location)));

    // 5) logging (payload preview similar to your sample)
    console.log('====== BLS LoginSubmit check ======');
    console.log('StartedAt   :', startedAt);
    console.log('POST Status :', res.status, is302 ? '(302 Found)' : '');
    console.log('Location    :', location);
    console.log('Email field :', emailName || '(not found)');
    console.log('Payload sent:', payload); // ستراه بالشكل الذي تريد (أسماء عشوائية + التوكنات)
    console.log('Error-like  :', !!isErrorLike);
    console.log('===================================');

  } catch (err) {
    console.error('[poll error]', err && err.message ? err.message : err);
  }
}

// run forever
setInterval(pollOnce, POLL_INTERVAL_MS);

// minimal http just to know it’s running
const app = express();
app.get('/', (req, res) => res.send('BLS LoginSubmit checker running ✅'));
app.get('/once', async (req, res) => {
  try {
    await pollOnce();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});
app.listen(PORT, () => {
  console.log(`✅ Server listening on ${PORT}`);
  console.log(`⏱️ Poll every ${POLL_INTERVAL_MS} ms`);
  console.log(`📧 EMAIL used for the email field: ${EMAIL}`);
});
