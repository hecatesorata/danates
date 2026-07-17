// Cloudflare Pages Function
// Route: POST /webhook/donasi
// Menerima webhook dari Trakteer / Sociabuzz dan menyimpan donasi ke Supabase.
//
// Env vars yang dibutuhkan (set di Cloudflare Pages > Settings > Environment variables):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   WEBHOOK_TOKEN   -> isi dengan token webhook (mis. sbwhook-9aj18gsxqtubed5vpliorcwh)
//                      JANGAN hardcode di kode, simpan hanya sebagai env var.

export async function onRequestPost(context) {
  const { request, env } = context;
  const WEBHOOK_TOKEN = env.WEBHOOK_TOKEN || '';
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

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

  const isValidToken =
    !WEBHOOK_TOKEN ||
    tokenHeader === WEBHOOK_TOKEN ||
    urlToken === WEBHOOK_TOKEN ||
    bodyToken === WEBHOOK_TOKEN;

  if (!isValidToken) {
    return jsonResponse({ error: 'Webhook token tidak valid' }, 403);
  }

  const amount = Number(payload.amount);
  if (!amount || amount <= 0) {
    return jsonResponse({ error: 'Nominal donasi tidak valid' }, 400);
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jsonResponse({ error: 'Supabase belum dikonfigurasi' }, 500);
  }

  const source = payload.source || (tokenHeader.toLowerCase().includes('trakteer') ? 'trakteer' : 'sociabuzz');

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

  return jsonResponse({ ok: true }, 200);
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
