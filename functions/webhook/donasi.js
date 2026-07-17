// Cloudflare Pages Function
// Route: POST /webhook/donasi
// Menerima webhook dari Trakteer / Sociabuzz / Saweria, simpan ke Supabase,
// dan kirim notifikasi ke Telegram kalau dikonfigurasi.
//
// Env vars yang dibutuhkan (set di Cloudflare Pages > Settings > Environment variables):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   WEBHOOK_TOKEN_TRAKTEER
//   WEBHOOK_TOKEN_SOCIABUZZ
//   WEBHOOK_TOKEN_SAWERIA
//   TELEGRAM_BOT_TOKEN   (opsional, isi kalau mau notifikasi Telegram)
//   TELEGRAM_CHAT_ID     (opsional, wajib diisi bareng TELEGRAM_BOT_TOKEN)

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

  const tokenHeader =
    request.headers.get('x-sociabuzz-webhook-token') ||
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

  const amount = Number(payload.amount);
  if (!amount || amount <= 0) {
    return jsonResponse({ error: 'Nominal donasi tidak valid' }, 400);
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jsonResponse({ error: 'Supabase belum dikonfigurasi' }, 500);
  }

  const source = payload.source || (matchedSource ? matchedSource[0] : 'unknown');

  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/donations`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ amount, source, raw_payload: payload }),
  });

  if (!insertRes.ok) {
    const detail = await insertRes.text();
    return jsonResponse({ error: 'Gagal menyimpan ke database', detail }, 500);
  }

  // Hitung total terkumpul terbaru buat dimasukkan ke notifikasi.
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
    // Kalau gagal hitung total, tetap lanjut kirim notif tanpa angka total.
  }

  const donor = payload.donor || payload.name || 'Anonim';
  const messageLines = [
    '*Donasi baru masuk\\!*',
    `Nominal: *${escapeMarkdownV2(formatRupiah(amount))}*`,
    `Donatur: *${escapeMarkdownV2(donor)}*`,
    `Sumber: *${escapeMarkdownV2(source)}*`,
  ];
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
