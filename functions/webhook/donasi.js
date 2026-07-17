// Cloudflare Pages Function
// Route: POST /webhook/donasi

export async function onRequestPost(context) {
  const { request, env } = context;
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  const validTokens = {
    trakteer: env.WEBHOOK_TOKEN_TRAKTEER || '',
    sociabuzz: env.WEBHOOK_TOKEN_SOCIABUZZ || '',
    saweria: env.WEBHOOK_TOKEN_SAWERIA || '',
  };

  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return jsonResponse({ error: 'Payload tidak valid' }, 400);
  }

  // 1. Identifikasi token dari berbagai kemungkinan header
  const tokenHeader =
    request.headers.get('x-sociabuzz-webhook-token') ||
    request.headers.get('x-trakteer-token') || // Perbaikan header trakteer (case-insensitive di fetch)
    request.headers.get('x-trakteer-webhook-token') ||
    request.headers.get('x-webhook-token') ||
    request.headers.get('authorization') ||
    request.headers.get('x-api-key') ||
    '';

  const url = new URL(request.url);
  const urlToken = url.searchParams.get('token') || '';
  const bodyToken = payload.webhook_token || payload.token || payload.api_key || '';

  const incomingTokens = [tokenHeader, urlToken, bodyToken].filter(Boolean);

  const matchedSource = Object.entries(validTokens).find(
    ([, expected]) => expected && incomingTokens.includes(expected)
  );

  const noTokensConfigured = Object.values(validTokens).every((t) => !t);

  if (!matchedSource && !noTokensConfigured) {
    return jsonResponse({ error: 'Webhook token tidak valid' }, 403);
  }

  const source = payload.source || (matchedSource ? matchedSource[0] : 'unknown');

  // 2. Normalisasi Data Berdasarkan Source
  let amount = 0;
  let donor = 'Anonim';
  let message = '';

  if (source === 'saweria') {
    amount = Number(payload.amount) || 0;
    donor = payload.donor || 'Anonim';
    message = payload.message || '';
  } else if (source === 'trakteer') {
    // Trakteer mengirimkan nominal kotor di 'price_gross' atau kalkulasi 'quantity' * 'price'
    amount = Number(payload.price_gross) || Number(payload.amount) || 0;
    donor = payload.supporter_name || 'Anonim';
    message = payload.support_message || '';
  } else if (source === 'sociabuzz') {
    amount = Number(payload.nominal) || Number(payload.amount) || 0;
    donor = payload.name || 'Anonim';
    message = payload.message || '';
  } else {
    // Fallback jika tidak teridentifikasi
    amount = Number(payload.amount) || 0;
    donor = payload.donor || payload.name || 'Anonim';
    message = payload.message || '';
  }

  if (!amount || amount <= 0) {
    return jsonResponse({ error: 'Nominal donasi tidak valid' }, 400);
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jsonResponse({ error: 'Supabase belum dikonfigurasi' }, 500);
  }

  // 3. Simpan ke Supabase
  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/donations`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ 
      amount, 
      source, 
      donor,
      message,
      raw_payload: payload 
    }),
  });

  if (!insertRes.ok) {
    const detail = await insertRes.text();
    return jsonResponse({ error: 'Gagal menyimpan ke database', detail }, 500);
  }

  // 4. Hitung total akumulasi (Opsional)
  let totalCollected = null;
  try {
    const totalRes = await fetch(`${SUPABASE_URL}/rest/v1/donations?select=amount`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (totalRes.ok) {
      const rows = await totalRes.json();
      totalCollected = rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    }
  } catch (err) {
    // Abaikan jika gagal mengambil total akumulasi
  }

  // 5. Kirim Notifikasi Telegram
  const messageLines = [
    '*Donasi baru masuk\\!*',
    `Nominal: *${escapeMarkdownV2(formatRupiah(amount))}*`,
    `Donatur: *${escapeMarkdownV2(donor)}*`,
    `Sumber: *${escapeMarkdownV2(source)}*`,
  ];
  
  if (message) {
    messageLines.push(`Pesan: _"${escapeMarkdownV2(message)}"_`);
  }

  if (totalCollected !== null) {
    messageLines.push(`Total terkumpul: *${escapeMarkdownV2(formatRupiah(totalCollected))}*`);
  }

  const telegramResult = await sendTelegramMessage(env, messageLines.join('\n'));

  return jsonResponse(
    { ok: true, source, telegram: telegramResult.sent ? 'sent' : 'skipped' },
    200
  );
}

function formatRupiah(number) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(number);
}

function escapeMarkdownV2(text) {
  return String(text || '').replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

async function sendTelegramMessage(env, text) {
  const TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID;

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { sent: false, reason: 'not configured' };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'MarkdownV2',
      }),
    });
    return { sent: res.ok };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
