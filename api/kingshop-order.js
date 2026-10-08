/**
 * Vercel Serverless Function: Kingshop order proxy (forwarder).
 *
 * Frontend (bundle) tetap POST ke /api/kingshop-order { playerId }.
 * Function ini:
 *   1. submit async ke proxy  -> POST /api/order        => { order_id }
 *   2. polling status          -> GET  /api/order/:id    sampai terminal
 *   3. kembalikan bentuk response yang sama seperti sebelumnya
 *      { success, qrUrl, payload, amount, transaction_id, qris_url, ... }
 *      agar frontend tidak perlu diubah.
 *
 * Async + polling dipakai supaya tidak tergantung pada satu request sync
 * yang panjang (batas eksekusi Vercel ±60 detik).
 *
 * Env (Vercel -> Settings -> Environment Variables):
 *   KINGSHOP_PROXY_URL   mis. http://104.245.34.139:8787 (tanpa trailing slash)
 *   KINGSHOP_PROXY_KEY   sama dengan API_KEY di /opt/kingshop-proxy/.env
 */

const PROXY_TIMEOUT_MS = 10000;   // per-request ke proxy
const POLL_INTERVAL_MS = 2500;    // jeda antar polling
const POLL_BUDGET_MS = 50000;     // total budget polling (di bawah batas Vercel)

const ALLOWED_ORIGINS = [
  'https://topup.neoparty.web.id',
  'http://localhost:3000',
  'http://localhost:5173',
];

function cors(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin',
    ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function proxyFetch(proxyUrl, proxyKey, path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
  try {
    const r = await fetch(`${proxyUrl}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': proxyKey,
        ...(opts.headers || {}),
      },
      signal: ctrl.signal,
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const PROXY_URL = (process.env.KINGSHOP_PROXY_URL || '').replace(/\/$/, '');
  const PROXY_KEY = process.env.KINGSHOP_PROXY_KEY || '';
  if (!PROXY_URL || !PROXY_KEY) {
    return res.status(500).json({
      success: false,
      error: 'Proxy belum dikonfigurasi (KINGSHOP_PROXY_URL / KINGSHOP_PROXY_KEY).',
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const playerId = String((body && body.playerId) || '').trim();
  if (!/^\d{3,20}$/.test(playerId)) {
    return res.status(400).json({ success: false, error: 'Format ID Player tidak valid.' });
  }

  try {
    // 1) submit async
    const sub = await proxyFetch(PROXY_URL, PROXY_KEY, '/api/order', {
      method: 'POST',
      body: JSON.stringify({ playerId }),
    });
    const orderId = sub.data && sub.data.order_id;
    if (!orderId) {
      return res.status(502).json({
        success: false,
        error: (sub.data && sub.data.error) || 'Gagal membuat order di proxy.',
      });
    }

    // 2) polling sampai terminal / budget habis
    const deadline = Date.now() + POLL_BUDGET_MS;
    let order = null;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const g = await proxyFetch(PROXY_URL, PROXY_KEY,
        `/api/order/${encodeURIComponent(orderId)}`);
      order = g.data && g.data.order;
      if (order && ['SUCCESS', 'FAILED', 'MANUAL_VERIFICATION_REQUIRED',
                    'BROWSER_ERROR', 'SUPPLIER_ERROR'].includes(order.status)) {
        break;
      }
      order = order || { status: 'PROCESSING' };
    }

    // 3) petakan ke bentuk response frontend
    if (order && order.status === 'SUCCESS' && order.result) {
      const r = order.result;
      return res.status(200).json({
        success: true,
        qrUrl: r.qrUrl || null,
        payload: r.payload || null,
        amount: r.amount || 20000,
        transaction_id: r.transaction_id || null,
        qris_url: r.qris_url || null,
        redirect_url: r.redirect_url || '',
        order_id: orderId,
      });
    }
    if (order && order.status === 'MANUAL_VERIFICATION_REQUIRED') {
      return res.status(502).json({
        success: false,
        order_id: orderId,
        error: 'Supplier butuh verifikasi manual. Coba lagi beberapa saat.',
      });
    }
    if (order && ['FAILED', 'BROWSER_ERROR', 'SUPPLIER_ERROR'].includes(order.status)) {
      return res.status(502).json({
        success: false,
        order_id: orderId,
        error: order.error || 'Gagal membuat order.',
      });
    }
    // masih PROCESSING saat budget habis — order tetap jalan di proxy
    return res.status(202).json({
      success: false,
      pending: true,
      order_id: orderId,
      error: 'Order masih diproses. Tunggu sebentar lalu coba lagi.',
    });
  } catch (e) {
    return res.status(502).json({
      success: false,
      error: 'Tidak bisa menghubungi proxy kingshop. Pastikan service proxy jalan.',
    });
  }
};
