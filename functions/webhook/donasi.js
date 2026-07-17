// Cloudflare Pages Function
// Route: POST /webhook/donasi
// Menerima webhook dari Trakteer / Sociabuzz / Saweria, simpan ke Supabase,
// dan kirim notifikasi ke Telegram kalau dikonfigurasi.
//
// Env vars yang dibutuhkan (set di Cloudflare Pages > Settings > Environment variables):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   WEBHOOK_TOKEN_TRAKTEER   (token dari X-Webhook-Token, lihat dashboard Trakteer > Integrasi > Webhook)
//   WEBHOOK_TOKEN_SOCIABUZZ
//   SAWERIA_STREAM_KEY       (BUKAN token biasa — ini "stream key" akun Saweria kamu,
//                             dipakai buat verifikasi HMAC signature, cara Saweria
//                             mengamankan webhook-nya beda dari Trakteer/Sociabuzz)
//   TELEGRAM_BOT_TOKEN       (opsional, isi kalau mau notifikasi Telegram)
//   TELEGRAM_CHAT_ID         (opsional, wajib diisi bareng TELEGRAM_BOT_TOKEN)

export async function onRequestPost(context) {
  const { request, env } = context;

  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return jsonResponse({ error: 'Payload tidak valid' }, 400);
  }

  // Saweria gak pakai token polos di header/URL/body kayak Trakteer & Sociabuzz.
  // Dia ngirim HMAC signature di header Saweria-Callback-Signature, jadi harus
  // dicek pakai jalur verifikasi yang beda sebelum lanjut ke pemrosesan donasi.
  const saweriaSignature = request.headers.get('saweria-callback-signature');
  if (saweriaSignature) {
    const streamKey = env.SAWERIA_STREAM_KEY;
    if (streamKey) {
      const valid = await verifySaweriaSignature(payload, saweriaSignature, streamKey);
      if (!valid) {
        return jsonResponse({ error: 'Signature Saweria tidak valid' }, 403);
      }
    }
    // Kalau SAWERIA_STREAM_KEY belum diisi, kita tetap proses (biar gak macet total),
    // tapi sebaiknya segera diisi supaya request palsu gak ikut ke-insert ke Supabase.
    return handleDonation(payload, 'saweria', env);
  }

  const validTokens = {
    trakteer: env.WEBHOOK_TOKEN_TRAKTEER || '',
    sociabuzz: env.WEBHOOK_TOKEN_SOCIABUZZ || '',
  };

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

  const source = payload.source || (matchedSource ? matchedSource[0] : detectSource(payload));
  return handleDonation(payload, source, env);
}

// Proses bareng buat semua sumber donasi setelah lolos verifikasi:
// ekstrak nominal, simpan ke Supabase, lalu kirim notifikasi Telegram.
async function handleDonation(payload, source, env) {
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

  const { amount, donor } = extractDonationData(payload, source);

  if (!amount || amount <= 0) {
    return jsonResponse({ error: 'Nominal donasi tidak valid' }, 400);
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jsonResponse({ error: 'Supabase belum dikonfigurasi' }, 500);
  }

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

// Verifikasi signature Saweria. Skema resminya: HMAC-SHA256 (hex) dengan
// stream key sebagai secret, atas gabungan string field-field berikut
// (tanpa separator, urutan harus persis begini):
//   version + id + amount_raw + donator_name + donator_email
async function verifySaweriaSignature(payload, receivedSignature, streamKey) {
  const dataString = ['version', 'id', 'amount_raw', 'donator_name', 'donator_email']
    .map((key) => (payload[key] !== undefined && payload[key] !== null ? String(payload[key]) : ''))
    .join('');

  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(streamKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(dataString));
  const computedHex = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return timingSafeEqualHex(computedHex, receivedSignature);
}

// Perbandingan constant-time biar gak bocor lewat timing attack.
function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// Kalau token belum dikonfigurasi (jadi kita gak bisa tahu source dari matchedSource),
// coba tebak dari bentuk payload-nya. Masing-masing platform punya field khas sendiri.
function detectSource(payload) {
  if (payload.amount_raw !== undefined || payload.donator_name !== undefined) return 'saweria';
  if (payload.supporter_name !== undefined && (payload.price !== undefined || payload.transaction_id !== undefined)) {
    return 'trakteer';
  }
  return 'unknown';
}

// Trakteer, Saweria, dan Sociabuzz masing-masing pakai nama field yang beda buat
// nominal & nama donatur. Fungsi ini nyamain jadi { amount, donor } yang konsisten.
function extractDonationData(payload, source) {
  let amount;
  let donor;

  switch (source) {
    case 'trakteer':
      // Payload asli: { price: 5000, net_amount: 4750, supporter_name: "...", quantity: 1, unit: "Kopi", ... }
      amount = Number(payload.price ?? payload.net_amount ?? payload.amount);
      donor = payload.supporter_name;
      break;
    case 'saweria':
      // Payload asli: { amount_raw: 69420, donator_name: "...", message: "...", ... }
      amount = Number(payload.amount_raw ?? payload.amount);
      donor = payload.donator_name;
      break;
    case 'sociabuzz':
      // Skema webhook Sociabuzz belum konsisten didokumentasikan di tempat kami cek;
      // ini best-effort, sesuaikan kalau ternyata beda pas ada donasi masuk beneran.
      amount = Number(payload.amount ?? payload.amount_raw ?? payload.price);
      donor = payload.supporter_name || payload.donator_name || payload.name;
      break;
    default:
      amount = Number(payload.amount ?? payload.amount_raw ?? payload.price ?? payload.net_amount);
      donor = payload.supporter_name || payload.donator_name || payload.donor || payload.name;
  }

  return { amount, donor: donor || 'Anonim' };
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
