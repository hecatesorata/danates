// Cloudflare Pages Function
// Route: POST /webhook/donasi
// Menerima webhook dari Trakteer / Sociabuzz / Saweria, simpan ke Supabase,
// dan kirim notifikasi ke Telegram kalau dikonfigurasi.
//
// PENTING: Trakteer/Saweria/Sociabuzz kirim nominal dalam RUPIAH. Kolom
// `amount` di tabel donations HARUS selalu dalam USD (progress bar di
// index.html langsung nampilin kolom ini sebagai USD tanpa konversi lagi).
// Makanya di sini nominal asli disimpan ke `amount_original` +
// `currency_original`, dan `amount` adalah hasil konversi ke USD.
//
// Env vars yang dibutuhkan (set di Cloudflare Pages > Settings > Environment variables):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   EXCHANGE_RATE              (kurs IDR per 1 USD, misal 16300. Update berkala,
//                               cek kurs terbaru — jangan dibiarkan basi kelamaan)
//   WEBHOOK_TOKEN_TRAKTEER     (token dari dashboard Trakteer > Integrasi > Webhook,
//                               dikirim Trakteer lewat header X-Webhook-Token)
//   WEBHOOK_TOKEN_SOCIABUZZ    (token "sbwhook-..." dari dashboard Sociabuzz)
//   WEBHOOK_TOKEN_SAWERIA      (token "swhook-..." buatan sendiri, diselipkan di URL
//                               webhook yang didaftarkan ke Saweria: ?token=...)
//   SAWERIA_STREAM_KEY         (opsional, cuma dipakai kalau akun Saweria kamu kirim
//                               header Saweria-Callback-Signature)
//   TELEGRAM_BOT_TOKEN         (opsional, isi kalau mau notifikasi Telegram)
//   TELEGRAM_CHAT_ID           (opsional, wajib diisi bareng TELEGRAM_BOT_TOKEN)

const DEFAULT_EXCHANGE_RATE = 16300; // IDR per 1 USD — fallback kalau env belum diisi

export async function onRequestPost(context) {
  const { request, env } = context;

  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    return jsonResponse({ error: 'Payload tidak valid' }, 400);
  }

  // Sebagian akun Saweria ngirim HMAC signature di header ini, bukan token biasa.
  // Kalau header ini ada, pakai jalur verifikasi HMAC. Kalau enggak ada, Saweria
  // diperlakukan sama kayak Trakteer/Sociabuzz: token biasa lewat header/URL/body.
  const saweriaSignature = request.headers.get('saweria-callback-signature');
  if (saweriaSignature) {
    const streamKey = env.SAWERIA_STREAM_KEY;
    if (streamKey) {
      const valid = await verifySaweriaSignature(payload, saweriaSignature, streamKey);
      if (!valid) {
        return jsonResponse({ error: 'Signature Saweria tidak valid' }, 403);
      }
    }
    return handleDonation(payload, 'saweria', env);
  }

  const validTokens = {
    trakteer: env.WEBHOOK_TOKEN_TRAKTEER || '',
    sociabuzz: env.WEBHOOK_TOKEN_SOCIABUZZ || '',
    saweria: env.WEBHOOK_TOKEN_SAWERIA || '',
  };

  const tokenHeader =
    request.headers.get('x-webhook-token') ||
    request.headers.get('x-sociabuzz-webhook-token') ||
    request.headers.get('x-trakteer-webhook-token') ||
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
// ekstrak data, convert ke USD, simpan ke Supabase, lalu kirim notifikasi Telegram.
async function handleDonation(payload, source, env) {
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  const EXCHANGE_RATE = Number(env.EXCHANGE_RATE) || DEFAULT_EXCHANGE_RATE;

  const { amount, donor, message, transactionId } = extractDonationData(payload, source);

  if (!amount || amount <= 0) {
    return jsonResponse({ error: 'Nominal donasi tidak valid' }, 400);
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jsonResponse({ error: 'Supabase belum dikonfigurasi' }, 500);
  }

  const amountUSD = Number((amount / EXCHANGE_RATE).toFixed(2));
  const txId = transactionId || `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/donations`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation,resolution=ignore-duplicates',
    },
    body: JSON.stringify({
      amount: amountUSD,
      amount_original: amount,
      currency_original: 'IDR',
      source,
      donor,
      message,
      transaction_id: txId,
      raw_payload: payload,
    }),
  });

  if (!insertRes.ok) {
    const detail = await insertRes.text();
    return jsonResponse({ error: 'Gagal menyimpan ke database', detail }, 500);
  }

  const inserted = await insertRes.json().catch(() => []);
  const isNew = Array.isArray(inserted) && inserted.length > 0;

  if (!isNew) {
    // Duplikat (transaction_id sudah pernah masuk) — jangan kirim notif ulang.
    return jsonResponse({ ok: true, source, duplicate: true }, 200);
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
    `Nominal: *${escapeMarkdownV2(formatRupiah(amount))}* \\(≈ $${escapeMarkdownV2(amountUSD.toFixed(2))}\\)`,
    `Donatur: *${escapeMarkdownV2(donor)}*`,
    `Sumber: *${escapeMarkdownV2(source)}*`,
  ];
  if (message) {
    messageLines.push(`Pesan: _${escapeMarkdownV2(message)}_`);
  }
  if (totalCollected !== null) {
    messageLines.push(`Total terkumpul: *$${escapeMarkdownV2(totalCollected.toFixed(2))}*`);
  }

  const telegramResult = await sendTelegramMessage(env, messageLines.join('\n'));

  return jsonResponse(
    { ok: true, source, amount_usd: amountUSD, telegram: telegramResult.sent ? 'sent' : 'skipped' },
    200
  );
}

