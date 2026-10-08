/**
 * Vercel Serverless Function: Kingshop order proxy
 *
 * POST /api/kingshop-order  { playerId: "3329510" }
 *
 * Creates a 20K top-up order on cuan2.kingshop.live and returns the QRIS
 * data so the Neo Party frontend can render it in its own QRIS modal.
 *
 * Flow:
 *   1. GET https://cuan2.kingshop.live/topup  (session cookie + CSRF _token)
 *   2. POST form { _token, target_player, phone, productId } -> { qris_url, transaction_id }
 *   3. GET qris_url page -> extract QR image URL or raw QRIS payload
 *
 * Env (optional, improves reliability):
 *   KINGSHOP_PRODUCT_ID  default prd-01KXMTBE6QY2CWXQD6MB2BX700
 *   KINGSHOP_AMOUNT      default 20000
 */

const KINGSHOP_BASE = 'https://cuan2.kingshop.live';
const PRODUCT_ID = process.env.KINGSHOP_PRODUCT_ID || 'prd-01KXMTBE6QY2CWXQD6MB2BX700';
const AMOUNT = parseInt(process.env.KINGSHOP_AMOUNT || '20000', 10);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---- minimal cookie jar ----
class Jar {
  constructor() { this.cookies = {}; }
  store(setCookies) {
    if (!setCookies) return;
    const arr = Array.isArray(setCookies) ? setCookies : [setCookies];
    for (const c of arr) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) this.cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  }
  header() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function req(url, jar, opts = {}) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    ...(opts.headers || {}),
  };
  const ck = jar.header();
  if (ck) headers['Cookie'] = ck;
  const res = await fetch(url, { ...opts, headers, redirect: 'follow' });
  // Node fetch: getSetCookie() available in undici
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : res.headers.get('set-cookie');
  jar.store(setCookies);
  return res;
}

function extractToken(html) {
  // Laravel: <input type="hidden" name="_token" value="...">
  let m = html.match(/name="_token"[^>]*value="([^"]+)"/) ||
          html.match(/value="([^"]+)"[^>]*name="_token"/) ||
          html.match(/name="_token"\s+value='([^']+)'/);
  if (m) return m[1];
  // meta csrf-token
  m = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/);
  if (m) return m[1];
  // JS-embedded
  m = html.match(/["_']_token["_']\s*:\s*["']([^"']+)["']/);
  if (m) return m[1];
  return null;
}

function extractQr(html, pageUrl) {
  // 0) base64 data-uri QR image (umum untuk QRIS)
  const b64 = html.match(/data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]{2000,}/);
  if (b64) return { qrUrl: b64[0], kind: 'base64' };

  // 1) direct <img> whose src looks like a QR code
  const imgs = [...html.matchAll(/<img[^>]+src="([^"]+)"/gi)].map(m => m[1]);
  const qrImg = imgs.find(s => /qr/i.test(s) && !/logo|icon|sprite/i.test(s));
  if (qrImg) return { qrUrl: new URL(qrImg, pageUrl).href, kind: 'img' };

  // 2) raw QRIS EMV payload (starts with 00020101)
  const emv = html.match(/00020101[0-9A-Za-z.\- ]{60,400}/);
  if (emv) {
    const payload = emv[0].trim();
    return {
      qrUrl: 'https://api.qrserver.com/v1/create-qr-code/?size=500x500&margin=10&data=' + encodeURIComponent(payload),
      payload, kind: 'emv'
    };
  }

  // 3) JSON-ish qr fields
  const jm = html.match(/"(qr_code_url|qr_url|qris_image|qrImage)"\s*:\s*"([^"]+)"/);
  if (jm) return { qrUrl: jm[2].replace(/\\\//g, '/'), kind: 'json' };

  return null;
}

module.exports = async (req2, res2) => {
  // CORS: only allow our own origins
  const origin = req2.headers.origin || '';
  const allowed = ['', 'https://topup.neoparty.web.id', 'http://localhost:3000', 'http://localhost:5173'];
  const allowOrigin = allowed.includes(origin) ? origin : 'https://topup.neoparty.web.id';
  res2.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res2.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res2.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req2.method === 'OPTIONS') return res2.status(200).end();
  if (req2.method !== 'POST') return res2.status(405).json({ success: false, error: 'Method not allowed' });

  let body = req2.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const playerId = String((body && body.playerId) || '').trim();
  if (!playerId) return res2.status(400).json({ success: false, error: 'playerId wajib diisi' });
  if (!/^\d{3,20}$/.test(playerId)) return res2.status(400).json({ success: false, error: 'Format ID Player tidak valid' });

  const jar = new Jar();
  try {
    // 1) session + CSRF
    const g = await req(`${KINGSHOP_BASE}/topup`, jar);
    const html = await g.text();
    if (/Just a moment|cf-challenge|Attention Required/i.test(html) || g.status === 403) {
      return res2.status(502).json({
        success: false, error: 'Kingshop memblokir akses server (Cloudflare).',
        hint: 'Gunakan API key resmi kingshop bila tersedia, atau jalankan proxy ini dari IP yang lolos verifikasi.'
      });
    }
    const token = extractToken(html);
    if (!token) {
      return res2.status(502).json({ success: false, error: 'CSRF token kingshop tidak ditemukan. Struktur halaman mungkin berubah.' });
    }

    // 2) create order (same shape as browser form)
    const form = new URLSearchParams();
    form.append('_token', token);
    form.append('target_player', playerId);
    form.append('phone', '');
    form.append('productId', PRODUCT_ID);

    const p = await req(`${KINGSHOP_BASE}/topup`, jar, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': KINGSHOP_BASE,
        'Referer': `${KINGSHOP_BASE}/topup`,
      },
      body: form.toString(),
    });
    const ptext = await p.text();
    let order;
    try { order = JSON.parse(ptext); }
    catch { return res2.status(502).json({ success: false, error: 'Respon kingshop bukan JSON', detail: ptext.slice(0, 200) }); }

    if (!order || !order.success || !order.qris_url) {
      return res2.status(502).json({ success: false, error: (order && order.message) || 'Gagal membuat order di kingshop' });
    }

    // 3) fetch checkout page -> QR
    let qrUrl = null, payload = null;
    try {
      const q = await req(order.qris_url.replace(/\\\//g, '/'), jar, {
        headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      });
      const qhtml = await q.text();
      const found = extractQr(qhtml, order.qris_url);
      if (found) { qrUrl = found.qrUrl; payload = found.payload || null; }
    } catch { /* fall through to fallback */ }

    return res2.status(200).json({
      success: true,
      qrUrl,                 // may be null -> frontend falls back to qris_url page
      payload,
      amount: AMOUNT,
      transaction_id: order.transaction_id,
      qris_url: (order.qris_url || '').replace(/\\\//g, '/'),
      redirect_url: (order.redirect_url || '').replace(/\\\//g, '/'),
    });
  } catch (e) {
    return res2.status(500).json({ success: false, error: 'Proxy error: ' + (e.message || e) });
  }
};
