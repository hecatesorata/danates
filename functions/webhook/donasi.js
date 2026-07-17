// Cloudflare Pages Function
// Route: POST /webhook/donasi
// Menerima webhook dari Trakteer / Sociabuzz / Saweria dan menyimpan donasi ke Supabase.
//
// Env vars yang dibutuhkan (set di Cloudflare Pages > Settings > Environment variables):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   WEBHOOK_TOKEN_TRAKTEER   -> token dari dashboard Trakteer
//   WEBHOOK_TOKEN_SOCIABUZZ  -> token dari dashboard Sociabuzz
//   WEBHOOK_TOKEN_SAWERIA    -> token buatan sendiri (Saweria tidak menerbitkan token,
//                               jadi ini hanya perlu cocok dengan ?token= di URL webhook
//                               yang kamu daftarkan di Saweria)

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

  // Cari platform mana yang tokennya cocok dengan salah satu token yang masuk.
  const matchedSource = Object.entries(validTokens).find(
    ([, expected]) => expected && incomingTokens.includes(expected)
  );

  // Kalau belum ada satupun token platform yang dikonfigurasi, terima semua (mode longgar).
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

  return jsonResponse({ ok: true, source }, 200);
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