// Verifikasi signature Saweria. Skema: HMAC-SHA256 (hex) dengan stream key
// sebagai secret, atas gabungan string field-field berikut (tanpa separator,
// urutan harus persis begini): version + id + amount_raw + donator_name + donator_email
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
// nominal, nama donatur, dan pesan. Fungsi ini nyamain jadi bentuk konsisten.
// Nominal yang dikembalikan di sini MASIH dalam Rupiah (belum dikonversi).
// Referensi field Trakteer (dicek dari help.trakteer.id/help-center/articles/70):
//   { transaction_id, type, supporter_name, supporter_message, unit, quantity, price, net_amount }
// Referensi field Saweria: { version, id, amount_raw, cut, donator_name, donator_email, message }
function extractDonationData(payload, source) {
  let amount;
  let donor;
  let message;
  let transactionId;

  switch (source) {
    case 'trakteer':
      amount = Number(payload.price ?? payload.net_amount ?? payload.amount);
      donor = payload.supporter_name;
      message = payload.supporter_message;
      transactionId = payload.transaction_id ? `trakteer-${payload.transaction_id}` : undefined;
      break;
    case 'saweria':
      amount = Number(payload.amount_raw ?? payload.amount);
      donor = payload.donator_name;
      message = payload.message;
      transactionId = payload.id ? `saweria-${payload.id}` : undefined;
      break;
    case 'sociabuzz':
      // Skema webhook Sociabuzz belum konsisten didokumentasikan di tempat kami cek;
      // ini best-effort, sesuaikan kalau ternyata beda pas ada donasi masuk beneran.
      amount = Number(payload.amount ?? payload.amount_raw ?? payload.price);
      donor = payload.supporter_name || payload.donator_name || payload.name;
      message = payload.message || payload.supporter_message;
      transactionId = payload.transaction_id || payload.id ? `sociabuzz-${payload.transaction_id || payload.id}` : undefined;
      break;
    default:
      amount = Number(payload.amount ?? payload.amount_raw ?? payload.price ?? payload.net_amount);
      donor = payload.supporter_name || payload.donator_name || payload.donor || payload.name;
      message = payload.message || payload.supporter_message || payload.msg;
      transactionId = payload.transaction_id || payload.id
        ? `${source}-${payload.transaction_id || payload.id}`
        : undefined;
  }

  return { amount, donor: donor || 'Anonim', message: message || '', transactionId };
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
